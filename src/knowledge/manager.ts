import type { KnowledgeAdapter, KnowledgeDocument, SyncResult } from './types.js';

export class KnowledgeManager {
  private adapters = new Map<string, KnowledgeAdapter>();

  register(adapter: KnowledgeAdapter): void {
    this.adapters.set(adapter.id, adapter);
    console.log(`[knowledge] Registered adapter: ${adapter.id} (${adapter.type})`);
  }

  unregister(id: string): void {
    this.adapters.delete(id);
    console.log(`[knowledge] Unregistered adapter: ${id}`);
  }

  getAdapter(id: string): KnowledgeAdapter | undefined {
    return this.adapters.get(id);
  }

  getAll(): KnowledgeAdapter[] {
    return Array.from(this.adapters.values());
  }

  async search(query: string, opts?: { sources?: string[]; maxResults?: number }): Promise<KnowledgeDocument[]> {
    const maxResults = opts?.maxResults ?? 20;
    const sources = opts?.sources;

    const adaptersToSearch = sources
      ? Array.from(this.adapters.values()).filter((a) => sources.includes(a.id))
      : Array.from(this.adapters.values());

    const allResults: KnowledgeDocument[] = [];
    const perAdapter = Math.max(1, Math.ceil(maxResults / Math.max(1, adaptersToSearch.length)));

    const promises = adaptersToSearch.map(async (adapter) => {
      try {
        return await adapter.search(query, { maxResults: perAdapter });
      } catch (err) {
        console.error(`[knowledge] Search failed for adapter ${adapter.id}:`, err);
        return [];
      }
    });

    const results = await Promise.all(promises);
    for (const docs of results) {
      allResults.push(...docs);
    }

    return allResults.slice(0, maxResults);
  }

  async read(source: string, path: string): Promise<KnowledgeDocument> {
    const adapter = this.adapters.get(source);
    if (!adapter) {
      throw new Error(`Knowledge source not found: ${source}`);
    }
    return adapter.read(path);
  }

  async syncAll(): Promise<Record<string, SyncResult>> {
    const results: Record<string, SyncResult> = {};

    for (const [id, adapter] of this.adapters) {
      try {
        results[id] = await adapter.sync();
      } catch (err) {
        console.error(`[knowledge] Sync failed for adapter ${id}:`, err);
        results[id] = { added: 0, updated: 0, deleted: 0 };
      }
    }

    return results;
  }

  async syncOne(id: string): Promise<SyncResult> {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Knowledge source not found: ${id}`);
    }
    return adapter.sync();
  }
}
