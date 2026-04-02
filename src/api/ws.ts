import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { ApiDeps } from './server.js';
import { resolveUserFromToken, type AuthUser } from './middleware.js';

const API_TOKEN = process.env.API_TOKEN;

export function setupWebSocket(server: Server, deps: ApiDeps) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

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

function parseBearer(header?: string): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return match ? match.split('=')[1] : null;
}
