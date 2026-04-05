import { Hono } from 'hono';
import type { AuthUser } from '../middleware.js';
import type { DatabaseService } from '../../core/database.js';
import type { RuntimeRegistry } from '../../runtime/index.js';
import type { DevContainerRuntime } from '../../runtime/devcontainer.js';
import type { WorkspaceRow } from '../../runtime/workspace-manager.js';
import { config } from '../../config/env.js';

/** Fetch InsForge metadata from the management API. */
async function fetchInsforgeMetadata() {
  const baseUrl = config.insforgeApiUrl.replace('host.docker.internal', 'localhost');
  const apiKey = config.insforgeApiKey;
  if (!baseUrl) return null;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  try {
    const res = await fetch(`${baseUrl}/api/metadata?mcp=true`, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Fetch InsForge deployments. */
async function fetchInsforgeDeployments() {
  const baseUrl = config.insforgeApiUrl.replace('host.docker.internal', 'localhost');
  const apiKey = config.insforgeApiKey;
  if (!baseUrl) return [];

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  try {
    const res = await fetch(`${baseUrl}/api/deployments`, { headers });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export function workspaceRoutes(deps: {
  db: DatabaseService;
  runtimeRegistry?: RuntimeRegistry;
}) {
  const app = new Hono();

  // Full InsForge services overview — tables, functions, buckets, deployments
  app.get('/services', async (c) => {
    const [metadata, deployments] = await Promise.all([
      fetchInsforgeMetadata(),
      fetchInsforgeDeployments(),
    ]);

    if (!metadata) {
      return c.json({ error: 'InsForge is not reachable' }, 503);
    }

    return c.json({
      database: metadata.database ?? { tables: [], totalSizeInGB: 0 },
      functions: metadata.functions ?? [],
      storage: metadata.storage ?? { buckets: [], totalSizeInGB: 0 },
      deployments: deployments ?? [],
      version: metadata.version,
    });
  });

  // List workspaces (filtered by user access)
  app.get('/workspaces', (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    const allWorkspaces = deps.db.getWorkspaces();

    // Filter by access: user sees their own + team + public (admins see all)
    const workspaces = allWorkspaces.filter(ws => {
      if (!user) return false;
      if (user.roles.includes('admin')) return true;
      if (ws.owner_id === user.id) return true;
      if (ws.visibility === 'public') return true;
      if (ws.visibility === 'team' && ws.team_id && user.teams.includes(ws.team_id)) return true;
      return false;
    });

    const enriched = workspaces.map((ws) => {
      const agent = deps.db.getAgent(ws.agent_id);
      let portMappings: { containerPort: number; hostPort: number; url: string }[] = [];
      try {
        portMappings = JSON.parse(ws.port_mappings);
      } catch { /* empty */ }

      // Build proxy URLs for port mappings
      const baseUrl = process.env.BASE_URL || `http://localhost:${config.port}`;
      const appUrl = portMappings.length > 0 ? `${baseUrl}/apps/${ws.id}` : null;

      return {
        id: ws.id,
        name: ws.name,
        agentId: ws.agent_id,
        agentName: agent?.name ?? ws.agent_id,
        containerId: ws.container_id,
        status: ws.status,
        portMappings,
        appUrl,
        staticAppPath: ws.static_app_path ?? null,
        visibility: ws.visibility,
        ownerId: ws.owner_id,
        teamId: ws.team_id,
        insforgeProjectId: ws.insforge_project_id,
        diskUsageMb: ws.disk_usage_mb,
        createdAt: ws.created_at,
        updatedAt: ws.updated_at,
        lastActiveAt: ws.last_active_at,
      };
    });

    return c.json(enriched);
  });

  // Update workspace visibility
  app.patch('/workspaces/:id/visibility', async (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const workspaceId = c.req.param('id');
    const workspace = deps.db.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);

    // Only owner or admin can change visibility
    if (workspace.owner_id !== user.id && !user.roles.includes('admin')) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<{ visibility: string; teamId?: string }>();
    const { visibility, teamId } = body;

    if (!['private', 'team', 'public'].includes(visibility)) {
      return c.json({ error: 'Invalid visibility. Must be: private, team, or public' }, 400);
    }

    if (visibility === 'team' && !teamId) {
      return c.json({ error: 'team_id is required for team visibility' }, 400);
    }

    deps.db.updateWorkspace(workspaceId, {
      visibility: visibility as 'private' | 'team' | 'public',
      team_id: visibility === 'team' ? teamId : null,
    });

    return c.json({ ok: true, visibility, teamId: visibility === 'team' ? teamId : null });
  });

  // Pause a workspace
  app.post('/workspaces/:id/pause', async (c) => {
    const devRuntime = deps.runtimeRegistry?.get('devcontainer') as DevContainerRuntime | undefined;
    if (!devRuntime) return c.json({ error: 'DevContainer runtime not available' }, 503);

    try {
      await devRuntime.workspaceManager.pause(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to pause' }, 500);
    }
  });

  // Resume a workspace
  app.post('/workspaces/:id/resume', async (c) => {
    const devRuntime = deps.runtimeRegistry?.get('devcontainer') as DevContainerRuntime | undefined;
    if (!devRuntime) return c.json({ error: 'DevContainer runtime not available' }, 503);

    try {
      const result = await devRuntime.workspaceManager.start(c.req.param('id'));
      return c.json({ ok: true, containerId: result.containerId });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to resume' }, 500);
    }
  });

  // Destroy a workspace
  app.delete('/workspaces/:id', async (c) => {
    const devRuntime = deps.runtimeRegistry?.get('devcontainer') as DevContainerRuntime | undefined;
    if (!devRuntime) return c.json({ error: 'DevContainer runtime not available' }, 503);

    try {
      await devRuntime.workspaceManager.destroy(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to destroy' }, 500);
    }
  });

  // Promote a build directory to the serve/ directory — called by project sessions
  // after a successful build (zero-downtime: old serve/ stays live until copy completes)
  app.post('/workspaces/:id/serve', async (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const workspaceId = c.req.param('id');
    const workspace = deps.db.getWorkspace(workspaceId);
    if (!workspace) return c.json({ error: 'Workspace not found' }, 404);

    // Only owner or admin can promote
    if (workspace.owner_id !== user.id && !user.roles.includes('admin')) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json<{ source_directory: string; api_port?: number }>();
    if (!body.source_directory) return c.json({ error: 'source_directory is required' }, 400);

    // Sanitize: strip leading /workspace/ prefix
    const sourceRelative = body.source_directory.replace(/^\/workspace\//, '').replace(/^\//, '');

    // Update static_app_path in DB (the workspace bind mount already has the files)
    const devRuntime = deps.runtimeRegistry?.get('devcontainer') as DevContainerRuntime | undefined;
    if (devRuntime) {
      devRuntime.workspaceManager.setStaticApp(workspaceId, sourceRelative);
    } else {
      deps.db.updateWorkspace(workspaceId, { static_app_path: sourceRelative });
    }

    const baseUrl = process.env.BASE_URL || `http://localhost:${config.port}`;
    return c.json({ ok: true, url: `${baseUrl}/apps/${workspaceId}` });
  });

  return app;
}
