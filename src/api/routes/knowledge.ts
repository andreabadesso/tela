import { Hono } from 'hono';
import type { DatabaseService } from '../../services/database.js';
import type { KnowledgeManager } from '../../knowledge/manager.js';
import { ObsidianAdapter, scanVaultPath } from '../../knowledge/adapters/obsidian.js';
import { VectorStoreService } from '../../services/vector-store.js';
import { config } from '../../config/env.js';

export interface KnowledgeDeps {
  db: DatabaseService;
  knowledgeManager: KnowledgeManager;
}

export function knowledgeRoutes(deps: KnowledgeDeps) {
  const app = new Hono();

  // List knowledge sources
  app.get('/knowledge', (c) => {
    const sources = deps.db.getKnowledgeSources();
    // Enrich with live adapter status
    const enriched = sources.map((s) => {
      const adapter = deps.knowledgeManager.getAdapter(s.id);
      const status = adapter?.getStatus();
      return {
        ...s,
        connected: status?.connected ?? false,
        liveDocCount: status?.docCount ?? s.doc_count,
        liveError: status?.error,
      };
    });
    return c.json(enriched);
  });

  // Add knowledge source
  app.post('/knowledge', async (c) => {
    const body = await c.req.json();
    const id = body.id ?? crypto.randomUUID();
    const source = deps.db.createKnowledgeSource({
      id,
      name: body.name,
      type: body.type,
      config: JSON.stringify(body.config ?? {}),
      status: 'connected',
      doc_count: 0,
      last_sync_at: null,
      error_message: null,
    });

    // Register adapter dynamically so it's immediately usable
    if (body.type === 'obsidian') {
      try {
        const sourceConfig = body.config ?? {};
        let vs: VectorStoreService | undefined;
        if (config.chromaUrl) {
          vs = new VectorStoreService(sourceConfig.vaultPath || sourceConfig.path || config.vaultPath, `knowledge-${id}`);
          try {
            await vs.initialize();
          } catch {
            vs = undefined;
          }
        }
        const adapter = new ObsidianAdapter(id, {
          vaultPath: sourceConfig.vaultPath || sourceConfig.path || '',
          rootScope: sourceConfig.rootScope,
        }, vs);
        deps.knowledgeManager.register(adapter);
      } catch (err) {
        console.error(`[knowledge] Failed to register adapter for ${id}:`, err);
      }
    }

    return c.json(source, 201);
  });

  // Update knowledge source
  app.put('/knowledge/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.config !== undefined) update.config = JSON.stringify(body.config);
    if (body.type !== undefined) update.type = body.type;
    const source = deps.db.updateKnowledgeSource(id, update);
    if (!source) {
      return c.json({ error: 'Knowledge source not found' }, 404);
    }
    return c.json(source);
  });

  // Delete knowledge source
  app.delete('/knowledge/:id', (c) => {
    const id = c.req.param('id');
    deps.knowledgeManager.unregister(id);
    const deleted = deps.db.deleteKnowledgeSource(id);
    if (!deleted) {
      return c.json({ error: 'Knowledge source not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Trigger sync for a source
  app.post('/knowledge/:id/sync', async (c) => {
    const id = c.req.param('id');
    const adapter = deps.knowledgeManager.getAdapter(id);
    if (!adapter) {
      return c.json({ error: 'Knowledge source not found or not registered' }, 404);
    }
    try {
      const result = await adapter.sync();
      // Update DB with sync results
      const status = adapter.getStatus();
      deps.db.updateKnowledgeSource(id, {
        last_sync_at: new Date().toISOString(),
        doc_count: status.docCount,
        status: 'connected',
        error_message: null,
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Don't change status to error — source is still readable, sync just failed
      deps.db.updateKnowledgeSource(id, {
        error_message: `Sync failed: ${message}`,
      });
      return c.json({ error: message }, 500);
    }
  });

  // Get sync status for a source
  app.get('/knowledge/:id/status', (c) => {
    const id = c.req.param('id');
    const source = deps.db.getKnowledgeSource(id);
    if (!source) {
      return c.json({ error: 'Knowledge source not found' }, 404);
    }
    const adapter = deps.knowledgeManager.getAdapter(id);
    const status = adapter?.getStatus();
    return c.json({
      id: source.id,
      name: source.name,
      type: source.type,
      status: source.status,
      connected: status?.connected ?? false,
      lastSync: source.last_sync_at,
      docCount: status?.docCount ?? source.doc_count,
      error: status?.error ?? source.error_message,
    });
  });

  // Unified search across all sources
  app.post('/knowledge/search', async (c) => {
    const body = await c.req.json();
    const results = await deps.knowledgeManager.search(body.query, {
      sources: body.sources,
      maxResults: body.maxResults,
    });
    return c.json({ results });
  });

  // ─── New Obsidian-specific endpoints ─────────────────────────

  // Scan a vault path (for the wizard — no existing source needed)
  app.post('/knowledge/scan', async (c) => {
    try {
      const body = await c.req.json();
      const vaultPath = body.vaultPath;
      if (!vaultPath || typeof vaultPath !== 'string') {
        return c.json({ error: 'vaultPath is required' }, 400);
      }
      const result = await scanVaultPath(vaultPath);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Get folder tree for a knowledge source
  app.get('/knowledge/:id/folders', async (c) => {
    const id = c.req.param('id');
    const adapter = deps.knowledgeManager.getAdapter(id);
    if (!adapter || !(adapter instanceof ObsidianAdapter)) {
      return c.json({ error: 'Obsidian knowledge source not found' }, 404);
    }
    try {
      const folders = await adapter.scanFolders();
      return c.json(folders);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Get all tags with counts for a knowledge source
  app.get('/knowledge/:id/tags', async (c) => {
    const id = c.req.param('id');
    const adapter = deps.knowledgeManager.getAdapter(id);
    if (!adapter || !(adapter instanceof ObsidianAdapter)) {
      return c.json({ error: 'Obsidian knowledge source not found' }, 404);
    }
    try {
      const tagsMap = await adapter.getAllTags();
      // Convert { tag: count } map to TagCount[] array
      const tagsArray = Object.entries(tagsMap).map(([tag, count]) => ({ tag, count: count as number }));
      tagsArray.sort((a, b) => b.count - a.count);
      return c.json(tagsArray);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // List files (paginated, filterable by folder/tag)
  app.get('/knowledge/:id/files', async (c) => {
    const id = c.req.param('id');
    const adapter = deps.knowledgeManager.getAdapter(id);
    if (!adapter || !(adapter instanceof ObsidianAdapter)) {
      return c.json({ error: 'Obsidian knowledge source not found' }, 404);
    }
    try {
      const folder = c.req.query('folder');
      const tag = c.req.query('tag');
      const offset = parseInt(c.req.query('offset') || '0', 10);
      const limit = parseInt(c.req.query('limit') || '50', 10);
      const result = await adapter.listFiles({ folder: folder ?? undefined, tag: tag ?? undefined, offset, limit });
      // Enrich files with name, folder, tags
      const enrichedFiles = result.files.map((f: { path: string; lastModified: string; size: number; tags?: string[] }) => {
        const parts = f.path.split('/');
        return {
          path: f.path,
          name: parts[parts.length - 1]?.replace(/\.md$/, '') ?? f.path,
          folder: parts.length > 1 ? parts.slice(0, -1).join('/') : '/',
          size: f.size,
          lastModified: f.lastModified,
          tags: f.tags ?? [],
        };
      });
      return c.json({ files: enrichedFiles, total: result.total });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Read a specific file's content
  app.get('/knowledge/:id/file', async (c) => {
    const id = c.req.param('id');
    const adapter = deps.knowledgeManager.getAdapter(id);
    if (!adapter || !(adapter instanceof ObsidianAdapter)) {
      return c.json({ error: 'Obsidian knowledge source not found' }, 404);
    }
    const filePath = c.req.query('path');
    if (!filePath) {
      return c.json({ error: 'path query parameter is required' }, 400);
    }
    try {
      const content = await adapter.readFileContent(filePath);
      return c.json({ path: filePath, content });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
