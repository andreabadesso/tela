import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { DatabaseService } from '../core/database.js';
import type { EncryptionService } from '../core/encryption.js';
import type { AgentService } from '../agent/service.js';
import type { GitService } from '../services/git-service.js';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { DevContainerConfig, WorkspaceManager } from './workspace-manager.js';
import { config } from '../config/env.js';

/**
 * ProjectSessionRuntime — persistent container per project for App Builder sessions.
 *
 * Each project gets ONE container that lives across many sessions.
 * The dev server runs continuously inside it. Sessions just `docker exec`
 * into the existing container.
 *
 * Lifecycle:
 * - Project created → container starts once (via ensureProjectReady)
 * - Repo cloned + Claude settings configured once (initializeRepo)
 * - Dev server started once, stays alive via HMR
 * - Each message: docker exec into container, run agent, commit & push
 * - Container paused after 30 min inactivity (processes frozen, port proxy intact)
 * - On next message: container unpaused, Vite resumes where it left off
 */
export class ProjectSessionRuntime {
  private docker: any = null;
  private sessionEmitters = new Map<string, EventEmitter>();
  private inactivityTimers = new Map<string, NodeJS.Timeout>(); // projectId → timer

  constructor(
    private agentService: AgentService,
    private db: DatabaseService,
    private gitService: GitService,
    private containerConfig: DevContainerConfig = {},
    private encryption?: EncryptionService,
    private workspaceManager?: WorkspaceManager,
  ) {}

  /** Subscribe to live agent events for a running session. */
  getSessionEmitter(sessionId: string): EventEmitter | undefined {
    return this.sessionEmitters.get(sessionId);
  }

  private async getDocker() {
    if (!this.docker) {
      const Dockerode = (await import('dockerode')).default;
      this.docker = new Dockerode();
      await this.docker.ping();
    }
    return this.docker;
  }

  /**
   * Run a session for the given project. This is the main entry point.
   * Called asynchronously from the POST /projects/:id/sessions route.
   */
  async runSession(
    sessionId: string,
    projectId: string,
    agentId: string,
    userId: string,
    message: string,
  ): Promise<void> {
    const startedAt = Date.now();

    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    this.sessionEmitters.set(sessionId, emitter);

    this.db.updateProjectSession(sessionId, {
      status: 'running',
      started_at: new Date(startedAt).toISOString(),
    });

    let containerId: string | null = null;
    let workspaceId: string | null = null;

    try {
      // Ensure the project's persistent container is running
      const ready = await this.ensureProjectReady(projectId, agentId, userId);
      containerId = ready.containerId;
      workspaceId = ready.workspaceId;

      this.db.updateProjectSession(sessionId, { container_id: containerId });

      // Reset inactivity timer — session is starting
      this.resetInactivityTimer(projectId, workspaceId);

      // Build project context block for the system prompt (includes previous session history)
      const project = this.db.getProject(projectId)!;
      const workspace = this.db.getWorkspace(workspaceId);
      const projectContext = await this.buildProjectContext(project, workspace, sessionId);

      // Run the agent inside the container
      let resultText = '';
      let agentError: string | null = null;
      const containerExecOptions = {
        spawnClaudeCodeProcess: this.buildContainerSpawn(containerId),
      };

      const inputWithContext = {
        text: message,
        source: 'project-session',
        userId,
        metadata: {
          workspaceId: workspace?.id,
          workspaceHostPath: workspace?.volume_name,
          projectId,
          projectContext,
        },
      };

      for await (const event of this.agentService.processStream(
        agentId,
        inputWithContext,
        containerExecOptions,
      )) {
        emitter.emit('agent_event', event);
        if (event.type === 'result') {
          resultText = event.text;
        } else if (event.type === 'error') {
          agentError = event.message;
        }
      }

      // If the agent errored and produced no output, treat as failure
      if (agentError && !resultText) {
        throw new Error(agentError);
      }

      // Commit and push
      const commitMessage = resultText.slice(0, 72) || 'Session complete';
      const commitSha = await this.commitAndPush(containerId, commitMessage).catch(err => {
        console.warn(`[project-session] git push failed (non-fatal):`, err);
        return null;
      });

      const durationMs = Date.now() - startedAt;
      this.db.updateProjectSession(sessionId, {
        status: 'committed',
        output: resultText,
        commit_sha: commitSha ?? undefined,
        commit_message: commitMessage,
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
      });

      emitter.emit('session_done', { status: 'committed', output: resultText, commitSha });
      console.log(`[project-session] Session ${sessionId} committed (sha: ${commitSha?.slice(0, 7) ?? 'none'})`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt;

      // Attempt best-effort push of partial work
      if (containerId) {
        await this.commitAndPush(containerId, 'Partial work (session failed)').catch(() => {});
      }

      this.db.updateProjectSession(sessionId, {
        status: 'failed',
        error,
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
      });

      emitter.emit('session_done', { status: 'failed', error });
      console.error(`[project-session] Session ${sessionId} failed:`, error);
    } finally {
      this.sessionEmitters.delete(sessionId);
      // Clear session container reference (for cleanup record)
      this.db.updateProjectSession(sessionId, { container_id: null as any });
      // Reset inactivity timer — session ended, start countdown to pause
      if (workspaceId) {
        this.resetInactivityTimer(projectId, workspaceId);
      }
      // DO NOT destroy the container — it persists for the next session
    }
  }

  /**
   * Ensure the project's persistent container is running and repo is initialized.
   * Creates workspace if needed, unpauses if paused, or creates container if new.
   */
  async ensureProjectReady(
    projectId: string,
    agentId: string,
    userId: string,
  ): Promise<{ containerId: string; workspaceId: string }> {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Lazily create workspace if missing
    let workspace = project.workspace_id ? this.db.getWorkspace(project.workspace_id) : null;
    if (!workspace && this.workspaceManager) {
      workspace = await this.workspaceManager.create(
        `project-${project.git_repo_slug}`,
        agentId,
        userId,
      );
      this.db.updateProject(project.id, { workspace_id: workspace!.id });
      console.log(`[project-session] Created workspace ${workspace!.id} for project ${project.id}`);
    }
    if (!workspace) throw new Error('No workspace available and workspaceManager not configured');

    // Use WorkspaceManager.start() to ensure container is running
    // (creates new, unpauses paused, or returns existing running)
    const { containerId } = await this.workspaceManager!.start(workspace.id);

    // Check if repo is initialized (one-time setup per container lifecycle)
    const repoExists = await this.execInContainer(containerId, [
      'bash', '-c', 'test -d /workspace/repo && echo yes || echo no',
    ]);

    if (repoExists.trim() === 'no') {
      await this.initializeRepo(containerId, project);
      await this.tryStartDevServer(containerId, workspace.id);
    } else {
      // Repo exists — try to start dev server if not already running
      await this.tryStartDevServer(containerId, workspace.id);
    }

    return { containerId, workspaceId: workspace.id };
  }

  /**
   * One-time repo setup: clone, configure git identity, configure Claude settings.
   * Replaces the old startContainer setup steps.
   */
  private async initializeRepo(
    containerId: string,
    project: { id: string; git_repo_slug: string },
  ): Promise<void> {
    const cloneUrl = this.gitService.cloneUrl(project.git_repo_slug);

    // Clone the project repo
    await this.execInContainer(containerId, [
      'bash', '-c',
      `mkdir -p /workspace/repo && (git clone ${cloneUrl} /workspace/repo 2>&1 && echo "Cloned OK") || echo "Clone failed — empty repo"`,
    ]);

    // Configure git identity
    await this.execInContainer(containerId, [
      'bash', '-c',
      'git -C /workspace/repo config user.name "Tela App Builder" 2>/dev/null || true; ' +
      'git -C /workspace/repo config user.email "builder@tela.internal" 2>/dev/null || true',
    ]);

    // Configure Claude Code settings (InsForge MCP)
    await this.configureClaudeSettings(containerId);

    console.log(`[project-session] Initialized repo in container ${containerId.slice(0, 12)}`);
  }

  /**
   * Attempt to start the Vite dev server if package.json exists and server is not running.
   * Idempotent — safe to call every session.
   */
  private async tryStartDevServer(containerId: string, workspaceId: string): Promise<void> {
    // Check if package.json exists
    const hasPkg = await this.execInContainer(containerId, [
      'bash', '-c', 'test -f /workspace/repo/package.json && echo yes || echo no',
    ]);
    if (hasPkg.trim() !== 'yes') return; // No app yet, agent will set it up

    // Check if something is already running on 5173
    const isRunning = await this.execInContainer(containerId, [
      'bash', '-c', 'curl -sf http://localhost:5173 > /dev/null 2>&1 && echo yes || echo no',
    ]);
    if (isRunning.trim() === 'yes') {
      // Already running — ensure port proxy is registered
      if (this.workspaceManager) {
        await this.workspaceManager.exposePort(workspaceId, 5173).catch(() => {});
      }
      return;
    }

    // Start dev server in background
    await this.execInContainer(containerId, [
      'bash', '-c',
      'cd /workspace/repo && npm run dev -- --host 0.0.0.0 > /tmp/dev-server.log 2>&1 &',
    ]);

    // Poll until ready (max 30s)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const ready = await this.execInContainer(containerId, [
        'bash', '-c', 'curl -sf http://localhost:5173 > /dev/null 2>&1 && echo yes || echo no',
      ]);
      if (ready.trim() === 'yes') {
        if (this.workspaceManager) {
          await this.workspaceManager.exposePort(workspaceId, 5173).catch(() => {});
        }
        console.log(`[project-session] Dev server ready in container ${containerId.slice(0, 12)}`);
        return;
      }
    }
    console.warn(`[project-session] Dev server did not start in 30s (container ${containerId.slice(0, 12)})`);
  }

  /**
   * Reset the inactivity timer for a project.
   * After 30 minutes without a session, the container is paused (processes frozen).
   * On next session, WorkspaceManager.start() will unpause it — Vite resumes instantly.
   */
  private resetInactivityTimer(projectId: string, workspaceId: string): void {
    const existing = this.inactivityTimers.get(projectId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.inactivityTimers.delete(projectId);
      try {
        await this.workspaceManager?.pause(workspaceId);
        console.log(`[project-session] Paused container for project ${projectId} due to inactivity`);
      } catch (err) {
        console.warn(`[project-session] Failed to pause container for project ${projectId}:`, err);
      }
    }, 30 * 60 * 1000); // 30 minutes

    this.inactivityTimers.set(projectId, timer);
  }

  private async configureClaudeSettings(containerId: string): Promise<void> {
    const docker = await this.getDocker();
    const container = docker.getContainer(containerId);

    const mcpServers: Record<string, any> = {};
    if (config.insforgeApiUrl) {
      mcpServers['insforge'] = {
        type: 'stdio',
        command: 'insforge-mcp',
        args: [
          '--api_base_url', config.insforgeApiUrl,
          ...(config.insforgeApiKey ? ['--api_key', config.insforgeApiKey] : []),
        ],
      };
    }

    if (Object.keys(mcpServers).length === 0) return;

    const settings = JSON.stringify({ mcpServers }, null, 2);
    const cmd = [
      'bash', '-c',
      `mkdir -p /home/node && echo '${settings.replace(/'/g, "'\\''")}' > /home/node/.claude.json`,
    ];

    const exec = await container.exec({ Cmd: cmd, User: 'node' });
    await exec.start({ hijack: true, stdin: false });
  }

  private async commitAndPush(containerId: string, message: string): Promise<string> {
    const safeMsg = message.replace(/'/g, "\\'").replace(/\n/g, ' ');

    await this.execInContainer(containerId, [
      'bash', '-c',
      `git -C /workspace/repo add -A 2>/dev/null; true`,
    ]);

    await this.execInContainer(containerId, [
      'bash', '-c',
      `git -C /workspace/repo commit -m '${safeMsg}' --allow-empty-message 2>/dev/null; true`,
    ]);

    await this.execInContainer(containerId, [
      'bash', '-c',
      'git -C /workspace/repo push origin main 2>&1',
    ]);

    const sha = await this.execInContainer(containerId, [
      'bash', '-c',
      'git -C /workspace/repo rev-parse HEAD 2>/dev/null',
    ]);

    return sha.trim();
  }

  private async execInContainer(containerId: string, cmd: string[]): Promise<string> {
    const docker = await this.getDocker();
    const container = docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    return new Promise((resolve, reject) => {
      exec.start({ hijack: true, stdin: false }, (err: Error | null, stream: any) => {
        if (err) return reject(err);
        let output = '';
        stream.on('data', (chunk: Buffer) => {
          // Docker multiplexed stream header is 8 bytes
          output += chunk.length > 8 ? chunk.slice(8).toString() : chunk.toString();
        });
        stream.on('end', () => resolve(output.trim()));
        stream.on('error', reject);
      });
    });
  }

  private async buildProjectContext(
    project: { id: string; name: string; insforge_project_id: string | null; workspace_id: string | null },
    workspace: { id: string } | null | undefined,
    currentSessionId?: string,
  ): Promise<string> {
    const baseUrl = process.env.BASE_URL || `http://localhost:${config.port}`;
    const appUrl = workspace ? `${baseUrl}/apps/${workspace.id}` : 'not yet deployed';
    const insforgeProject = project.insforge_project_id || 'not yet linked';

    const lines = [
      `=== PROJECT: ${project.name} ===`,
      `App URL: ${appUrl}`,
      `InsForge Project: ${insforgeProject}`,
      ``,
      `Working directory: /workspace/repo`,
      `Dev server: usually running on port 5173 (check with: curl -sf http://localhost:5173)`,
      `Build output: /workspace/repo/dist (Vite default)`,
    ];

    // Inject session history so follow-up sessions have context
    // Include all committed and failed sessions, ordered oldest-first
    const pastSessions = this.db.listProjectSessions(project.id, 20)
      .filter(s => s.id !== currentSessionId && (s.status === 'committed' || s.status === 'failed'))
      .slice(0, 10)
      .reverse(); // oldest first

    if (pastSessions.length > 0) {
      lines.push('', '=== PREVIOUS WORK ===');
      lines.push('This project has been worked on before. Here is what was done:');
      for (const s of pastSessions) {
        const userInput = (() => {
          try { const p = JSON.parse(s.input); return p.message ?? s.input; }
          catch { return s.input; }
        })();
        lines.push('', `Task: ${userInput.slice(0, 200)}`);
        if (s.commit_sha) lines.push(`Commit: ${s.commit_sha.slice(0, 7)}`);
        if (s.status === 'failed') {
          lines.push(`Status: failed${s.error ? ` (${s.error})` : ''}`);
        } else {
          lines.push(`Result: ${(s.output ?? '').slice(0, 500)}`);
        }
      }
      lines.push('', 'The git repo at /workspace/repo contains all this work. Continue from where we left off.');
    }

    return lines.join('\n');
  }

  private buildContainerSpawn(containerId: string): (options: SpawnOptions) => SpawnedProcess {
    return (options: SpawnOptions): SpawnedProcess => {
      const envArgs: string[] = [];
      const envForward = [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_ENTRYPOINT',
        'CLAUDE_AGENT_SDK_VERSION',
      ];
      for (const key of envForward) {
        const val = options.env[key];
        if (val) envArgs.push('-e', `${key}=${val}`);
      }

      const cliFlags = options.args.slice(1);
      const dockerArgs = [
        'exec', '-i',
        '-w', '/workspace',
        ...envArgs,
        containerId,
        'claude',
        ...cliFlags,
      ];

      console.log(`[project-session] Spawning Claude Code in ${containerId.slice(0, 12)}`);

      const proc = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
      });

      const stderrLines: string[] = [];
      proc.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.log(`[project-session:claude:stderr] ${msg}`);
          stderrLines.push(msg);
        }
      });

      proc.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          const stderrSummary = stderrLines.slice(-5).join(' | ');
          console.error(`[project-session] Claude Code exited with code ${code}${stderrSummary ? ` — stderr: ${stderrSummary}` : ''}`);
        }
      });

      return proc as unknown as SpawnedProcess;
    };
  }

  /**
   * Cleanup orphan sessions on server startup.
   * Sessions marked 'running' or 'pending' when server crashed are marked as failed.
   * Containers are left running — they will be reused on the next request.
   */
  async cleanupOrphanSessions(): Promise<void> {
    try {
      const runningSessions = this.db.listAllRunningSessions?.() ?? [];
      for (const session of runningSessions) {
        if (['pending', 'running'].includes(session.status)) {
          this.db.updateProjectSession(session.id, {
            status: 'failed',
            error: 'server_restart',
            completed_at: new Date().toISOString(),
          });
          console.log(`[project-session] Marked orphan session ${session.id} as failed`);
        }
      }
      if (runningSessions.length > 0) {
        console.log(`[project-session] Marked ${runningSessions.length} orphan session(s) as failed`);
      }
    } catch (err) {
      console.warn('[project-session] Orphan cleanup failed:', err instanceof Error ? err.message : err);
    }
  }
}
