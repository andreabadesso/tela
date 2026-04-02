import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import { resolve, relative, join, extname, dirname } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { VectorStoreService } from '../../agent/vector-store.js';
import type { KnowledgeAdapter, KnowledgeDocument, AdapterStatus, SyncResult } from '../types.js';

const execFileAsync = promisify(execFileCb);

const TEXT_EXTENSIONS = ['.md', '.txt', '.markdown', '.mdx'];

export class FilesystemAdapter implements KnowledgeAdapter {
  readonly id: string;
  readonly type = 'filesystem';

  private basePath: string;
  private vectorStore: VectorStoreService | null;
  private lastSync: Date | null = null;
  private docCount = 0;
  private error: string | undefined;

  constructor(id: string, basePath: string, vectorStore?: VectorStoreService) {
    this.id = id;
    this.basePath = resolve(basePath);
    this.vectorStore = vectorStore ?? null;
  }

  private safePath(relativePath: string): string {
    const resolved = resolve(this.basePath, relativePath);
    if (!resolved.startsWith(this.basePath + '/') && resolved !== this.basePath) {
      throw new Error(`Path traversal rejected: ${relativePath}`);
    }
    return resolved;
  }

  private async walkDir(dir: string, recursive: boolean): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && recursive) {
        results.push(...(await this.walkDir(fullPath, recursive)));
      } else if (entry.isFile() && TEXT_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
    return results;
  }

  async search(query: string, opts?: { maxResults?: number }): Promise<KnowledgeDocument[]> {
    const maxResults = opts?.maxResults ?? 20;
    try {
      return await this.searchWithRipgrep(query, maxResults);
    } catch {
      return await this.searchWithFs(query, maxResults);
    }
  }

  private async searchWithRipgrep(query: string, maxResults: number): Promise<KnowledgeDocument[]> {
    const args = [
      '--json',
      '--max-count', String(maxResults),
      '-C', '2',
      '-t', 'md',
      '-t', 'txt',
      query,
      this.basePath,
    ];
    const { stdout } = await execFileAsync('rg', args, { maxBuffer: 10 * 1024 * 1024 });
    const docs: KnowledgeDocument[] = [];
    const lines = stdout.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      if (docs.length >= maxResults) break;
      const parsed = JSON.parse(line) as {
        type: string;
        data: {
          path?: { text: string };
          line_number?: number;
          lines?: { text: string };
        };
      };
      if (parsed.type === 'match' && parsed.data.path) {
        const absPath = parsed.data.path.text;
        const relPath = relative(this.basePath, absPath);
        let lastModified = new Date();
        try {
          const s = await stat(absPath);
          lastModified = s.mtime;
        } catch { /* use default */ }
        docs.push({
          path: relPath,
          content: parsed.data.lines?.text.trimEnd() ?? '',
          metadata: { source: this.id, lastModified },
        });
      }
    }
    return docs;
  }

  private async searchWithFs(query: string, maxResults: number): Promise<KnowledgeDocument[]> {
    const files = await this.walkDir(this.basePath, true);
    const docs: KnowledgeDocument[] = [];
    const lowerQuery = query.toLowerCase();

    for (const filePath of files) {
      if (docs.length >= maxResults) break;
      const content = await readFile(filePath, 'utf-8');
      if (content.toLowerCase().includes(lowerQuery)) {
        const relPath = relative(this.basePath, filePath);
        const s = await stat(filePath);
        docs.push({
          path: relPath,
          content: content.slice(0, 500),
          metadata: { source: this.id, lastModified: s.mtime },
        });
      }
    }
    return docs;
  }

  async read(path: string): Promise<KnowledgeDocument> {
    const absPath = this.safePath(path);
    const content = await readFile(absPath, 'utf-8');
    const s = await stat(absPath);
    return {
      path,
      content,
      metadata: { source: this.id, lastModified: s.mtime },
    };
  }

  async list(directory?: string, opts?: { recursive?: boolean }): Promise<string[]> {
    const targetDir = directory ? this.safePath(directory) : this.basePath;
    const recursive = opts?.recursive ?? true;
    const files = await this.walkDir(targetDir, recursive);
    return files.map((f) => relative(this.basePath, f)).sort();
  }

  async write(path: string, content: string): Promise<void> {
    const absPath = this.safePath(path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, 'utf-8');
  }

  async append(path: string, content: string): Promise<void> {
    const absPath = this.safePath(path);
    let existing = '';
    try {
      existing = await readFile(absPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await mkdir(dirname(absPath), { recursive: true });
    }
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await writeFile(absPath, existing + separator + content, 'utf-8');
  }

  async sync(): Promise<SyncResult> {
    if (!this.vectorStore) {
      throw new Error('Vector store not configured for sync');
    }
    try {
      const indexed = await this.vectorStore.indexAll();
      const allFiles = await this.walkDir(this.basePath, true);
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
}
