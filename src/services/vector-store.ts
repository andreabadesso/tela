import { ChromaClient, Collection } from 'chromadb';
import { DefaultEmbeddingFunction } from '@chroma-core/default-embed';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { config } from '../config/env.js';
import { chunkMarkdown } from '../knowledge/chunker.js';

const DEFAULT_COLLECTION_NAME = 'vault-notes';

interface VectorSearchResult {
  file: string;
  score: number;
  content: string;
  metadata: Record<string, unknown>;
}

export class VectorStoreService {
  private client: ChromaClient;
  private collection: Collection | null = null;
  private vaultPath: string;
  private collectionName: string;

  constructor(vaultPath: string, collectionName: string = DEFAULT_COLLECTION_NAME) {
    this.client = new ChromaClient({ path: config.chromaUrl });
    this.vaultPath = vaultPath;
    this.collectionName = collectionName;
  }

  async initialize(): Promise<void> {
    try {
      const embedder = new DefaultEmbeddingFunction();
      this.collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
        metadata: { 'hnsw:space': 'cosine' },
        embeddingFunction: embedder,
      });
      console.log(`[vector-store] Connected to ChromaDB (collection: ${this.collectionName})`);
    } catch (err) {
      console.error('[vector-store] Failed to connect to ChromaDB:', err);
    }
  }

  getCollectionName(): string {
    return this.collectionName;
  }

  isAvailable(): boolean {
    return this.collection !== null;
  }

  async indexAll(): Promise<number> {
    if (!this.collection) throw new Error('Vector store not initialized');

    const files = await this.walkVault(this.vaultPath);
    let indexed = 0;
    let skipped = 0;

    const total = files.length;
    for (const filePath of files) {
      try {
        const relativePath = relative(this.vaultPath, filePath);
        const fileStat = await stat(filePath);
        const lastModified = fileStat.mtime.toISOString();

        // Check if already indexed with same lastModified
        const existing = await this.collection!.get({
          where: { file: relativePath },
          limit: 1,
        });
        if (existing.ids.length > 0 && existing.metadatas?.[0]?.lastModified === lastModified) {
          skipped++;
          continue;
        }

        await this.indexFile(filePath);
        indexed++;
        if (indexed % 50 === 0) {
          console.log(`[vector-store] Progress: ${indexed} indexed, ${skipped} skipped / ${total} total`);
        }
      } catch (err) {
        console.error(`[vector-store] Failed to index ${filePath}:`, err);
      }
    }
    console.log(`[vector-store] Done: ${indexed} indexed, ${skipped} unchanged / ${total} total`);
    return indexed;
  }

  async indexFile(absolutePath: string): Promise<void> {
    if (!this.collection) return;

    const relativePath = relative(this.vaultPath, absolutePath);
    const content = await readFile(absolutePath, 'utf-8');
    const fileStat = await stat(absolutePath);

    // Remove old entries for this file
    try {
      const existing = await this.collection.get({
        where: { file: relativePath },
      });
      if (existing.ids.length > 0) {
        await this.collection.delete({ ids: existing.ids });
      }
    } catch { /* collection might be empty */ }

    // Use heading-aware chunking
    const vaultChunks = chunkMarkdown(relativePath, content, fileStat.mtime);
    if (vaultChunks.length === 0) return;

    const ids = vaultChunks.map((_, i) => `${relativePath}::${i}`);
    const documents = vaultChunks.map((c) => c.content);
    const metadatas = vaultChunks.map((c, i) => ({
      file: c.metadata.file,
      chunk: i,
      folder: c.metadata.folder,
      heading: c.metadata.heading,
      tags: c.metadata.tags.join(','),
      lastModified: c.metadata.lastModified,
    }));

    await this.collection.add({
      ids,
      documents,
      metadatas,
    });
  }

  async removeFile(relativePath: string): Promise<void> {
    if (!this.collection) return;

    try {
      const existing = await this.collection.get({
        where: { file: relativePath },
      });
      if (existing.ids.length > 0) {
        await this.collection.delete({ ids: existing.ids });
      }
    } catch (err) {
      console.error(`[vector-store] Failed to remove ${relativePath}:`, err);
    }
  }

  async search(query: string, options?: {
    topN?: number;
    folder?: string;
    minScore?: number;
  }): Promise<VectorSearchResult[]> {
    if (!this.collection) throw new Error('Vector store not available');

    const topN = options?.topN ?? 5;
    const where = options?.folder ? { folder: options.folder } : undefined;

    const results = await this.collection.query({
      queryTexts: [query],
      nResults: topN,
      where,
    });

    if (!results.documents?.[0]) return [];

    const searchResults: VectorSearchResult[] = [];
    const minScore = options?.minScore ?? 0;

    for (let i = 0; i < results.documents[0].length; i++) {
      const score = results.distances?.[0]?.[i] != null ? 1 - (results.distances[0][i] as number) : 0;
      if (score < minScore) continue;

      searchResults.push({
        file: String(results.metadatas?.[0]?.[i]?.file || ''),
        score,
        content: results.documents[0][i] || '',
        metadata: (results.metadatas?.[0]?.[i] || {}) as Record<string, unknown>,
      });
    }

    return searchResults;
  }

  async incrementalIndex(changedFiles: string[], deletedFiles: string[]): Promise<void> {
    for (const file of deletedFiles) {
      await this.removeFile(file);
    }

    for (const file of changedFiles) {
      try {
        const absolutePath = join(this.vaultPath, file);
        await this.indexFile(absolutePath);
      } catch (err) {
        console.error(`[vector-store] Failed to re-index ${file}:`, err);
      }
    }
  }

  private async walkVault(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        results.push(...await this.walkVault(fullPath));
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        results.push(fullPath);
      }
    }

    return results;
  }
}
