import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { WorkspaceManager } from '../runtime/workspace-manager.js';

/**
 * Build an SDK MCP server that exposes workspace management tools to container agents.
 *
 * The primary tool is `serve_workspace_app`: the agent points it at a build output
 * directory and Tela serves those static files directly from the workspace volume —
 * no running server process required, persists across container restarts.
 */
export function buildWorkspaceToolsMcpServer(workspaceId: string, workspaceManager: WorkspaceManager) {
  const serveApp = tool(
    'serve_workspace_app',
    [
      'Register a frontend app to be served by Tela via the RBAC-protected /apps/{id}/ URL.',
      'Two modes: (1) LIVE PREVIEW — pass only api_port (e.g. 5173) to proxy an already-running dev server.',
      '(2) STATIC DEPLOY — pass directory (e.g. "dist") to serve built static files directly from disk; persists after container dies.',
      '(3) BOTH — pass directory + api_port to register static files and proxy a backend API at the same time.',
      'The backend/dev server must already be running in the container on the given port.',
      'Allowed ports: 3000, 3001, 4000, 5173, 8000, 8080.',
      'Supports SPA routing: unmatched paths fall back to index.html.',
      'Returns the RBAC-protected URL.',
    ].join(' '),
    {
      directory: z.string().optional().describe(
        'Path to built static files. Absolute (/workspace/myapp/dist) or relative to /workspace (myapp/dist). Omit when doing live preview only (api_port only).',
      ),
      api_port: z.number().int().optional().describe(
        'Container port a running dev/backend server is listening on (e.g. 5173, 3001). For live preview, pass the Vite dev server port. For static-only deploys, omit this.',
      ),
    },
    async ({ directory, api_port }: { directory?: string; api_port?: number }) => {
      try {
        if (!directory && api_port === undefined) {
          return {
            content: [{ type: 'text' as const, text: 'Error: at least one of directory or api_port must be provided.' }],
            isError: true,
          };
        }

        let url: string | undefined;

        if (directory !== undefined) {
          url = workspaceManager.setStaticApp(workspaceId, directory);
        } else if (api_port !== undefined) {
          // Live preview only (no directory) — clear any stale static deploy so the
          // proxy routes to the live dev server instead of old built files.
          workspaceManager.clearStaticApp(workspaceId);
        }

        if (api_port !== undefined) {
          const result = await workspaceManager.exposePort(workspaceId, api_port);
          url = url ?? result.url;
        }

        const lines = [
          `App registered successfully!`,
          ``,
          `URL: ${url}`,
          ``,
        ];

        if (directory !== undefined && api_port !== undefined) {
          lines.push(`Static files served from: ${directory}`);
          lines.push(`Live port ${api_port} proxied through the app URL.`);
        } else if (directory !== undefined) {
          lines.push(`Static files served from disk — persists across container restarts.`);
        } else {
          lines.push(`Live preview: port ${api_port} proxied through the app URL.`);
          lines.push(`Changes are visible immediately. Call again with directory when ready for a permanent deploy.`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n'),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error registering app: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  return createSdkMcpServer({
    name: 'workspace-tools',
    version: '1.0.0',
    tools: [serveApp],
  });
}
