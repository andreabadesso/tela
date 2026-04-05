/**
 * InsForge MCP Bridge — wraps the InsForge stdio MCP server as an SDK MCP server.
 *
 * Problem: The Claude Agent SDK passes `type: "stdio"` MCP configs to Claude Code
 * via --mcp-config. Claude Code then tries to spawn the stdio server itself.
 * When using spawnClaudeCodeProcess (container exec), Claude Code runs INSIDE the
 * container where host paths don't exist → MCP fails silently.
 *
 * Solution: We spawn the InsForge MCP server on the host as a child process,
 * discover its tools via JSON-RPC, and re-expose them as an SDK MCP server
 * (type: "sdk") which gets proxied through IPC correctly.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface InsForgeConnection {
  child: ChildProcess;
  rl: Interface;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextId: number;
}

async function startInsForgeProcess(apiBaseUrl: string, apiKey?: string): Promise<InsForgeConnection> {
  const mcpEntry = join(__dirname, '..', '..', 'node_modules', '@insforge', 'mcp', 'dist', 'index.js');

  const args = [mcpEntry, '--api_base_url', apiBaseUrl];
  if (apiKey) args.push('--api_key', apiKey);

  const child = spawn('node', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Discard stderr (startup banners go there via our awareness, but the raw MCP also dumps to stdout)
  child.stderr?.on('data', () => {});

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  rl.on('line', (line) => {
    if (!line.startsWith('{')) return; // Skip non-JSON banner lines
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
    } catch {
      // Ignore parse errors
    }
  });

  child.on('error', (err) => {
    console.error(`[insforge-bridge] Process error:`, err.message);
  });

  const conn: InsForgeConnection = { child, rl, pending, nextId: 1 };

  // Initialize the MCP server
  await sendRequest(conn, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tela-bridge', version: '1.0' },
  });

  return conn;
}

function sendRequest(conn: InsForgeConnection, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = conn.nextId++;
    conn.pending.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    conn.child.stdin!.write(msg);

    // Timeout after 30 seconds
    setTimeout(() => {
      if (conn.pending.has(id)) {
        conn.pending.delete(id);
        reject(new Error(`InsForge MCP request timed out: ${method}`));
      }
    }, 30_000);
  });
}

async function discoverTools(conn: InsForgeConnection): Promise<McpTool[]> {
  const result = await sendRequest(conn, 'tools/list', {}) as { tools: McpTool[] };
  return result.tools;
}

async function callTool(conn: InsForgeConnection, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await sendRequest(conn, 'tools/call', { name, arguments: args });
  return result;
}

/**
 * Rewrite /workspace paths in tool arguments to the host-side bind mount path.
 * This is necessary because InsForge runs on the host and needs host-accessible paths
 * (e.g., for create-deployment which reads source files from the filesystem).
 */
function rewriteWorkspacePaths(args: Record<string, unknown>, workspaceHostPath: string): Record<string, unknown> {
  const rewritten = { ...args };
  for (const [key, value] of Object.entries(rewritten)) {
    if (typeof value === 'string' && value.startsWith('/workspace')) {
      rewritten[key] = value.replace('/workspace', workspaceHostPath);
    }
  }
  return rewritten;
}

/**
 * Build an SDK MCP server that proxies all InsForge tools.
 * Returns null if InsForge is not configured.
 *
 * @param workspaceHostPath — host-side path that maps to /workspace inside the container.
 *   When provided, any tool args containing /workspace paths are rewritten to the host path.
 *   This is critical for create-deployment which reads source files from the host filesystem.
 */
export async function buildInsforgeMcpServer(apiBaseUrl: string, apiKey?: string, workspaceHostPath?: string) {
  try {
    const conn = await startInsForgeProcess(apiBaseUrl, apiKey);
    const mcpTools = await discoverTools(conn);

    console.log(`[insforge-bridge] Connected! ${mcpTools.length} tools: ${mcpTools.map(t => t.name).join(', ')}`);

    // Build Zod schemas from each tool's JSON Schema properties
    const sdkTools = mcpTools.map((t) => {
      const props = (t.inputSchema as any)?.properties ?? {};
      const zodShape: Record<string, z.ZodTypeAny> = {};
      const required = new Set<string>((t.inputSchema as any)?.required ?? []);

      for (const [key, schemaDef] of Object.entries(props)) {
        const s = schemaDef as any;
        let field: z.ZodTypeAny;
        if (s.type === 'number') field = z.number();
        else if (s.type === 'boolean') field = z.boolean();
        else if (s.type === 'array') field = z.array(z.any());
        else if (s.type === 'object') field = z.record(z.any());
        else if (s.enum) field = z.enum(s.enum as [string, ...string[]]);
        else field = z.string();

        if (s.description) field = field.describe(s.description);
        if (!required.has(key)) field = field.optional();
        zodShape[key] = field;
      }

      // Fallback: if no properties defined, accept a generic input
      if (Object.keys(zodShape).length === 0) {
        zodShape['input'] = z.string().optional().describe('JSON input');
      }

      return tool(
        t.name,
        t.description,
        zodShape,
        async (args: Record<string, unknown>) => {
          try {
            // Rewrite /workspace paths to host paths for tools that access the filesystem
            const effectiveArgs = workspaceHostPath ? rewriteWorkspacePaths(args, workspaceHostPath) : args;
            const result = await callTool(conn, t.name, effectiveArgs) as any;
            // MCP tool results have a `content` array
            if (result?.content) {
              return { content: result.content };
            }
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Provide a clear error for deployment failures so the agent doesn't try workarounds
            const isDeployTool = t.name === 'create-deployment' || t.name === 'start-deployment';
            const hint = isDeployTool
              ? ' This is a server-side InsForge configuration issue. Report this error to the user and do NOT attempt alternative deployment methods (vite preview, Vercel CLI, etc.).'
              : '';
            return { content: [{ type: 'text' as const, text: `Error: ${msg}${hint}` }], isError: true };
          }
        },
      );
    });

    return createSdkMcpServer({ name: 'insforge', version: '1.0.0', tools: sdkTools });
  } catch (err) {
    console.error(`[insforge-bridge] Failed to start:`, err instanceof Error ? err.message : err);
    return null;
  }
}
