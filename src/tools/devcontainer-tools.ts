import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { DevContainerSandbox } from '../runtime/devcontainer-sandbox.js';

/**
 * Build an MCP server with rich coding tools for the DevContainer runtime.
 * These tools give the agent full filesystem, terminal, process, and port management.
 */
export function buildDevContainerMcpServer(sandbox: DevContainerSandbox) {
  const tools = [
    // ─── Filesystem ──────────────────────────────────────────

    tool('write_file', 'Write or create a file in the workspace. Creates parent directories automatically.', {
      path: z.string().describe('Relative path from /workspace (e.g., "src/index.ts")'),
      content: z.string().describe('File content to write'),
    }, async (args) => {
      // Ensure parent directory exists
      const dir = args.path.split('/').slice(0, -1).join('/');
      if (dir) await sandbox.mkdir(dir, true);
      await sandbox.writeFile(args.path, new TextEncoder().encode(args.content));
      return { content: [{ type: 'text' as const, text: `Written: ${args.path}` }] };
    }),

    tool('read_file', 'Read a file from the workspace.', {
      path: z.string().describe('Relative path from /workspace'),
    }, async (args) => {
      const bytes = await sandbox.readFile(args.path);
      const text = new TextDecoder().decode(bytes);
      return { content: [{ type: 'text' as const, text }] };
    }),

    tool('list_directory', 'List files and directories in a workspace path.', {
      path: z.string().optional().describe('Directory path (default: workspace root)'),
    }, async (args) => {
      const entries = await sandbox.ls(args.path ?? '.');
      const formatted = entries.map(e => {
        const prefix = e.type === 'directory' ? '📁 ' : '  ';
        return `${prefix}${e.name}${e.type === 'directory' ? '/' : ''} (${e.size}b)`;
      }).join('\n');
      return { content: [{ type: 'text' as const, text: formatted || '(empty directory)' }] };
    }),

    tool('create_directory', 'Create a directory (including parent directories).', {
      path: z.string().describe('Directory path to create'),
    }, async (args) => {
      await sandbox.mkdir(args.path, true);
      return { content: [{ type: 'text' as const, text: `Created: ${args.path}/` }] };
    }),

    tool('delete_path', 'Delete a file or directory from the workspace.', {
      path: z.string().describe('Path to delete'),
      recursive: z.boolean().optional().describe('Delete directories recursively (default: false)'),
    }, async (args) => {
      await sandbox.rm(args.path, args.recursive ?? false);
      return { content: [{ type: 'text' as const, text: `Deleted: ${args.path}` }] };
    }),

    tool('find_files', 'Find files matching a pattern in the workspace.', {
      pattern: z.string().describe('Glob pattern (e.g., "*.ts", "src/**/*.tsx")'),
      directory: z.string().optional().describe('Directory to search in'),
    }, async (args) => {
      const files = await sandbox.glob(args.pattern, args.directory);
      return { content: [{ type: 'text' as const, text: files.join('\n') || '(no matches)' }] };
    }),

    // ─── Terminal ────────────────────────────────────────────

    tool('run_command', 'Execute a shell command in the workspace. Use for: npm install, builds, tests, git, etc.', {
      command: z.string().describe('Shell command to execute'),
      working_directory: z.string().optional().describe('Working directory relative to /workspace'),
      timeout_ms: z.number().optional().describe('Timeout in milliseconds (default: 120000)'),
    }, async (args) => {
      const result = await sandbox.exec(args.command, {
        cwd: args.working_directory,
        timeout: args.timeout_ms ?? 120_000,
      });
      const output = [
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
        `exit code: ${result.exitCode}`,
      ].filter(Boolean).join('\n\n');
      return { content: [{ type: 'text' as const, text: output }] };
    }),

    tool('start_process', 'Start a long-running background process (e.g., dev server). Returns a PID for later management.', {
      command: z.string().describe('Command to run in background (e.g., "npm run dev")'),
      working_directory: z.string().optional().describe('Working directory'),
    }, async (args) => {
      const { pid } = await sandbox.execBackground(args.command, { cwd: args.working_directory });
      return { content: [{ type: 'text' as const, text: `Started background process (PID: ${pid}): ${args.command}` }] };
    }),

    tool('stop_process', 'Stop a background process by PID.', {
      pid: z.string().describe('Process ID to kill'),
    }, async (args) => {
      await sandbox.killProcess(args.pid);
      return { content: [{ type: 'text' as const, text: `Stopped process ${args.pid}` }] };
    }),

    tool('list_processes', 'List running processes in the workspace container.', {}, async () => {
      const processes = await sandbox.listProcesses();
      if (processes.length === 0) {
        return { content: [{ type: 'text' as const, text: '(no processes running)' }] };
      }
      const formatted = processes.map(p => `PID ${p.pid}: ${p.command}`).join('\n');
      return { content: [{ type: 'text' as const, text: formatted }] };
    }),

    // ─── Port Management ────────────────────────────────────

    tool('expose_port', 'Expose a container port to make a service accessible from the host. Returns the external URL.', {
      port: z.number().describe('Container port to expose (e.g., 3000, 5173, 8080)'),
    }, async (args) => {
      const { hostPort, url } = await sandbox.exposePort(args.port);
      return { content: [{ type: 'text' as const, text: `Port ${args.port} exposed → ${url} (host port: ${hostPort})` }] };
    }),

    // ─── Git ────────────────────────────────────────────────

    tool('git_init', 'Initialize a git repository in the workspace.', {}, async () => {
      const result = await sandbox.exec('git init && git add -A && git commit -m "Initial commit" --allow-empty');
      return { content: [{ type: 'text' as const, text: result.stdout || 'Git repository initialized.' }] };
    }),

    tool('git_status', 'Show git status of the workspace.', {}, async () => {
      const result = await sandbox.exec('git status');
      return { content: [{ type: 'text' as const, text: result.stdout }] };
    }),

    tool('git_commit', 'Stage all changes and create a commit.', {
      message: z.string().describe('Commit message'),
    }, async (args) => {
      const result = await sandbox.exec(`git add -A && git commit -m ${JSON.stringify(args.message)}`);
      return { content: [{ type: 'text' as const, text: result.stdout || result.stderr }] };
    }),

    // ─── Project Scaffolding ────────────────────────────────

    tool('scaffold_project', 'Create a new project from a template. Supports: react-ts, node-api, next, vite.', {
      template: z.enum(['react-ts', 'node-api', 'next', 'vite']).describe('Project template'),
      name: z.string().describe('Project name / directory name'),
    }, async (args) => {
      let cmd: string;
      switch (args.template) {
        case 'react-ts':
          cmd = `npx --yes create-vite ${args.name} --template react-ts`;
          break;
        case 'node-api':
          cmd = `mkdir -p ${args.name} && cd ${args.name} && npm init -y && npm install express`;
          break;
        case 'next':
          cmd = `npx --yes create-next-app@latest ${args.name} --typescript --tailwind --eslint --app --no-src-dir --import-alias "@/*"`;
          break;
        case 'vite':
          cmd = `npx --yes create-vite ${args.name} --template vanilla-ts`;
          break;
      }
      const result = await sandbox.exec(cmd, { timeout: 120_000 });
      return { content: [{ type: 'text' as const, text: result.stdout || `Project "${args.name}" created with template "${args.template}".` }] };
    }),
  ];

  return createSdkMcpServer({
    name: 'devcontainer-tools',
    version: '1.0.0',
    tools,
  });
}
