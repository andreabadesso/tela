import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import crypto from 'node:crypto';
import type { AuthUser } from '../middleware.js';
import type { DatabaseService } from '../../core/database.js';
import type { WorkspaceManager } from '../../runtime/workspace-manager.js';
import type { GitService } from '../../services/git-service.js';
import type { ProjectSessionRuntime } from '../../runtime/project-session.js';
import { config } from '../../config/env.js';

function toSlug(name: string, id: string): string {
  const base = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return `${base}-${id.slice(-6)}`;
}

function canAccess(project: { owner_id: string; visibility: string; team_id: string | null }, user: AuthUser): boolean {
  if (user.roles.includes('admin')) return true;
  if (project.owner_id === user.id) return true;
  if (project.visibility === 'public') return true;
  if (project.visibility === 'team' && project.team_id && user.teams.includes(project.team_id)) return true;
  return false;
}

function canModify(project: { owner_id: string }, user: AuthUser): boolean {
  return user.roles.includes('admin') || project.owner_id === user.id;
}

function enrichProject(project: ReturnType<DatabaseService['getProject']>, db: DatabaseService) {
  if (!project) return null;
  const workspace = project.workspace_id ? db.getWorkspace(project.workspace_id) : null;
  const baseUrl = process.env.BASE_URL || `http://localhost:${config.port}`;
  const sessions = db.listProjectSessions(project.id, 50);
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    stack: project.stack,
    visibility: project.visibility,
    team_id: project.team_id,
    owner_id: project.owner_id,
    git_repo_slug: project.git_repo_slug,
    insforge_project_id: project.insforge_project_id,
    app_url: workspace ? `${baseUrl}/apps/${workspace.id}` : null,
    workspace_id: project.workspace_id,
    workspace_status: workspace?.status ?? null,
    session_count: sessions.length,
    last_session_at: sessions[0]?.created_at ?? null,
    last_commit_sha: sessions.find(s => s.commit_sha)?.commit_sha ?? null,
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

export function projectRoutes(deps: {
  db: DatabaseService;
  workspaceManager?: WorkspaceManager;
  gitService?: GitService;
  projectSessionRuntime?: ProjectSessionRuntime;
}) {
  const app = new Hono();

  // List projects accessible to current user
  app.get('/projects', (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const projects = deps.db.listProjects(user.id, user.teams, user.roles.includes('admin'));
    return c.json(projects.map(p => enrichProject(p, deps.db)));
  });

  // Create project + workspace + git repo
  app.post('/projects', async (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json<{
      name: string;
      description?: string;
      team_id?: string;
      insforge_project_id?: string;
    }>();

    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);

    if (body.team_id) {
      const team = deps.db.getTeam(body.team_id);
      if (!team) return c.json({ error: 'team not found' }, 400);
    }

    const id = crypto.randomUUID();
    const slug = toSlug(body.name.trim(), id);

    // Create workspace
    let workspaceId: string | null = null;
    if (deps.workspaceManager) {
      try {
        const ws = await deps.workspaceManager.create(
          `project-${slug}`,
          'app-builder',
          user.id,
        );
        workspaceId = ws.id;
      } catch (err) {
        console.error('[projects] Failed to create workspace:', err);
      }
    }

    // Insert project row
    const project = deps.db.createProject({
      id,
      name: body.name.trim(),
      description: body.description ?? null,
      owner_id: user.id,
      team_id: body.team_id ?? null,
      git_repo_slug: slug,
      workspace_id: workspaceId,
      insforge_project_id: body.insforge_project_id ?? null,
    });

    // Init git repo (after DB commit — non-blocking, best-effort)
    if (deps.gitService) {
      deps.gitService.initRepo(slug).catch(err => {
        console.error(`[projects] git init failed for ${slug}:`, err);
      });
    }

    return c.json(enrichProject(project, deps.db), 201);
  });

  // Get project detail with recent sessions
  app.get('/projects/:id', (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const project = deps.db.getProject(c.req.param('id'));
    if (!project || !canAccess(project, user)) return c.json({ error: 'Not found' }, 404);

    const sessions = deps.db.listProjectSessions(project.id, 10);
    const enriched = enrichProject(project, deps.db);
    return c.json({ ...enriched, sessions });
  });

  // Update project
  app.patch('/projects/:id', async (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const project = deps.db.getProject(c.req.param('id'));
    if (!project || !canAccess(project, user)) return c.json({ error: 'Not found' }, 404);
    if (!canModify(project, user)) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json<{
      name?: string;
      description?: string;
      visibility?: 'private' | 'team' | 'public';
      team_id?: string;
      insforge_project_id?: string;
    }>();

    if (body.visibility === 'team' && !body.team_id && !project.team_id) {
      return c.json({ error: 'team_id is required for team visibility' }, 400);
    }

    const updated = deps.db.updateProject(project.id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.visibility !== undefined && { visibility: body.visibility }),
      ...(body.team_id !== undefined && { team_id: body.team_id }),
      ...(body.insforge_project_id !== undefined && { insforge_project_id: body.insforge_project_id }),
    });

    return c.json(enrichProject(updated!, deps.db));
  });

  // Delete project
  app.delete('/projects/:id', async (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const project = deps.db.getProject(c.req.param('id'));
    if (!project || !canAccess(project, user)) return c.json({ error: 'Not found' }, 404);
    if (!canModify(project, user)) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json<{ confirm?: boolean }>().catch(() => ({ confirm: undefined }));
    if (!body.confirm) return c.json({ error: 'confirm: true required' }, 400);

    // Destroy workspace
    if (project.workspace_id && deps.workspaceManager) {
      await deps.workspaceManager.destroy(project.workspace_id).catch(err =>
        console.error('[projects] workspace destroy failed:', err)
      );
    }

    // Delete git repo
    if (deps.gitService) {
      await deps.gitService.deleteRepo(project.git_repo_slug).catch(err =>
        console.error('[projects] git delete failed:', err)
      );
    }

    deps.db.deleteProject(project.id);
    return c.json({ ok: true });
  });

  // ─── Session Routes ────────────────────────────────────────────

  // List sessions for a project
  app.get('/projects/:id/sessions', (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const project = deps.db.getProject(c.req.param('id'));
    if (!project || !canAccess(project, user)) return c.json({ error: 'Not found' }, 404);

    const sessions = deps.db.listProjectSessions(project.id, 50);
    return c.json(sessions);
  });

  // Get session detail
  app.get('/projects/:id/sessions/:sid', (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const project = deps.db.getProject(c.req.param('id'));
    if (!project || !canAccess(project, user)) return c.json({ error: 'Not found' }, 404);

    const session = deps.db.getProjectSession(c.req.param('sid'));
    if (!session || session.project_id !== project.id) return c.json({ error: 'Not found' }, 404);

    return c.json(session);
  });

  // Start a new session
  app.post('/projects/:id/sessions', async (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const project = deps.db.getProject(c.req.param('id'));
    if (!project || !canAccess(project, user)) return c.json({ error: 'Not found' }, 404);

    // Reject concurrent sessions
    const active = deps.db.getActiveSessionForProject(project.id);
    if (active) return c.json({ error: 'A session is already running for this project', session_id: active.id }, 409);

    const body = await c.req.json<{ message: string; agent_id: string }>();
    if (!body.message?.trim()) return c.json({ error: 'message is required' }, 400);
    if (!body.agent_id) return c.json({ error: 'agent_id is required' }, 400);

    const agent = deps.db.getAgent(body.agent_id);
    if (!agent) return c.json({ error: 'Agent not found' }, 400);

    if (!deps.projectSessionRuntime) {
      return c.json({ error: 'Project session runtime not available' }, 503);
    }

    const sessionId = crypto.randomUUID();
    const session = deps.db.createProjectSession({
      id: sessionId,
      project_id: project.id,
      agent_id: body.agent_id,
      user_id: user.id,
      input: body.message,
    });

    // Run session asynchronously
    deps.projectSessionRuntime.runSession(session.id, project.id, body.agent_id, user.id, body.message)
      .catch(err => console.error(`[projects] session ${sessionId} failed:`, err));

    return c.json(session, 202);
  });

  // Stream live agent events for a session (SSE)
  app.get('/projects/:id/sessions/:sid/stream', async (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const project = deps.db.getProject(c.req.param('id'));
    if (!project || !canAccess(project, user)) return c.json({ error: 'Not found' }, 404);

    const session = deps.db.getProjectSession(c.req.param('sid'));
    if (!session || session.project_id !== project.id) return c.json({ error: 'Not found' }, 404);

    // Session already finished — replay saved output
    if (!['pending', 'running'].includes(session.status)) {
      return streamSSE(c, async (stream) => {
        if (session.output) {
          await stream.writeSSE({ event: 'result', data: JSON.stringify({ type: 'result', text: session.output }) });
        }
        if (session.error) {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: session.error }) });
        }
        await stream.writeSSE({ event: 'session_done', data: JSON.stringify({ status: session.status }) });
      });
    }

    // Live session — subscribe to emitter
    const emitter = deps.projectSessionRuntime?.getSessionEmitter(session.id);
    if (!emitter) {
      // Race condition: session ended between DB check and emitter lookup
      const fresh = deps.db.getProjectSession(session.id);
      return streamSSE(c, async (stream) => {
        if (fresh?.output) {
          await stream.writeSSE({ event: 'result', data: JSON.stringify({ type: 'result', text: fresh.output }) });
        }
        await stream.writeSSE({ event: 'session_done', data: JSON.stringify({ status: fresh?.status ?? 'failed' }) });
      });
    }

    return streamSSE(c, async (sseStream) => {
      await new Promise<void>((resolve) => {
        const onEvent = (event: unknown) => {
          sseStream.writeSSE({ event: (event as any).type, data: JSON.stringify(event) }).catch(() => {});
        };
        const onDone = (data: unknown) => {
          sseStream.writeSSE({ event: 'session_done', data: JSON.stringify(data) })
            .catch(() => {})
            .finally(resolve);
        };
        emitter.on('agent_event', onEvent);
        emitter.once('session_done', onDone);
        sseStream.onAbort(() => {
          emitter.off('agent_event', onEvent);
          emitter.off('session_done', onDone);
          resolve();
        });
      });
    });
  });

  // Wake (pre-warm) the container for this project
  app.post('/projects/:id/wake', async (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const project = deps.db.getProject(c.req.param('id'));
    if (!project || !canAccess(project, user)) return c.json({ error: 'Not found' }, 404);

    // Fire and forget — pre-warm the container in the background
    if (project.workspace_id && deps.workspaceManager) {
      deps.workspaceManager.start(project.workspace_id).catch(err =>
        console.error(`[projects] wake failed for workspace ${project.workspace_id}:`, err)
      );
    }

    return c.json({ ok: true }, 202);
  });

  // Cancel a session
  app.post('/projects/:id/sessions/:sid/cancel', async (c) => {
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const project = deps.db.getProject(c.req.param('id'));
    if (!project || !canAccess(project, user)) return c.json({ error: 'Not found' }, 404);
    if (!canModify(project, user)) return c.json({ error: 'Forbidden' }, 403);

    const session = deps.db.getProjectSession(c.req.param('sid'));
    if (!session || session.project_id !== project.id) return c.json({ error: 'Not found' }, 404);

    if (!['pending', 'running'].includes(session.status)) {
      return c.json({ error: 'Session is not active' }, 400);
    }

    deps.db.updateProjectSession(session.id, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    });

    return c.json({ ok: true });
  });

  return app;
}
