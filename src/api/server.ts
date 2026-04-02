import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { healthRoutes } from './routes/health.js';
import { chatRoutes } from './routes/chat.js';
import { conversationRoutes } from './routes/conversations.js';
import { agentRoutes } from './routes/agents.js';
import { connectionRoutes } from './routes/connections.js';
import { auditRoutes } from './routes/audit.js';
import { settingsRoutes } from './routes/settings.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { scheduleRoutes } from './routes/schedules.js';
import { notificationRoutes } from './routes/notifications.js';
import { channelRoutes } from './routes/channels.js';
import { orchestratorRoutes } from './routes/orchestrator.js';
import { mcpProxyRoutes } from './routes/mcp-proxy.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { userConnectionRoutes } from './routes/user-connections.js';
import { setupRoutes } from './routes/setup.js';
import { threadRoutes } from './routes/threads.js';
import { memoryRoutes } from './routes/memories.js';
import { preferenceRoutes } from './routes/preferences.js';
import { authMiddleware, createAuthMiddleware } from './middleware.js';
import type { AuthUser } from './middleware.js';
import { RbacService } from '../core/rbac.js';
import { setupWebSocket } from './ws.js';
type BetterAuthInstance = { api: { getSession: (opts: { headers: Headers }) => Promise<{ user?: { id: string; email: string; name?: string | null } } | null> }; handler: (req: Request) => Promise<Response> } | null;
import type { AgentService } from '../agent/service.js';
import type { DatabaseService } from '../core/database.js';
import type { GitSync } from '../core/git.js';
import type { JobRegistry } from '../jobs/registry.js';
import type { KnowledgeManager } from '../knowledge/manager.js';
import type { NotificationManager } from '../notifications/manager.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { McpGateway } from '../agent/mcp-gateway.js';
import type { RuntimeRegistry } from '../runtime/index.js';
import type { DockerRuntime } from '../runtime/docker.js';
import type { ChannelGateway } from '../channels/gateway.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

export interface ApiDeps {
  agentService: AgentService;
  orchestrator?: Orchestrator;
  db: DatabaseService;
  gitSync: GitSync;
  jobRegistry: JobRegistry;
  knowledgeManager: KnowledgeManager;
  notificationManager?: NotificationManager;
  auth?: BetterAuthInstance;
  mcpGateway?: McpGateway;
  runtimeRegistry?: RuntimeRegistry;
  channelGateway?: ChannelGateway;
}

/** Middleware: require admin role for mutating operations. */
async function requireAdminForMutations(c: Context, next: Next): Promise<void | Response> {
  // Allow GET/HEAD requests (read-only) for all authenticated users
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  const user = c.get('user') as AuthUser | undefined;
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.roles?.includes('admin')) return c.json({ error: 'Forbidden' }, 403);
  return next();
}

export function createApi(deps: ApiDeps) {
  const app = new Hono();
  const auth = deps.auth ?? null;
  const rbac = new RbacService(deps.db);

  // Global middleware
  app.use('*', cors({
    origin: (origin) => origin || '*',
    credentials: true,
  }));
  app.use('*', logger());

  // Health (no auth required)
  app.route('/api', healthRoutes(deps));

  // Internal MCP proxy (no auth — accessed by agent containers via run-scoped headers)
  const dockerRuntime = deps.runtimeRegistry?.get('docker') as DockerRuntime | undefined;
  app.route('', mcpProxyRoutes({ db: deps.db, mcpGateway: deps.mcpGateway, dockerRuntime }));

  // Auth routes BEFORE auth middleware (sign-up, sign-in, sign-out, get-session don't require auth)
  app.route('/api', authRoutes());

  // Allow OAuth callbacks without auth (redirected from provider)
  app.use('/api/connections/*/callback/user', async (c, next) => {
    // OAuth callbacks come from the provider redirect — no session cookie available
    // State parameter is validated inside the route handler
    return next();
  });

  // Auth middleware for all other API routes
  if (auth) {
    app.use('/api/*', createAuthMiddleware(auth));
  } else {
    app.use('/api/*', authMiddleware);
  }

  // Admin routes (require admin role — applied inside the route module)
  app.route('/api', adminRoutes({ db: deps.db, rbac }));

  // Route protection: require admin role for mutating operations on managed resources
  app.use('/api/agents/*', requireAdminForMutations);
  app.use('/api/connections/*', requireAdminForMutations);
  app.use('/api/schedules/*', requireAdminForMutations);
  app.use('/api/settings/*', requireAdminForMutations);

  // User-facing routes (no admin required)
  app.route('/api', userConnectionRoutes(deps));
  app.route('/api', setupRoutes(deps));

  // API routes
  app.route('/api', chatRoutes(deps));
  app.route('/api', threadRoutes(deps));
  app.route('/api', memoryRoutes({ db: deps.db }));
  app.route('/api', preferenceRoutes({ db: deps.db }));
  app.route('/api', conversationRoutes(deps));
  app.route('/api', agentRoutes(deps));
  app.route('/api', connectionRoutes(deps));
  app.route('/api', auditRoutes(deps));
  app.route('/api', settingsRoutes(deps));
  app.route('/api', scheduleRoutes(deps));

  // Knowledge routes (always registered — sources can be added via UI)
  app.route('/api', knowledgeRoutes({ db: deps.db, knowledgeManager: deps.knowledgeManager }));

  // Notification routes (requires NotificationManager)
  if (deps.notificationManager) {
    app.route('/api', notificationRoutes({ db: deps.db, notificationManager: deps.notificationManager }));
  }

  // Communication channel routes
  if (deps.channelGateway) {
    app.route('/api', channelRoutes({ db: deps.db, channelGateway: deps.channelGateway }));
  }

  // Orchestrator routes (task assign, council, approvals)
  if (deps.orchestrator) {
    app.route('/api', orchestratorRoutes({ orchestrator: deps.orchestrator, db: deps.db }));
  }

  // Serve frontend static files in production
  if (process.env.NODE_ENV === 'production') {
    app.use('/*', serveStatic({ root: './web/dist' }));
    // SPA fallback — serve index.html for non-API, non-static routes
    app.get('*', serveStatic({ root: './web/dist', path: 'index.html' }));
  }

  return app;
}

export function startApiServer(deps: ApiDeps): Server {
  const app = createApi(deps);

  const server = serve({
    fetch: app.fetch,
    port: PORT,
  }, (info) => {
    console.log(`[api] Server listening on http://localhost:${info.port}`);
  });

  // WebSocket upgrade handler
  setupWebSocket(server as Server, deps);

  return server as Server;
}
