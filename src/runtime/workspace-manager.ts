import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseService } from '../core/database.js';
import type { EncryptionService } from '../core/encryption.js';
import type { PortProxyManager } from './port-proxy.js';
import { config } from '../config/env.js';

export interface WorkspaceRow {
  id: string;
  name: string;
  agent_id: string;
  container_id: string | null;
  volume_name: string;
  status: 'created' | 'running' | 'paused' | 'destroyed';
  port_mappings: string; // JSON
  insforge_project_id: string | null;
  disk_usage_mb: number;
  owner_id: string | null;
  visibility: 'private' | 'team' | 'public';
  team_id: string | null;
  jwt_secret: string | null;
  static_app_path: string | null; // relative path inside volume_name to serve as static site
  created_at: string;
  updated_at: string;
  last_active_at: string | null;
}

export interface DevContainerConfig {
  image?: string;
  hostCallbackPort?: number;
  network?: string;
  portRange?: { min: number; max: number };
  defaultMemoryMb?: number;
  defaultCpuShares?: number;
  defaultTimeoutMs?: number;
  /** Ports the agent is allowed to expose (default: [3000,3001,4000,5173,8000,8080]) */
  allowedPorts?: number[];
}

const DEFAULT_ALLOWED_PORTS = [3000, 3001, 4000, 5173, 8000, 8080];

/**
 * Manages persistent developer workspaces backed by Docker volumes.
 * Each workspace has a named volume mounted at /workspace inside a long-lived container.
 */
export class WorkspaceManager {
  private docker: any = null;

  constructor(
    private db: DatabaseService,
    private portProxy: PortProxyManager,
    private config: DevContainerConfig = {},
    private encryption?: EncryptionService,
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
   * Create a new workspace: host directory (bind mount) + DB record.
   * Does NOT start a container — call `start()` for that.
   *
   * Uses bind mounts instead of Docker volumes so the host can access workspace files.
   * This is critical for InsForge deployments — `create-deployment` reads from the host filesystem.
   */
  async create(name: string, agentId: string, ownerId?: string): Promise<WorkspaceRow> {
    const id = crypto.randomUUID();
    const shortId = id.slice(0, 8);

    // Create host directory for bind mount (instead of Docker volume)
    const hostDir = path.resolve(config.workspacesPath, shortId);
    fs.mkdirSync(hostDir, { recursive: true });

    // Generate per-workspace JWT secret (for /__tela/token endpoint)
    const jwtSecretRaw = crypto.randomBytes(32).toString('hex');
    const jwtSecret = this.encryption ? this.encryption.encrypt(jwtSecretRaw) : jwtSecretRaw;

    // Insert DB record — volume_name stores the host path for bind mount
    this.db.createWorkspace({
      id, name, agent_id: agentId, volume_name: hostDir,
      owner_id: ownerId ?? null,
      jwt_secret: jwtSecret,
    });

    console.log(`[workspace] Created ${name} (${shortId}, path: ${hostDir}, owner: ${ownerId ?? 'none'})`);
    return this.db.getWorkspace(id)!;
  }

  /**
   * Start or resume a workspace container.
   * If the container already exists and is running, returns it.
   * If paused (container stopped), restarts it.
   * If no container exists, creates a new one.
   */
  async start(workspaceId: string): Promise<{ containerId: string; workspace: WorkspaceRow }> {
    const docker = await this.getDocker();
    const ws = this.db.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (ws.status === 'destroyed') throw new Error(`Workspace is destroyed: ${workspaceId}`);

    // If container exists and is running, return it
    if (ws.container_id) {
      try {
        const container = docker.getContainer(ws.container_id);
        const info = await container.inspect();
        if (info.State.Running) {
          this.db.touchWorkspaceActivity(workspaceId);
          return { containerId: ws.container_id, workspace: ws };
        }
        // Container exists but stopped — restart it
        await container.start();
        this.db.updateWorkspace(workspaceId, { status: 'running' });
        this.db.touchWorkspaceActivity(workspaceId);
        return { containerId: ws.container_id, workspace: this.db.getWorkspace(workspaceId)! };
      } catch {
        // Container is gone — create a new one
      }
    }

    // Create new container with the workspace volume
    const image = this.config.image ?? 'tela-devcontainer:latest';
    const memoryBytes = (this.config.defaultMemoryMb ?? 2048) * 1024 * 1024;
    const cpuShares = this.config.defaultCpuShares ?? 2048;
    const callbackPort = this.config.hostCallbackPort ?? 3000;

    // Pre-allocate port bindings for allowed ports
    const allowedPorts = this.config.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
    const exposedPorts: Record<string, object> = {};
    const portBindings: Record<string, { HostPort: string }[]> = {};

    for (const port of allowedPorts) {
      exposedPorts[`${port}/tcp`] = {};
      portBindings[`${port}/tcp`] = [{ HostPort: '0' }]; // Docker assigns random host port
    }

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['bash', '-c', 'tail -f /dev/null'], // Keep container alive
      Env: [
        `WORKSPACE_ID=${workspaceId}`,
        `WORKSPACE_NAME=${ws.name}`,
        `MCP_PROXY_URL=http://host.docker.internal:${callbackPort}/internal/mcp-proxy`,
      ],
      WorkingDir: '/workspace',
      ExposedPorts: exposedPorts,
      HostConfig: {
        Memory: memoryBytes,
        CpuShares: cpuShares,
        NetworkMode: this.config.network ?? 'bridge',
        ExtraHosts: ['host.docker.internal:host-gateway'],
        AutoRemove: false,
        Binds: [`${ws.volume_name}:/workspace`],
        PortBindings: portBindings,
        SecurityOpt: ['no-new-privileges:true'],
      },
      Labels: {
        'tela.workspace-id': workspaceId,
        'tela.agent-id': ws.agent_id,
        'tela.runtime': 'devcontainer',
      },
    });

    await container.start();
    const containerId = container.id as string;

    this.db.updateWorkspace(workspaceId, { container_id: containerId, status: 'running' });
    this.db.touchWorkspaceActivity(workspaceId);

    // Configure Claude Code settings inside the container (InsForge MCP, etc.)
    await this.configureClaudeSettings(containerId);

    console.log(`[workspace] Started ${ws.name} (container: ${containerId.slice(0, 12)})`);
    return { containerId, workspace: this.db.getWorkspace(workspaceId)! };
  }

  /**
   * Write Claude Code settings inside the container so it has access to
   * InsForge MCP and other container-local tools.
   */
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

    // Write settings to /home/node/.claude.json inside the container
    const cmd = [
      'bash', '-c',
      `mkdir -p /home/node && echo '${settings.replace(/'/g, "'\\''")}' > /home/node/.claude.json`,
    ];

    const exec = await container.exec({ Cmd: cmd, User: 'node' });
    await exec.start({ hijack: true, stdin: false });
    console.log(`[workspace] Configured Claude Code settings in container ${containerId.slice(0, 12)} (MCP: ${Object.keys(mcpServers).join(', ')})`);
  }

  /** Pause a workspace — stop the container but keep the volume. */
  async pause(workspaceId: string): Promise<void> {
    const docker = await this.getDocker();
    const ws = this.db.getWorkspace(workspaceId);
    if (!ws?.container_id) return;

    try {
      await this.portProxy.releaseAll(ws.container_id);
      const container = docker.getContainer(ws.container_id);
      await container.stop({ t: 10 });
    } catch { /* container may already be stopped */ }

    this.db.updateWorkspace(workspaceId, { status: 'paused', port_mappings: '[]' });
    console.log(`[workspace] Paused ${ws.name}`);
  }

  /** Destroy a workspace — remove container + volume. */
  async destroy(workspaceId: string): Promise<void> {
    const docker = await this.getDocker();
    const ws = this.db.getWorkspace(workspaceId);
    if (!ws) return;

    // Release port proxies
    if (ws.container_id) {
      await this.portProxy.releaseAll(ws.container_id);
    }

    // Remove container
    if (ws.container_id) {
      try {
        const container = docker.getContainer(ws.container_id);
        await container.stop({ t: 5 }).catch(() => {});
        await container.remove({ force: true });
      } catch { /* already gone */ }
    }

    // Remove workspace directory from host
    try {
      fs.rmSync(ws.volume_name, { recursive: true, force: true });
    } catch { /* already gone */ }

    this.db.updateWorkspace(workspaceId, { status: 'destroyed', container_id: null as any, port_mappings: '[]' });
    console.log(`[workspace] Destroyed ${ws.name} (volume: ${ws.volume_name})`);
  }

  /**
   * Expose a container port through the port proxy.
   * Returns the proxy URL (routed through /apps/{workspaceId} with auth).
   */
  async exposePort(workspaceId: string, containerPort: number): Promise<{ hostPort: number; url: string }> {
    const docker = await this.getDocker();
    const ws = this.db.getWorkspace(workspaceId);
    if (!ws?.container_id) throw new Error('Workspace has no running container');

    const allowedPorts = this.config.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
    if (!allowedPorts.includes(containerPort)) {
      throw new Error(`Port ${containerPort} is not in the allowed ports list: ${allowedPorts.join(', ')}`);
    }

    // Get Docker's mapped host port for this container port
    const container = docker.getContainer(ws.container_id);
    const info = await container.inspect();
    const portKey = `${containerPort}/tcp`;
    const bindings = info.NetworkSettings.Ports[portKey];

    if (!bindings?.length) {
      throw new Error(`Port ${containerPort} is not mapped in container ${ws.container_id.slice(0, 12)}`);
    }

    const dockerHostPort = parseInt(bindings[0].HostPort, 10);

    // Create internal TCP proxy (bound to 127.0.0.1 only)
    const mapping = await this.portProxy.allocate(ws.container_id, containerPort, dockerHostPort);

    // Update DB
    const currentMappings: { containerPort: number; hostPort: number; url: string }[] = JSON.parse(ws.port_mappings);
    currentMappings.push({ containerPort, hostPort: mapping.hostPort, url: mapping.url });
    this.db.updateWorkspace(workspaceId, { port_mappings: JSON.stringify(currentMappings) });

    // Return the RBAC-protected proxy URL instead of the raw TCP port
    const baseUrl = process.env.BASE_URL || `http://localhost:${config.port}`;
    const proxyUrl = `${baseUrl}/apps/${workspaceId}`;

    return { hostPort: mapping.hostPort, url: proxyUrl };
  }

  /** Get all port mappings for a workspace. */
  getPortMappings(workspaceId: string): { containerPort: number; hostPort: number; url: string }[] {
    const ws = this.db.getWorkspace(workspaceId);
    if (!ws) return [];
    return JSON.parse(ws.port_mappings);
  }

  /** Find or create a workspace for an agent. Reuses existing running/paused workspace if available. */
  async getOrCreate(agentId: string, name?: string, ownerId?: string): Promise<WorkspaceRow> {
    // Look for an existing non-destroyed workspace for this agent
    const existing = this.db.getWorkspaces(agentId);
    const reusable = existing.find(w => w.status === 'running' || w.status === 'paused' || w.status === 'created');
    if (reusable) return reusable;

    // Create a new one
    return this.create(name ?? `workspace-${agentId.slice(0, 8)}`, agentId, ownerId);
  }

  /**
   * Register a built frontend directory as the static app for this workspace.
   * The path is relative to /workspace inside the container (= relative to volume_name on host).
   * Once set, the app proxy serves files directly from disk — no running container needed.
   */
  setStaticApp(workspaceId: string, relativePath: string): string {
    const ws = this.db.getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (ws.status === 'destroyed') throw new Error(`Workspace is destroyed: ${workspaceId}`);

    // Sanitize: strip leading /workspace/ or / prefix
    const clean = relativePath.replace(/^\/workspace\//, '').replace(/^\//, '');
    this.db.updateWorkspace(workspaceId, { static_app_path: clean });

    const baseUrl = process.env.BASE_URL || `http://localhost:${config.port}`;
    return `${baseUrl}/apps/${workspaceId}`;
  }

  /** Clear the static deploy so the proxy routes to the live container instead. */
  clearStaticApp(workspaceId: string): void {
    const ws = this.db.getWorkspace(workspaceId);
    if (!ws || ws.status === 'destroyed') return;
    this.db.updateWorkspace(workspaceId, { static_app_path: null as any });
  }

  /**
   * Attach a session container to a workspace so that `exposePort` can work
   * and the app proxy knows to do live proxying.
   * Called when a project-session container starts.
   */
  async attachSessionContainer(workspaceId: string, containerId: string): Promise<void> {
    this.db.updateWorkspace(workspaceId, { container_id: containerId, status: 'running' });
    console.log(`[workspace] Attached session container ${containerId.slice(0, 12)} to workspace ${workspaceId}`);
  }

  /**
   * Detach a session container from a workspace: release all port proxies,
   * clear container_id, reset status to 'created', and clear port_mappings.
   * Called in the finally block of a project session before the container is destroyed.
   */
  async detachSessionContainer(workspaceId: string, containerId: string): Promise<void> {
    await this.portProxy.releaseAll(containerId);
    this.db.updateWorkspace(workspaceId, {
      container_id: null as any,
      status: 'created',
      port_mappings: '[]',
    });
    console.log(`[workspace] Detached session container ${containerId.slice(0, 12)} from workspace ${workspaceId}`);
  }

  /** Decrypt the per-workspace JWT secret. Returns raw hex string. */
  decryptJwtSecret(workspace: WorkspaceRow): string | null {
    if (!workspace.jwt_secret) return null;
    return this.encryption ? this.encryption.decrypt(workspace.jwt_secret) : workspace.jwt_secret;
  }
}
