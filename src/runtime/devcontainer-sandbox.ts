import type { ToolSandbox } from '../types/runtime.js';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
}

export interface ProcessInfo {
  pid: string;
  command: string;
  running: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Enhanced sandbox for DevContainer runtime.
 * Extends the base ToolSandbox with full filesystem, process management, and port control.
 * All operations execute inside the Docker container via `docker exec`.
 */
export class DevContainerSandbox implements ToolSandbox {
  private docker: any;
  private containerId: string;
  private backgroundProcesses = new Map<string, { command: string }>();
  private exposePortFn: (containerPort: number) => Promise<{ hostPort: number; url: string }>;

  constructor(
    docker: any,
    containerId: string,
    exposePortFn: (containerPort: number) => Promise<{ hostPort: number; url: string }>,
  ) {
    this.docker = docker;
    this.containerId = containerId;
    this.exposePortFn = exposePortFn;
  }

  // ─── Base ToolSandbox ─────────────────────────────────────

  async runCommand(command: string): Promise<ExecResult> {
    return this.exec(command);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const result = await this.execRaw(['cat', path]);
    return new TextEncoder().encode(result.stdout);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(content);
    // Use heredoc to avoid escaping issues
    const cmd = `cat > ${shellEscape(path)} << 'TELA_EOF'\n${text}\nTELA_EOF`;
    await this.exec(cmd);
  }

  // ─── Extended Filesystem ──────────────────────────────────

  async mkdir(path: string, recursive = true): Promise<void> {
    const flag = recursive ? '-p' : '';
    await this.exec(`mkdir ${flag} ${shellEscape(path)}`);
  }

  async rm(path: string, recursive = false): Promise<void> {
    const flag = recursive ? '-rf' : '-f';
    await this.exec(`rm ${flag} ${shellEscape(path)}`);
  }

  async ls(path: string): Promise<FileEntry[]> {
    const result = await this.exec(`ls -la ${shellEscape(path)} 2>/dev/null || echo ""`);
    const lines = result.stdout.split('\n').filter(l => l.trim() && !l.startsWith('total'));
    return lines.map(line => {
      const parts = line.split(/\s+/);
      const perms = parts[0] ?? '';
      const size = parseInt(parts[4] ?? '0', 10);
      const name = parts.slice(8).join(' ');
      let type: 'file' | 'directory' | 'symlink' = 'file';
      if (perms.startsWith('d')) type = 'directory';
      else if (perms.startsWith('l')) type = 'symlink';
      return { name, type, size };
    }).filter(e => e.name && e.name !== '.' && e.name !== '..');
  }

  async glob(pattern: string, cwd?: string): Promise<string[]> {
    const cdPrefix = cwd ? `cd ${shellEscape(cwd)} && ` : '';
    const result = await this.exec(`${cdPrefix}find . -path ${shellEscape(pattern)} -type f 2>/dev/null | head -200`);
    return result.stdout.split('\n').filter(l => l.trim());
  }

  // ─── Process Management ───────────────────────────────────

  async exec(command: string, opts?: { cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<ExecResult> {
    const cmdParts = ['bash', '-c'];
    let fullCommand = command;
    if (opts?.cwd) {
      fullCommand = `cd ${shellEscape(opts.cwd)} && ${command}`;
    }
    cmdParts.push(fullCommand);

    const env = opts?.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined;
    return this.execRaw(cmdParts, env, opts?.timeout);
  }

  async execBackground(command: string, opts?: { cwd?: string }): Promise<{ pid: string }> {
    const cdPrefix = opts?.cwd ? `cd ${shellEscape(opts.cwd)} && ` : '';
    // Run in background, redirect output, get PID
    const result = await this.exec(
      `${cdPrefix}nohup bash -c ${shellEscape(command)} > /tmp/bg-$$.log 2>&1 & echo $!`,
    );
    const pid = result.stdout.trim();
    this.backgroundProcesses.set(pid, { command });
    return { pid };
  }

  async killProcess(pid: string): Promise<void> {
    await this.exec(`kill -9 ${pid} 2>/dev/null || true`);
    this.backgroundProcesses.delete(pid);
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    const result = await this.exec('ps aux --no-headers 2>/dev/null || ps aux');
    const lines = result.stdout.split('\n').filter(l => l.trim());

    return lines.map(line => {
      const parts = line.split(/\s+/);
      const pid = parts[1] ?? '0';
      const command = parts.slice(10).join(' ');
      return { pid, command, running: true };
    }).filter(p => !p.command.includes('tail -f /dev/null') && !p.command.includes('ps aux'));
  }

  // ─── Port Management ──────────────────────────────────────

  async exposePort(containerPort: number): Promise<{ hostPort: number; url: string }> {
    return this.exposePortFn(containerPort);
  }

  // ─── Internal ─────────────────────────────────────────────

  private async execRaw(cmd: string[], env?: string[], timeout?: number): Promise<ExecResult> {
    const container = this.docker.getContainer(this.containerId);
    const effectiveTimeout = timeout ?? 120_000; // Default 2 min per command

    const execOpts: any = {
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: '/workspace',
    };
    if (env) execOpts.Env = env;

    const exec = await container.exec(execOpts);
    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise<ExecResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;

      const settle = async () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          const inspect = await exec.inspect();
          resolve({
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
            exitCode: inspect.ExitCode ?? 1,
          });
        } catch {
          resolve({
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
            exitCode: 1,
          });
        }
      };

      // Use dockerode's built-in demuxer via the modem
      const { PassThrough } = require('node:stream');
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();

      stdoutStream.on('data', (chunk: Buffer) => stdout.push(chunk));
      stderrStream.on('data', (chunk: Buffer) => stderr.push(chunk));

      this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          stream.destroy();
          reject(new Error(`Command timed out after ${effectiveTimeout}ms`));
        }
      }, effectiveTimeout);

      // Listen for both 'end' and 'close' — hijacked streams may emit either
      stream.on('end', settle);
      stream.on('close', settle);

      stream.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
