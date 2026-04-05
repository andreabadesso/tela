import { Hono } from 'hono';
import type { Context } from 'hono';
import { SignJWT } from 'jose';
import { createReadStream, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { Readable } from 'node:stream';
import type { AuthUser } from '../middleware.js';
import type { DatabaseService } from '../../core/database.js';
import type { EncryptionService } from '../../core/encryption.js';
import type { RuntimeRegistry } from '../../runtime/index.js';
import type { DevContainerRuntime } from '../../runtime/devcontainer.js';
import type { WorkspaceRow } from '../../runtime/workspace-manager.js';
import { config } from '../../config/env.js';

// ─── Access Control ─────────────────────────────────────────

function canAccessWorkspace(user: AuthUser, workspace: WorkspaceRow): boolean {
  if (user.roles.includes('admin')) return true;
  if (workspace.owner_id === user.id) return true;

  switch (workspace.visibility) {
    case 'public':
      return true;
    case 'team':
      return workspace.team_id != null && user.teams.includes(workspace.team_id);
    case 'private':
    default:
      return false;
  }
}

// ─── Header Injection ───────────────────────────────────────

function buildProxyHeaders(incoming: Headers, user: AuthUser): Headers {
  const headers = new Headers(incoming);

  // Strip any spoofed X-Tela-* headers from the client
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase().startsWith('x-tela-')) {
      headers.delete(key);
    }
  }

  // Inject identity headers
  headers.set('X-Tela-User-Id', user.id);
  headers.set('X-Tela-User-Email', user.email);
  if (user.name) headers.set('X-Tela-User-Name', user.name);
  headers.set('X-Tela-User-Roles', user.roles.join(','));
  headers.set('X-Tela-User-Teams', user.teams.join(','));

  // Remove hop-by-hop headers that shouldn't be forwarded
  headers.delete('host');
  headers.delete('connection');
  headers.delete('keep-alive');
  headers.delete('transfer-encoding');

  return headers;
}

// ─── Path Utilities ─────────────────────────────────────────

interface ResolvedTarget {
  hostPort: number;
  subpath: string;
}

/**
 * Parse the path after /apps/:workspaceId to resolve the target port and subpath.
 *
 * /apps/:id/...           → default port (first mapping), subpath = /...
 * /apps/:id/_port/3000/...→ explicit port 3000, subpath = /...
 */
function resolveTarget(
  path: string,
  workspaceId: string,
  portMappings: { containerPort: number; hostPort: number; url: string }[],
): ResolvedTarget | null {
  if (portMappings.length === 0) return null;

  // Strip /apps/:workspaceId prefix
  const prefix = `/apps/${workspaceId}`;
  let remainder = path.startsWith(prefix) ? path.slice(prefix.length) : path;

  // Check for explicit port: /_port/:containerPort/...
  const portMatch = remainder.match(/^\/_port\/(\d+)(\/.*)?$/);
  if (portMatch) {
    const containerPort = parseInt(portMatch[1], 10);
    const mapping = portMappings.find(m => m.containerPort === containerPort);
    if (!mapping) return null;
    return { hostPort: mapping.hostPort, subpath: portMatch[2] || '/' };
  }

  // Default: use first exposed port
  return { hostPort: portMappings[0].hostPort, subpath: remainder || '/' };
}

// ─── HTTP Proxy ─────────────────────────────────────────────

async function proxyRequest(req: Request, targetUrl: string, headers: Headers): Promise<Response> {
  // Build the outgoing request
  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: 'manual', // Don't follow redirects — pass them through
  };

  // Forward body for non-GET/HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    init.body = req.body;
    (init as any).duplex = 'half'; // Required for streaming request bodies
  }

  try {
    const upstream = await fetch(targetUrl, init);

    // Build response headers, stripping hop-by-hop
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('connection');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'upstream_unavailable', message: 'The application is not responding' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ─── Route Factory ──────────────────────────────────────────

export interface AppProxyDeps {
  db: DatabaseService;
  runtimeRegistry?: RuntimeRegistry;
  encryption?: EncryptionService;
}

export function appProxyRoutes(deps: AppProxyDeps) {
  const app = new Hono();

  app.all('/apps/:workspaceId/*', async (c) => {
    return handleAppProxy(c, deps);
  });

  // Handle /apps/:workspaceId without trailing slash
  app.all('/apps/:workspaceId', async (c) => {
    return handleAppProxy(c, deps);
  });

  return app;
}

// ─── /__tela/* Reserved Endpoints ────────────────────────────

async function handleTelaEndpoint(
  subpath: string,
  user: AuthUser,
  workspace: WorkspaceRow,
  deps: AppProxyDeps,
): Promise<Response> {
  const endpoint = subpath.replace('/__tela/', '').split('?')[0];

  switch (endpoint) {
    case 'me': {
      return Response.json({
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        teams: user.teams,
      });
    }

    case 'token': {
      // Mint a short-lived JWT for InsForge/Supabase RLS
      if (!workspace.jwt_secret) {
        return Response.json({ error: 'no_jwt_secret', message: 'Workspace JWT secret not configured' }, { status: 500 });
      }

      // Decrypt the per-workspace secret
      let secretHex: string;
      try {
        secretHex = deps.encryption
          ? deps.encryption.decrypt(workspace.jwt_secret)
          : workspace.jwt_secret;
      } catch {
        return Response.json({ error: 'jwt_secret_error', message: 'Failed to decrypt JWT secret' }, { status: 500 });
      }

      const secret = new TextEncoder().encode(secretHex);
      const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes

      const token = await new SignJWT({
        sub: user.id,
        email: user.email,
        roles: user.roles,
        workspace_id: workspace.id,
        aud: 'authenticated',     // Supabase convention
        role: 'authenticated',    // Supabase convention
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('tela')
        .setExpirationTime('5m')
        .sign(secret);

      return Response.json({ token, expires_at: expiresAt });
    }

    case 'logout': {
      return Response.redirect('/', 302);
    }

    default:
      return Response.json({ error: 'not_found', message: `Unknown /__tela/ endpoint: ${endpoint}` }, { status: 404 });
  }
}

// ─── MIME Types ─────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.webp': 'image/webp',
  '.txt':  'text/plain',
  '.xml':  'application/xml',
  '.webmanifest': 'application/manifest+json',
};

function mimeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// ─── Static File Serving ─────────────────────────────────────

/**
 * Serve a static file from the workspace volume.
 * Falls back to index.html for SPA routing (any path that doesn't match a real file).
 *
 * HTML files are rewritten on-the-fly: absolute asset paths like /assets/foo.js are
 * prefixed with the app base (/apps/{workspaceId}) so Vite-built SPAs work correctly
 * when served under a subpath.
 */
async function serveStaticFile(
  subpath: string,
  volumePath: string,
  staticAppPath: string,
  workspaceId: string,
  user: AuthUser,
  workspace: WorkspaceRow,
  deps: AppProxyDeps,
): Promise<Response | null> {
  const root = join(volumePath, staticAppPath);
  const base = `/apps/${workspaceId}`;

  // Strip query string from subpath for file resolution
  const filePath = subpath.split('?')[0] || '/';

  // Resolve candidate file path (prevent path traversal)
  const candidate = join(root, filePath);
  if (!candidate.startsWith(root)) {
    return new Response('Forbidden', { status: 403 });
  }

  const tryServe = (absPath: string): Response | null => {
    try {
      const stat = statSync(absPath);
      if (!stat.isFile()) return null;
      const mime = mimeFor(absPath);

      // For HTML files: rewrite absolute asset paths to be relative to the app base.
      // Vite builds with src="/assets/..." and href="/assets/..." which break under a subpath.
      if (mime.startsWith('text/html')) {
        let html = readFileSync(absPath, 'utf8');
        // Rewrite absolute paths: src="/ → src="{base}/ (skip protocol-relative //... and http/https)
        // Rewrite absolute paths that don't already have the correct base prefix.
        // Skip protocol-relative (//) and already-prefixed (/apps/...) paths.
        html = html.replace(/(src|href|action|content)="\/(?!\/|apps\/)/g, `$1="${base}/`);
        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' },
        });
      }

      const stream = createReadStream(absPath);
      const webStream = Readable.toWeb(stream) as ReadableStream;
      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(stat.size),
          'Cache-Control': absPath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      });
    } catch {
      return null;
    }
  };

  // Audit log (fire and forget)
  try {
    deps.db.logAudit(
      null, 'app_proxy_access',
      { user_id: user.id, workspace_id: workspace.id, path: filePath, method: 'GET', static: true },
      'app-proxy',
    );
  } catch { /* non-critical */ }

  // Try exact file, then index.html suffix, then SPA fallback
  return (
    tryServe(candidate) ??
    tryServe(join(candidate, 'index.html')) ??
    null  // caller handles container fallback + SPA fallback
  );
}

// ─── InsForge Pass-through Proxy ─────────────────────────────
//
// Apps access InsForge at /__insforge/* — Tela injects the API key server-side
// so the browser never needs to know the internal InsForge URL or credentials.

export async function insforgeProxyHandler(subpath: string, req: Request, user?: AuthUser): Promise<Response> {
  return proxyInsforge(subpath, req, user);
}

async function proxyInsforge(subpath: string, req: Request, user?: AuthUser): Promise<Response> {
  const insforgeRuntimeBase = (config.insforgeRuntimeUrl ?? config.insforgeApiUrl)?.replace('host.docker.internal', 'localhost');
  if (!insforgeRuntimeBase) {
    return new Response(JSON.stringify({ error: 'InsForge is not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Strip /__insforge prefix and forward to InsForge Deno runtime
  // Also normalise legacy /functions/v1/{slug}/... → /{slug}/... paths
  let upstreamPath = subpath.replace(/^\/__insforge/, '') || '/';
  upstreamPath = upstreamPath.replace(/^\/functions\/v1\//, '/');
  const url = new URL(req.url);
  const targetUrl = `${insforgeRuntimeBase}${upstreamPath}${url.search}`;

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  // Disable compression — Node fetch auto-decompresses, which breaks re-streaming to the browser
  headers.delete('accept-encoding');
  // Inject server-side API key — browser never sees it
  if (config.insforgeApiKey) headers.set('x-api-key', config.insforgeApiKey);
  // Inject caller identity so InsForge functions can implement per-user logic
  if (user) {
    headers.set('x-tela-user-id', user.id);
    headers.set('x-tela-user-email', user.email);
    if (user.name) headers.set('x-tela-user-name', user.name);
    headers.set('x-tela-user-roles', user.roles.join(','));
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      ...(req.body ? { duplex: 'half' } as any : {}),
    });
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('connection');
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    // Allow the browser to read the response (CORS not needed since same origin via proxy)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return new Response(JSON.stringify({ error: 'InsForge unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ─── Main Proxy Handler ─────────────────────────────────────

async function handleAppProxy(c: Context, deps: AppProxyDeps): Promise<Response> {
  const user = c.get('user') as AuthUser | undefined;
  if (!user) {
    return c.json({ error: 'unauthorized', message: 'Authentication required to access this application' }, 401);
  }

  const workspaceId = c.req.param('workspaceId')!;
  const workspace = deps.db.getWorkspace(workspaceId);

  if (!workspace || workspace.status === 'destroyed') {
    return c.json({ error: 'not_found', message: 'Application not found' }, 404);
  }

  // RBAC access check
  if (!canAccessWorkspace(user, workspace)) {
    return c.json({ error: 'forbidden', message: 'You do not have access to this application' }, 403);
  }

  const url = new URL(c.req.url);
  const prefix = `/apps/${workspaceId}`;
  const subpath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) || '/' : c.req.path;

  // /__tela/* and /__insforge/* are always handled locally regardless of mode
  if (subpath.startsWith('/__tela/')) return handleTelaEndpoint(subpath, user, workspace, deps);
  if (subpath.startsWith('/__insforge')) return proxyInsforge(subpath, c.req.raw, user);

  // ── PRIORITY: live dev server (container running with port mappings) ────────
  // When a session container is running, ALWAYS proxy to it — even if a static
  // deploy exists. The dev server is authoritative during active development.
  if (workspace.status === 'running') {
    const portMappings: { containerPort: number; hostPort: number; url: string }[] = JSON.parse(workspace.port_mappings);
    const target = resolveTarget(c.req.path, workspaceId, portMappings);
    if (target) {
      const headers = buildProxyHeaders(c.req.raw.headers, user);
      const targetUrl = `http://127.0.0.1:${target.hostPort}${target.subpath}${url.search}`;
      return proxyRequest(c.req.raw, targetUrl, headers);
    }
  }

  // ── FALLBACK: static deploy (persists after container stops) ────────────────
  if (workspace.static_app_path) {
    // 1. Try exact static file
    const staticResponse = await serveStaticFile(
      subpath + url.search,
      workspace.volume_name,
      workspace.static_app_path,
      workspaceId,
      user,
      workspace,
      deps,
    );
    if (staticResponse) return staticResponse;

    // 2. SPA fallback — index.html for client-side routes
    const root = join(workspace.volume_name, workspace.static_app_path);
    const indexPath = join(root, 'index.html');
    try {
      const stat = statSync(indexPath);
      if (stat.isFile()) {
        let html = readFileSync(indexPath, 'utf8');
        html = html.replace(/(src|href|action|content)="\/(?!\/|apps\/)/g, `$1="/apps/${workspaceId}/`);
        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      }
    } catch { /* index.html missing */ }
  }

  return c.json({ error: 'no_port', message: 'No exposed port available for this application' }, 502);
}
