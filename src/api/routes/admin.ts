import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { DatabaseService } from '../../core/database.js';
import type { RbacService } from '../../core/rbac.js';
import type { AuthUser } from '../middleware.js';

export interface AdminDeps {
  db: DatabaseService;
  rbac: RbacService;
}

/**
 * Middleware: require admin role on the authenticated user.
 */
async function requireAdmin(c: Context, next: Next) {
  const user = c.get('user') as AuthUser | undefined;
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.roles?.includes('admin')) return c.json({ error: 'Forbidden' }, 403);
  return next();
}

export function adminRoutes(deps: AdminDeps) {
  const app = new Hono();

  // All admin routes require admin role
  app.use('/*', requireAdmin);

  // ─── Users ──────────────────────────────────────────────────────

  app.get('/admin/users', (c) => {
    const users = deps.db.getUsers();
    // Enrich with roles and teams
    const enriched = users.map(u => ({
      ...u,
      roles: deps.db.getUserRoles(u.id),
      teams: deps.db.getUserTeams(u.id),
    }));
    return c.json(enriched);
  });

  app.post('/admin/users', async (c) => {
    const body = await c.req.json();
    if (!body.email) return c.json({ error: 'email is required' }, 400);
    const user = deps.db.createUser(body);
    return c.json(user, 201);
  });

  app.put('/admin/users/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const user = deps.db.updateUser(id, body);
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json(user);
  });

  // Assign role to user
  app.post('/admin/users/:id/roles', async (c) => {
    const userId = c.req.param('id');
    const { roleId } = await c.req.json() as { roleId: string };
    if (!roleId) return c.json({ error: 'roleId is required' }, 400);
    const user = deps.db.getUser(userId);
    if (!user) return c.json({ error: 'User not found' }, 404);
    const role = deps.db.getRole(roleId);
    if (!role) return c.json({ error: 'Role not found' }, 404);
    deps.db.assignRole(userId, roleId);
    return c.json({ ok: true });
  });

  // Remove role from user
  app.delete('/admin/users/:id/roles/:roleId', (c) => {
    const userId = c.req.param('id');
    const roleId = c.req.param('roleId');
    deps.db.removeRole(userId, roleId);
    return c.json({ ok: true });
  });

  // Add user to team
  app.post('/admin/users/:id/teams', async (c) => {
    const userId = c.req.param('id');
    const { teamId, roleInTeam } = await c.req.json() as { teamId: string; roleInTeam?: string };
    if (!teamId) return c.json({ error: 'teamId is required' }, 400);
    const user = deps.db.getUser(userId);
    if (!user) return c.json({ error: 'User not found' }, 404);
    const team = deps.db.getTeam(teamId);
    if (!team) return c.json({ error: 'Team not found' }, 404);
    deps.db.joinTeam(userId, teamId, roleInTeam);
    return c.json({ ok: true });
  });

  // Remove user from team
  app.delete('/admin/users/:id/teams/:teamId', (c) => {
    const userId = c.req.param('id');
    const teamId = c.req.param('teamId');
    deps.db.leaveTeam(userId, teamId);
    return c.json({ ok: true });
  });

  // ─── Roles ──────────────────────────────────────────────────────

  app.get('/admin/roles', (c) => {
    const roles = deps.db.getRoles();
    return c.json(roles);
  });

  app.post('/admin/roles', async (c) => {
    const body = await c.req.json();
    if (!body.name) return c.json({ error: 'name is required' }, 400);
    const role = deps.db.createRole({ ...body, is_system: 0 });
    return c.json(role, 201);
  });

  app.put('/admin/roles/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const role = deps.db.updateRole(id, body);
    if (!role) return c.json({ error: 'Role not found' }, 404);
    return c.json(role);
  });

  app.delete('/admin/roles/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.db.deleteRole(id);
    if (!deleted) return c.json({ error: 'Role not found or is a system role' }, 404);
    return c.json({ ok: true });
  });

  // ─── Teams ──────────────────────────────────────────────────────

  app.get('/admin/teams', (c) => {
    const teams = deps.db.getTeams();
    const enriched = teams.map(t => ({
      ...t,
      members: deps.db.getTeamMembers(t.id),
    }));
    return c.json(enriched);
  });

  app.post('/admin/teams', async (c) => {
    const body = await c.req.json();
    if (!body.name) return c.json({ error: 'name is required' }, 400);
    const team = deps.db.createTeam(body);
    return c.json(team, 201);
  });

  app.put('/admin/teams/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const team = deps.db.updateTeam(id, body);
    if (!team) return c.json({ error: 'Team not found' }, 404);
    return c.json(team);
  });

  app.delete('/admin/teams/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.db.deleteTeam(id);
    if (!deleted) return c.json({ error: 'Team not found' }, 404);
    return c.json({ ok: true });
  });

  // ─── MCP Policies ──────────────────────────────────────────────

  app.get('/admin/policies/mcp', (c) => {
    const policies = deps.db.getMcpPolicies();
    return c.json(policies);
  });

  app.post('/admin/policies/mcp', async (c) => {
    const body = await c.req.json();
    if (!body.principal_type || !body.principal_id || !body.connection_id) {
      return c.json({ error: 'principal_type, principal_id, and connection_id are required' }, 400);
    }
    const policy = deps.db.createMcpPolicy(body);
    return c.json(policy, 201);
  });

  app.put('/admin/policies/mcp/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const policy = deps.db.updateMcpPolicy(id, body);
    if (!policy) return c.json({ error: 'Policy not found' }, 404);
    return c.json(policy);
  });

  app.delete('/admin/policies/mcp/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.db.deleteMcpPolicy(id);
    if (!deleted) return c.json({ error: 'Policy not found' }, 404);
    return c.json({ ok: true });
  });

  // ─── Knowledge Policies ─────────────────────────────────────────

  app.get('/admin/policies/knowledge', (c) => {
    const policies = deps.db.getKnowledgePolicies();
    return c.json(policies);
  });

  app.post('/admin/policies/knowledge', async (c) => {
    const body = await c.req.json();
    if (!body.principal_type || !body.principal_id || !body.knowledge_source_id) {
      return c.json({ error: 'principal_type, principal_id, and knowledge_source_id are required' }, 400);
    }
    const policy = deps.db.createKnowledgePolicy(body);
    return c.json(policy, 201);
  });

  app.put('/admin/policies/knowledge/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const policy = deps.db.updateKnowledgePolicy(id, body);
    if (!policy) return c.json({ error: 'Policy not found' }, 404);
    return c.json(policy);
  });

  app.delete('/admin/policies/knowledge/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.db.deleteKnowledgePolicy(id);
    if (!deleted) return c.json({ error: 'Policy not found' }, 404);
    return c.json({ ok: true });
  });

  // ─── Agent Policies ─────────────────────────────────────────────

  app.get('/admin/policies/agents', (c) => {
    const policies = deps.db.getAgentPolicies();
    return c.json(policies);
  });

  app.post('/admin/policies/agents', async (c) => {
    const body = await c.req.json();
    if (!body.principal_type || !body.principal_id || !body.agent_id) {
      return c.json({ error: 'principal_type, principal_id, and agent_id are required' }, 400);
    }
    const policy = deps.db.createAgentPolicy(body);
    return c.json(policy, 201);
  });

  app.put('/admin/policies/agents/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const policy = deps.db.updateAgentPolicy(id, body);
    if (!policy) return c.json({ error: 'Policy not found' }, 404);
    return c.json(policy);
  });

  app.delete('/admin/policies/agents/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.db.deleteAgentPolicy(id);
    if (!deleted) return c.json({ error: 'Policy not found' }, 404);
    return c.json({ ok: true });
  });

  // ─── Permission Preview ─────────────────────────────────────────

  app.get('/admin/users/:id/permissions', (c) => {
    const userId = c.req.param('id');
    const user = deps.db.getUser(userId);
    if (!user) return c.json({ error: 'User not found' }, 404);

    const perms = deps.rbac.getEffectivePermissions(userId);
    return c.json({
      userId,
      mcpAccess: Object.fromEntries(perms.mcpAccess),
      knowledgeAccess: Object.fromEntries(perms.knowledgeAccess),
      agentAccess: Object.fromEntries(perms.agentAccess),
      platformPermissions: [...perms.platformPermissions],
    });
  });

  return app;
}
