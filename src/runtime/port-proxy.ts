import net from 'node:net';

export interface PortMapping {
  containerPort: number;
  hostPort: number;
  url: string;
  containerId: string;
}

/**
 * Manages TCP proxies between host ports and container ports.
 * Allocates from a configurable high-port range and cleans up on release.
 */
export class PortProxyManager {
  private proxies = new Map<number, net.Server>();
  private mappings = new Map<string, PortMapping[]>(); // containerId → mappings
  private allocated = new Set<number>();

  constructor(
    private portRange = { min: 9000, max: 9099 },
    private hostname = 'localhost',
  ) {}

  /**
   * Allocate a host port and create a TCP proxy to a container port.
   * Uses Docker's mapped port on the host (via container inspect).
   */
  async allocate(
    containerId: string,
    containerPort: number,
    dockerMappedHostPort: number,
  ): Promise<PortMapping> {
    const hostPort = this.findAvailablePort();

    const server = net.createServer((clientSocket) => {
      const targetSocket = net.createConnection(
        { host: '127.0.0.1', port: dockerMappedHostPort },
        () => {
          clientSocket.pipe(targetSocket);
          targetSocket.pipe(clientSocket);
        },
      );

      targetSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => targetSocket.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(hostPort, '0.0.0.0', () => resolve());
    });

    this.proxies.set(hostPort, server);
    this.allocated.add(hostPort);

    const mapping: PortMapping = {
      containerPort,
      hostPort,
      url: `http://${this.hostname}:${hostPort}`,
      containerId,
    };

    if (!this.mappings.has(containerId)) {
      this.mappings.set(containerId, []);
    }
    this.mappings.get(containerId)!.push(mapping);

    console.log(`[port-proxy] ${containerPort} → ${hostPort} (container ${containerId.slice(0, 12)})`);
    return mapping;
  }

  /** Release a single proxy by host port. */
  async release(hostPort: number): Promise<void> {
    const server = this.proxies.get(hostPort);
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.proxies.delete(hostPort);
      this.allocated.delete(hostPort);
    }

    // Clean up from mappings
    for (const [containerId, mappings] of this.mappings) {
      const idx = mappings.findIndex(m => m.hostPort === hostPort);
      if (idx !== -1) {
        mappings.splice(idx, 1);
        if (mappings.length === 0) this.mappings.delete(containerId);
        break;
      }
    }
  }

  /** Release all proxies for a given container. */
  async releaseAll(containerId: string): Promise<void> {
    const mappings = this.mappings.get(containerId) ?? [];
    for (const mapping of mappings) {
      const server = this.proxies.get(mapping.hostPort);
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        this.proxies.delete(mapping.hostPort);
        this.allocated.delete(mapping.hostPort);
      }
    }
    this.mappings.delete(containerId);
  }

  /** Get all active mappings for a container. */
  getMappings(containerId: string): PortMapping[] {
    return this.mappings.get(containerId) ?? [];
  }

  /** Get all active mappings across all containers. */
  getAllMappings(): PortMapping[] {
    return Array.from(this.mappings.values()).flat();
  }

  /** Shut down all proxies. */
  async dispose(): Promise<void> {
    for (const [port, server] of this.proxies) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.allocated.delete(port);
    }
    this.proxies.clear();
    this.mappings.clear();
  }

  private findAvailablePort(): number {
    for (let port = this.portRange.min; port <= this.portRange.max; port++) {
      if (!this.allocated.has(port)) return port;
    }
    throw new Error(`No available ports in range ${this.portRange.min}-${this.portRange.max}`);
  }
}
