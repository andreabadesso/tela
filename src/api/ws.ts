import { WebSocketServer, WebSocket } from 'ws';
import net from 'node:net';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ApiDeps } from './server.js';
import { resolveUserFromToken, type AuthUser } from './middleware.js';
import type { DevContainerRuntime } from '../runtime/devcontainer.js';

const API_TOKEN = process.env.API_TOKEN;

export function setupWebSocket(server: Server, deps: ApiDeps) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

    // ─── App Proxy WebSocket (for HMR, real-time apps) ───────────
    if (url.pathname.startsWith('/apps/')) {
      await handleAppProxyUpgrade(request, socket, head, url, deps);
      return;
    }

    if (url.pathname !== '/api/chat/stream') {
      socket.destroy();
      return;
    }

    // Auth check: query param token → cookie → dev mode
    const token = url.searchParams.get('token') ?? parseBearer(request.headers.authorization);
    const sessionCookie = parseCookie(request.headers.cookie, 'session_token');
    const auth = deps.auth ?? null;

    // Try token auth first
    let user: AuthUser | null = null;
    if (token) {
      user = await resolveUserFromToken(auth, token);
    }

    // Try session cookie
    if (!user && sessionCookie) {
      user = await resolveUserFromToken(auth, sessionCookie);
    }

    // Dev mode: no API_TOKEN and no auth → open access
    if (!user && !API_TOKEN && !auth) {
      user = {
        id: 'dev',
        email: 'dev@tela.local',
        name: 'Developer',
        roles: ['admin'],
        teams: [],
      };
    }

    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, user);
    });
  });

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, user?: AuthUser) => {
    ws.on('message', async (data) => {
      let parsed: { text: string; agentId?: string };
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', data: 'Invalid JSON' }));
        return;
      }

      if (!parsed.text) {
        ws.send(JSON.stringify({ type: 'error', data: 'Missing "text" field' }));
        return;
      }

      // Send thinking indicator
      ws.send(JSON.stringify({ type: 'thinking', data: null }));

      try {
        const startTime = Date.now();
        let response;

        const metadata: Record<string, unknown> = {};
        if (parsed.agentId) metadata.agentId = parsed.agentId;
        if (user) metadata.userId = user.id;

        const userId = user?.id;

        // If orchestrator is available, use it for routing
        if (deps.orchestrator) {
          response = await deps.orchestrator.chat({
            text: parsed.text,
            source: 'web',
            userId,
            metadata,
          });
        } else {
          const agents = deps.db.getAgents();
          const agentId = parsed.agentId ?? agents.find((a) => a.enabled)?.id ?? '';
          response = await deps.agentService.process(agentId, {
            text: parsed.text,
            source: 'web',
            userId,
          });
        }

        ws.send(JSON.stringify({
          type: 'text',
          data: response.text,
        }));

        if (response.toolCalls?.length) {
          ws.send(JSON.stringify({
            type: 'tool_calls',
            data: response.toolCalls,
          }));
        }

        ws.send(JSON.stringify({
          type: 'done',
          data: { durationMs: Date.now() - startTime },
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'error',
          data: err instanceof Error ? err.message : 'Unknown error',
        }));
      }
    });
  });

  return wss;
}

/**
 * Handle WebSocket upgrade for /apps/:workspaceId/* paths.
 * Authenticates the user, checks workspace access, then pipes
 * the raw TCP connection to the container's mapped port.
 * Required for HMR (Vite, Next.js dev servers) and real-time apps.
 */
async function handleAppProxyUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  deps: ApiDeps,
): Promise<void> {
  // Authenticate
  const token = url.searchParams.get('token') ?? parseBearer(request.headers.authorization);
  const sessionCookie = parseCookie(request.headers.cookie, 'session_token');
  const auth = deps.auth ?? null;

  let user: AuthUser | null = null;
  if (token) user = await resolveUserFromToken(auth, token);
  if (!user && sessionCookie) user = await resolveUserFromToken(auth, sessionCookie);
  if (!user && !API_TOKEN && !auth) {
    user = { id: 'dev', email: 'dev@tela.local', name: 'Developer', roles: ['admin'], teams: [] };
  }

  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Parse workspace ID from path: /apps/:workspaceId/...
  const pathParts = url.pathname.split('/');
  const workspaceId = pathParts[2];
  if (!workspaceId) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const workspace = deps.db.getWorkspace(workspaceId);
  if (!workspace || workspace.status !== 'running') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // RBAC check
  const isAdmin = user.roles.includes('admin');
  const isOwner = workspace.owner_id === user.id;
  const isTeamMember = workspace.visibility === 'team' && workspace.team_id != null && user.teams.includes(workspace.team_id);
  const isPublic = workspace.visibility === 'public';

  if (!isAdmin && !isOwner && !isTeamMember && !isPublic) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Resolve target port
  const portMappings: { containerPort: number; hostPort: number; url: string }[] = JSON.parse(workspace.port_mappings);
  if (portMappings.length === 0) {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
    return;
  }

  // Check for explicit port: /apps/:id/_port/:containerPort/...
  let targetHostPort = portMappings[0].hostPort;
  if (pathParts[3] === '_port' && pathParts[4]) {
    const containerPort = parseInt(pathParts[4], 10);
    const mapping = portMappings.find(m => m.containerPort === containerPort);
    if (mapping) targetHostPort = mapping.hostPort;
  }

  // Reconstruct the path for the upstream (strip /apps/:workspaceId prefix)
  const prefixLength = pathParts[3] === '_port' ? 5 : 3; // skip /apps/:id or /apps/:id/_port/:port
  const upstreamPath = '/' + pathParts.slice(prefixLength).join('/');
  const upstreamUrl = `${upstreamPath}${url.search}`;

  // Pipe raw TCP: forward the original HTTP upgrade request to the container
  const upstream = net.createConnection({ host: '127.0.0.1', port: targetHostPort }, () => {
    // Reconstruct the HTTP upgrade request line + headers
    const reqLine = `${request.method} ${upstreamUrl} HTTP/${request.httpVersion}\r\n`;
    const headers = Object.entries(request.headers)
      .filter(([key]) => !key.toLowerCase().startsWith('x-tela-'))
      .map(([key, val]) => `${key}: ${Array.isArray(val) ? val.join(', ') : val}`)
      .join('\r\n');

    // Add identity headers
    const telaHeaders = [
      `X-Tela-User-Id: ${user!.id}`,
      `X-Tela-User-Email: ${user!.email}`,
      ...(user!.name ? [`X-Tela-User-Name: ${user!.name}`] : []),
      `X-Tela-User-Roles: ${user!.roles.join(',')}`,
    ].join('\r\n');

    upstream.write(`${reqLine}${headers}\r\n${telaHeaders}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);

    // Bidirectional pipe
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
  });

  socket.on('error', () => upstream.destroy());
}

function parseBearer(header?: string): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return match ? match.split('=')[1] : null;
}
