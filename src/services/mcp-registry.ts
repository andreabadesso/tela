import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { DatabaseService } from './database.js';
import type { EncryptionService } from './encryption.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export class McpServerRegistry {
  private clients = new Map<string, Client>();
  private toolCache = new Map<string, ToolDefinition[]>();
  private healthInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: DatabaseService,
    private encryption: EncryptionService,
  ) {}

  /**
   * Connect to an MCP server for a given connection ID.
   * Determines transport from the connection's config/mcp_server_url.
   */
  async connect(connectionId: string): Promise<void> {
    const connection = this.db.getConnection(connectionId);
    if (!connection) throw new Error(`Connection not found: ${connectionId}`);

    // Close existing client if reconnecting
    if (this.clients.has(connectionId)) {
      await this.disconnect(connectionId);
    }

    let client: Client;

    if (connection.mcp_server_url) {
      // Streamable HTTP or SSE transport
      const transport = new SSEClientTransport(new URL(connection.mcp_server_url));
      client = new Client({ name: `tela-${connectionId}`, version: '1.0.0' });
      await client.connect(transport);
    } else {
      // Config may specify a command for stdio
      const config = JSON.parse(connection.config || '{}') as Record<string, unknown>;
      if (config.command) {
        const transport = new StdioClientTransport({
          command: config.command as string,
          args: (config.args as string[]) || [],
        });
        client = new Client({ name: `tela-${connectionId}`, version: '1.0.0' });
        await client.connect(transport);
      } else {
        throw new Error(`No MCP endpoint configured for ${connectionId}`);
      }
    }

    this.clients.set(connectionId, client);

    // Discover tools
    const tools = await this.discoverTools(connectionId);
    this.toolCache.set(connectionId, tools);
    console.log(`[mcp-registry] Connected ${connectionId}: ${tools.length} tools discovered`);
  }

  /**
   * Disconnect and clean up an MCP client.
   */
  async disconnect(connectionId: string): Promise<void> {
    const client = this.clients.get(connectionId);
    if (client) {
      try {
        await client.close();
      } catch (err) {
        console.error(`[mcp-registry] Error disconnecting ${connectionId}:`, err);
      }
      this.clients.delete(connectionId);
      this.toolCache.delete(connectionId);
    }
  }

  /**
   * Discover available tools from a connected MCP server.
   */
  async discoverTools(connectionId: string): Promise<ToolDefinition[]> {
    const client = this.clients.get(connectionId);
    if (!client) return [];
    const result = await client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Get the MCP client for a connection (for proxying tool calls).
   */
  getClient(connectionId: string): Client | undefined {
    return this.clients.get(connectionId);
  }

  /**
   * Get cached tool definitions for a connection.
   */
  getCachedTools(connectionId: string): ToolDefinition[] {
    return this.toolCache.get(connectionId) || [];
  }

  /**
   * Get all cached tools across all connections.
   */
  getAllCachedTools(): Map<string, ToolDefinition[]> {
    return new Map(this.toolCache);
  }

  /**
   * Check if a connection's MCP client is healthy.
   */
  async healthCheck(connectionId: string): Promise<boolean> {
    try {
      const client = this.clients.get(connectionId);
      if (!client) return false;
      await client.listTools(); // ping
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start periodic health monitoring (every 5 minutes).
   */
  startHealthMonitoring(): void {
    if (this.healthInterval) return;

    this.healthInterval = setInterval(async () => {
      for (const [connectionId] of this.clients) {
        try {
          const healthy = await this.healthCheck(connectionId);
          if (!healthy) {
            console.warn(`[mcp-registry] ${connectionId} unhealthy, attempting reconnect...`);
            this.db.updateConnection(connectionId, {
              status: 'error',
              error_message: 'MCP health check failed',
              updated_at: new Date().toISOString(),
            });

            // Try to reconnect
            try {
              await this.connect(connectionId);
              this.db.updateConnection(connectionId, {
                status: 'connected',
                error_message: null,
                updated_at: new Date().toISOString(),
              });
              console.log(`[mcp-registry] ${connectionId} reconnected successfully`);
            } catch (err) {
              console.error(`[mcp-registry] ${connectionId} reconnect failed:`, err);
            }
          }
        } catch (err) {
          console.error(`[mcp-registry] Health check error for ${connectionId}:`, err);
        }
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Stop health monitoring.
   */
  stopHealthMonitoring(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  /**
   * Disconnect all clients and stop monitoring.
   */
  async shutdown(): Promise<void> {
    this.stopHealthMonitoring();
    for (const connectionId of this.clients.keys()) {
      await this.disconnect(connectionId);
    }
  }
}
