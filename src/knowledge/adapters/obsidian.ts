import { readFile, stat, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, relative, dirname, extname, join, normalize } from 'node:path';
import { createVaultTools } from '../../tools/vault.js';
import { VectorStoreService } from '../../services/vector-store.js';
import { parseNote, extractTags, extractWikilinks, chunkMarkdown } from '../chunker.js';
import type { KnowledgeAdapter, KnowledgeDocument, AdapterStatus, SyncResult } from '../types.js';

export interface ObsidianAdapterConfig {
  vaultPath: string;
  rootScope?: string;        // e.g., "/Engineering" — only sees this subtree
  allowedPaths?: string[];   // explicit allowlist (if set, only these paths)
  deniedPaths?: string[];    // explicit denylist (checked first)
  gitRemoteUrl?: string;
  readOnly?: boolean;
}

export class ObsidianAdapter implements KnowledgeAdapter {
  readonly id: string;
  readonly type = 'obsidian';

  private vaultPath: string;
  private config: ObsidianAdapterConfig;
  private vault: ReturnType<typeof createVaultTools>;
  private vectorStore: VectorStoreService | null;
  private lastSync: Date | null = null;
  private docCount = 0;
  private error: string | undefined;

  constructor(id: string, adapterConfig: ObsidianAdapterConfig, vectorStore?: VectorStoreService) {
    this.id = id;
    this.config = adapterConfig;
    this.vaultPath = resolve(adapterConfig.vaultPath);
    this.vault = createVaultTools(this.vaultPath);
    this.vectorStore = vectorStore ?? null;

    // Count files in background on init
    this.list(undefined, { recursive: true })
      .then((files) => { this.docCount = files.length; })
      .catch(() => {});
  }

  // ─── Path Scoping ──────────────────────────────────────────────

  /**
   * Check if a relative path is allowed by the scope configuration.
   * Denied paths take priority, then allowedPaths, then rootScope.
   */
  isPathAllowed(relativePath: string): boolean {
    const normalized = normalize(relativePath).replace(/\\/g, '/');

    // Check denied paths first (highest priority)
    if (this.config.deniedPaths) {
      for (const denied of this.config.deniedPaths) {
        const deniedNorm = denied.replace(/^\//, '');
        if (normalized === deniedNorm || normalized.startsWith(deniedNorm + '/')) {
          return false;
        }
      }
    }

    // Check allowed paths (if set, only these paths are accessible)
    if (this.config.allowedPaths && this.config.allowedPaths.length > 0) {
      return this.config.allowedPaths.some((allowed) => {
        const allowedNorm = allowed.replace(/^\//, '');
        return normalized === allowedNorm || normalized.startsWith(allowedNorm + '/');
      });
    }

    // Check root scope
    if (this.config.rootScope) {
      const scopeNorm = this.config.rootScope.replace(/^\//, '');
      return normalized === scopeNorm || normalized.startsWith(scopeNorm + '/');
    }

    // No restrictions
    return true;
  }

  /**
   * Assert that a path is allowed, throwing an error if not.
   */
  private assertPathAllowed(path: string): void {
    if (!this.isPathAllowed(path)) {
      throw new Error(`Access denied: path "${path}" is outside the allowed scope`);
    }
  }

  /**
   * Get the effective root directory for listing/searching.
   * Returns relative path from vault root.
   */
  private getEffectiveRoot(): string | undefined {
    if (this.config.rootScope) {
      return this.config.rootScope.replace(/^\//, '');
    }
    return undefined;
  }

  // ─── KnowledgeAdapter Interface ────────────────────────────────

  async search(query: string, opts?: { maxResults?: number }): Promise<KnowledgeDocument[]> {
    const maxResults = opts?.maxResults ?? 20;
    const effectiveRoot = this.getEffectiveRoot();

    const results = await this.vault.search_vault(query, {
      path: effectiveRoot,
      maxResults: maxResults * 2, // over-fetch to account for filtering
    });

    const docs: KnowledgeDocument[] = [];
    for (const r of results) {
      if (!this.isPathAllowed(r.file)) continue;
      if (docs.length >= maxResults) break;

      const absPath = resolve(this.vaultPath, r.file);
      let lastModified = new Date();
      try {
        const s = await stat(absPath);
        lastModified = s.mtime;
      } catch { /* use default */ }

      // Parse note for tags
      const content = r.context?.join('\n') ?? r.content;
      const { tags } = parseNote(content);

      docs.push({
        path: r.file,
        content,
        metadata: {
          source: this.id,
          lastModified,
          tags,
        },
      });
    }
    return docs;
  }

  async read(path: string): Promise<KnowledgeDocument> {
    this.assertPathAllowed(path);

    const content = await this.vault.read_note(path);
    const absPath = resolve(this.vaultPath, path);
    let lastModified = new Date();
    try {
      const s = await stat(absPath);
      lastModified = s.mtime;
    } catch { /* use default */ }

    const { tags } = parseNote(content);

    return {
      path,
      content,
      metadata: {
        source: this.id,
        lastModified,
        tags,
      },
    };
  }

  async list(directory?: string, opts?: { recursive?: boolean }): Promise<string[]> {
    const effectiveDir = directory ?? this.getEffectiveRoot();
    const allFiles = await this.vault.list_notes(effectiveDir, { recursive: opts?.recursive ?? true });
    return allFiles.filter((f) => this.isPathAllowed(f));
  }

  async write(path: string, content: string): Promise<void> {
    if (this.config.readOnly) {
      throw new Error('Knowledge source is read-only');
    }
    this.assertPathAllowed(path);
    await this.vault.write_note(path, content);
  }

  async append(path: string, content: string): Promise<void> {
    if (this.config.readOnly) {
      throw new Error('Knowledge source is read-only');
    }
    this.assertPathAllowed(path);
    await this.vault.append_to_note(path, content);
  }

  async sync(): Promise<SyncResult> {
    if (!this.vectorStore) {
      throw new Error('Vector store not configured for sync');
    }
    try {
      const indexed = await this.vectorStore.indexAll();
      const allFiles = await this.list(undefined, { recursive: true });
      this.docCount = allFiles.length;
      this.lastSync = new Date();
      this.error = undefined;
      return { added: indexed, updated: 0, deleted: 0 };
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  getStatus(): AdapterStatus {
    return {
      connected: true,
      lastSync: this.lastSync,
      docCount: this.docCount,
      error: this.error,
    };
  }

  // ─── Vault Inspection (for API routes) ─────────────────────────

  /**
   * Scan the vault and return folder tree with file counts.
   * Used by the wizard scan endpoint.
   */
  async scanFolders(basePath?: string): Promise<FolderNode[]> {
    const scope = basePath || this.config.rootScope;
    const root = scope
      ? resolve(this.vaultPath, scope)
      : this.vaultPath;

    return this.buildFolderTree(root, this.vaultPath);
  }

  /**
   * Get all tags across the vault (or scoped to allowed paths) with counts.
   */
  async getAllTags(): Promise<Record<string, number>> {
    const files = await this.list(undefined, { recursive: true });
    const tagCounts: Record<string, number> = {};

    for (const file of files) {
      try {
        const absPath = resolve(this.vaultPath, file);
        const content = await readFile(absPath, 'utf-8');
        const { tags } = parseNote(content);
        for (const tag of tags) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      } catch { /* skip unreadable files */ }
    }

    return tagCounts;
  }

  /**
   * List files with optional folder/tag filtering and pagination.
   */
  async listFiles(opts?: {
    folder?: string;
    tag?: string;
    offset?: number;
    limit?: number;
  }): Promise<{ files: FileInfo[]; total: number }> {
    let files = await this.list(opts?.folder, { recursive: true });

    // Filter by tag if requested
    if (opts?.tag) {
      const filtered: string[] = [];
      for (const file of files) {
        try {
          const absPath = resolve(this.vaultPath, file);
          const content = await readFile(absPath, 'utf-8');
          const { tags } = parseNote(content);
          if (tags.includes(opts.tag)) {
            filtered.push(file);
          }
        } catch { /* skip */ }
      }
      files = filtered;
    }

    const total = files.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    const paged = files.slice(offset, offset + limit);

    const fileInfos: FileInfo[] = [];
    for (const file of paged) {
      try {
        const absPath = resolve(this.vaultPath, file);
        const s = await stat(absPath);
        fileInfos.push({
          path: file,
          lastModified: s.mtime.toISOString(),
          size: s.size,
        });
      } catch {
        fileInfos.push({
          path: file,
          lastModified: new Date().toISOString(),
          size: 0,
        });
      }
    }

    return { files: fileInfos, total };
  }

  /**
   * Read a specific file's content (for the file preview endpoint).
   */
  async readFileContent(path: string): Promise<string> {
    this.assertPathAllowed(path);
    return this.vault.read_note(path);
  }

  /** Get the configured vault path */
  getVaultPath(): string {
    return this.vaultPath;
  }

  /** Get the adapter config */
  getConfig(): ObsidianAdapterConfig {
    return this.config;
  }

  // ─── Internal Helpers ──────────────────────────────────────────

  private async buildFolderTree(dir: string, vaultRoot: string): Promise<FolderNode[]> {
    const nodes: FolderNode[] = [];

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return nodes;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        const fullPath = join(dir, entry.name);
        const relPath = relative(vaultRoot, fullPath);

        // Count .md files in this directory (non-recursive)
        let fileCount = 0;
        try {
          const dirEntries = await readdir(fullPath, { withFileTypes: true });
          fileCount = dirEntries.filter(
            (e) => e.isFile() && extname(e.name).toLowerCase() === '.md'
          ).length;
        } catch { /* skip */ }

        const children = await this.buildFolderTree(fullPath, vaultRoot);

        nodes.push({
          path: relPath,
          name: entry.name,
          fileCount,
          children,
        });
      }
    }

    return nodes;
  }
}

// ─── Supporting Types ──────────────────────────────────────────

export interface FolderNode {
  path: string;
  name: string;
  fileCount: number;
  children: FolderNode[];
}

export interface FileInfo {
  path: string;
  lastModified: string;
  size: number;
}

/**
 * Static helper: scan a vault path and return summary without creating a full adapter.
 * Used by the scan endpoint when no knowledge source exists yet.
 */
export async function scanVaultPath(vaultPath: string): Promise<{
  totalFiles: number;
  totalFolders: number;
  folders: FolderNode[];
}> {
  const adapter = new ObsidianAdapter('_scan', { vaultPath });
  const folders = await adapter.scanFolders();

  function countTotals(nodes: FolderNode[]): { files: number; folders: number } {
    let files = 0;
    let folderCount = 0;
    for (const node of nodes) {
      folderCount++;
      files += node.fileCount;
      const sub = countTotals(node.children);
      files += sub.files;
      folderCount += sub.folders;
    }
    return { files, folders: folderCount };
  }

  // Also count root-level .md files
  let rootFileCount = 0;
  try {
    const rootEntries = await readdir(resolve(vaultPath), { withFileTypes: true });
    rootFileCount = rootEntries.filter(
      (e) => e.isFile() && extname(e.name).toLowerCase() === '.md'
    ).length;
  } catch { /* skip */ }

  const totals = countTotals(folders);

  return {
    totalFiles: totals.files + rootFileCount,
    totalFolders: totals.folders,
    folders,
  };
}
