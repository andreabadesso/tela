import type { DatabaseService } from '../core/database.js';
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
   * Create a new workspace: Docker volume + DB record.
   * Does NOT start a container — call `start()` for that.
   */
  async create(name: string, agentId: string): Promise<WorkspaceRow> {
    const docker = await this.getDocker();
    const id = crypto.randomUUID();
    const volumeName = `tela-workspace-${id.slice(0, 8)}`;

    // Create Docker volume
    await docker.createVolume({ Name: volumeName });

    // Insert DB record
    this.db.createWorkspace({ id, name, agent_id: agentId, volume_name: volumeName });

    console.log(`[workspace] Created ${name} (${id.slice(0, 8)}, volume: ${volumeName})`);
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

    // Remove volume
    try {
      const volume = docker.getVolume(ws.volume_name);
      await volume.remove();
    } catch { /* already gone */ }

    this.db.updateWorkspace(workspaceId, { status: 'destroyed', container_id: null as any, port_mappings: '[]' });
    console.log(`[workspace] Destroyed ${ws.name} (volume: ${ws.volume_name})`);
  }

  /**
   * Expose a container port through the port proxy.
   * Returns the external URL accessible from the host.
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

    // Create TCP proxy
    const mapping = await this.portProxy.allocate(ws.container_id, containerPort, dockerHostPort);

    // Update DB
    const currentMappings: { containerPort: number; hostPort: number; url: string }[] = JSON.parse(ws.port_mappings);
    currentMappings.push({ containerPort, hostPort: mapping.hostPort, url: mapping.url });
    this.db.updateWorkspace(workspaceId, { port_mappings: JSON.stringify(currentMappings) });

    return { hostPort: mapping.hostPort, url: mapping.url };
  }

  /** Get all port mappings for a workspace. */
  getPortMappings(workspaceId: string): { containerPort: number; hostPort: number; url: string }[] {
    const ws = this.db.getWorkspace(workspaceId);
    if (!ws) return [];
    return JSON.parse(ws.port_mappings);
  }

  /** Find or create a workspace for an agent. Reuses existing running/paused workspace if available. */
  async getOrCreate(agentId: string, name?: string): Promise<WorkspaceRow> {
    // Look for an existing non-destroyed workspace for this agent
    const existing = this.db.getWorkspaces(agentId);
    const reusable = existing.find(w => w.status === 'running' || w.status === 'paused' || w.status === 'created');
    if (reusable) return reusable;

    // Create a new one
    return this.create(name ?? `workspace-${agentId.slice(0, 8)}`, agentId);
  }
}
