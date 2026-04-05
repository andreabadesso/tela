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
 * ProjectSessionRuntime — ephemeral containers for App Builder sessions.
 *
 * Each session:
 * 1. Spins up a fresh container
 * 2. Clones the project's git repo into /workspace/repo
 * 3. Runs the agent (Claude Code inside the container)
 * 4. On completion: git add -A && commit && push → container destroyed
 *
 * The workspace bind mount persists between sessions — it holds the last promoted
 * static build served by the app proxy.
 */
export class ProjectSessionRuntime {
  private docker: any = null;
  private sessionEmitters = new Map<string, EventEmitter>();

  /** Subscribe to live agent events for a running session. */
  getSessionEmitter(sessionId: string): EventEmitter | undefined {
    return this.sessionEmitters.get(sessionId);
  }

  constructor(
    private agentService: AgentService,
    private db: DatabaseService,
    private gitService: GitService,
    private containerConfig: DevContainerConfig = {},
    private encryption?: EncryptionService,
    private workspaceManager?: WorkspaceManager,
  ) {}

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
    let containerId: string | null = null;

    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    this.sessionEmitters.set(sessionId, emitter);

    this.db.updateProjectSession(sessionId, {
      status: 'running',
      started_at: new Date(startedAt).toISOString(),
    });

    try {
      const project = this.db.getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);

      // Lazily create workspace if project was created without one
      let workspace = project.workspace_id ? this.db.getWorkspace(project.workspace_id) : null;
      if (!workspace && this.workspaceManager) {
        try {
          workspace = await this.workspaceManager.create(
            `project-${project.git_repo_slug}`,
            agentId,
            userId,
          );
          this.db.updateProject(project.id, { workspace_id: workspace!.id });
          console.log(`[project-session] Created workspace ${workspace!.id} for project ${project.id}`);
        } catch (err) {
          console.warn(`[project-session] Could not create workspace for project ${project.id}:`, err);
          workspace = null;
        }
      }

      // Build project context block for the system prompt (includes previous session history)
      const projectContext = await this.buildProjectContext(project, workspace, sessionId);

      // Start fresh container
      containerId = await this.startContainer(project, workspace, sessionId);

      this.db.updateProjectSession(sessionId, { container_id: containerId });

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
      // Always destroy the container
      if (containerId) {
        // Detach workspace from session container before destroying (releases port proxies)
        const project = this.db.getProject(projectId);
        const workspaceId = project?.workspace_id;
        if (workspaceId) {
          await this.workspaceManager?.detachSessionContainer(workspaceId, containerId).catch(err =>
            console.warn(`[project-session] detachSessionContainer failed (non-fatal):`, err)
          );
        }
        await this.destroyContainer(containerId).catch(err =>
          console.error(`[project-session] Container destroy failed:`, err)
        );
        this.db.updateProjectSession(sessionId, { container_id: null as any });
      }
    }
  }

  private async startContainer(
    project: { id: string; git_repo_slug: string },
    workspace: { id: string; volume_name: string } | null | undefined,
    sessionId: string,
  ): Promise<string> {
    const docker = await this.getDocker();
    const image = this.containerConfig.image ?? config.devContainerImage;
    const memoryBytes = (this.containerConfig.defaultMemoryMb ?? config.devContainerMemoryMb) * 1024 * 1024;
    const cpuShares = this.containerConfig.defaultCpuShares ?? 2048;
    const callbackPort = this.containerConfig.hostCallbackPort ?? config.port;

    const binds: string[] = [];
    if (workspace?.volume_name) {
      binds.push(`${workspace.volume_name}:/workspace`);
    }

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['bash', '-c', 'tail -f /dev/null'],
      Env: [
        `WORKSPACE_ID=${workspace?.id ?? ''}`,
        `PROJECT_ID=${project.id}`,
        `SESSION_ID=${sessionId}`,
        `MCP_PROXY_URL=http://host.docker.internal:${callbackPort}/internal/mcp-proxy`,
      ],
      WorkingDir: '/workspace',
      ExposedPorts: { '5173/tcp': {} },
      HostConfig: {
        Memory: memoryBytes,
        CpuShares: cpuShares,
        NetworkMode: this.containerConfig.network ?? 'bridge',
        ExtraHosts: ['host.docker.internal:host-gateway'],
        AutoRemove: false,
        Binds: binds,
        PortBindings: { '5173/tcp': [{ HostPort: '' }] },
        SecurityOpt: ['no-new-privileges:true'],
      },
      Labels: {
        'tela.project-id': project.id,
        'tela.session-id': sessionId,
        'tela.project-session': 'true',
        'tela.runtime': 'project-session',
      },
    });

    await container.start();
    const containerId = container.id as string;

    // Attach workspace to session container so exposePort and live proxy work
    if (workspace?.id) {
      await this.workspaceManager?.attachSessionContainer(workspace.id, containerId).catch(err =>
        console.warn(`[project-session] attachSessionContainer failed (non-fatal):`, err)
      );
    }

    // Clone the project repo (always create /workspace/repo even if clone fails)
    const cloneUrl = this.gitService.cloneUrl(project.git_repo_slug);
    await this.execInContainer(containerId, [
      'bash', '-c',
      `mkdir -p /workspace/repo && (git clone ${cloneUrl} /workspace/repo 2>&1 && echo "Cloned OK") || echo "Clone failed — starting with empty repo"`,
    ]);

    // Configure git identity
    await this.execInContainer(containerId, [
      'bash', '-c',
      'git -C /workspace/repo config user.name "Tela App Builder" 2>/dev/null || true; ' +
      'git -C /workspace/repo config user.email "builder@tela.internal" 2>/dev/null || true',
    ]);

    // Configure Claude Code settings (InsForge MCP)
    await this.configureClaudeSettings(containerId);

    console.log(`[project-session] Started container ${containerId.slice(0, 12)} for project ${project.id}`);
    return containerId;
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

  private async destroyContainer(containerId: string): Promise<void> {
    const docker = await this.getDocker();
    const container = docker.getContainer(containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
    console.log(`[project-session] Destroyed container ${containerId.slice(0, 12)}`);
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
      `Build output: /workspace/repo/dist (Vite default)`,
    ];

    // Inject recent session history so follow-up sessions have context
    const pastSessions = this.db.listProjectSessions(project.id, 10)
      .filter(s => s.id !== currentSessionId && s.status === 'committed' && s.output != null)
      .slice(0, 3); // last 3 committed sessions

    if (pastSessions.length > 0) {
      lines.push('', '=== PREVIOUS WORK ===');
      lines.push('This project has been worked on before. Here is what was done:');
      for (const s of pastSessions.reverse()) {
        const userInput = (() => {
          try { const p = JSON.parse(s.input); return p.message ?? s.input; }
          catch { return s.input; }
        })();
        lines.push('', `Task: ${userInput.slice(0, 200)}`);
        if (s.commit_sha) lines.push(`Commit: ${s.commit_sha.slice(0, 7)}`);
        lines.push(`Result: ${(s.output ?? '').slice(0, 500)}`);
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
   * Cleanup orphan session containers on server startup.
   * These are containers left over from a crash — find them by label and clean up.
   */
  async cleanupOrphanSessions(): Promise<void> {
    try {
      const docker = await this.getDocker();
      const containers = await docker.listContainers({
        filters: JSON.stringify({ label: ['tela.project-session=true'] }),
      });

      for (const info of containers) {
        const sessionId = info.Labels?.['tela.session-id'];
        if (!sessionId) continue;

        console.log(`[project-session] Cleaning orphan container ${info.Id.slice(0, 12)} (session: ${sessionId})`);

        // Attempt best-effort push
        await this.commitAndPush(info.Id, 'Partial work (server restart)').catch(() => {});

        // Destroy container
        await this.destroyContainer(info.Id).catch(() => {});

        // Mark session as failed
        const session = this.db.getProjectSession(sessionId);
        if (session && ['pending', 'running'].includes(session.status)) {
          this.db.updateProjectSession(sessionId, {
            status: 'failed',
            error: 'server_restart',
            completed_at: new Date().toISOString(),
          });
        }
      }

      if (containers.length > 0) {
        console.log(`[project-session] Cleaned ${containers.length} orphan session(s)`);
      }
    } catch (err) {
      console.warn('[project-session] Orphan cleanup failed (Docker may not be available):', err instanceof Error ? err.message : err);
    }
  }
}
