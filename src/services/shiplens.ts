import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { config } from '../config/env.js';

export class ShipLensService {
  private client: Client | null = null;
  private connected = false;
  private availableTools: string[] = [];
  private _lastConnectionTime: Date | null = null;

  constructor() {}

  /**
   * Check whether ShipLens is configured (URL or command present).
   */
  isConfigured(): boolean {
    if (config.shiplensTransport === 'stdio') {
      return !!config.shiplensCommand;
    }
    return !!config.shiplensUrl;
  }

  /**
   * Check current connection health.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Connect to the ShipLens MCP server.
   */
  async connect(): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error(
        'ShipLens is not configured. Set SHIPLENS_URL (http) or SHIPLENS_COMMAND (stdio).',
      );
    }

    try {
      this.client = new Client({
        name: 'claude-agent',
        version: '1.0.0',
      });

      let transport;

      if (config.shiplensTransport === 'stdio') {
        const command = config.shiplensCommand!;
        const [cmd, ...args] = command.split(/\s+/);
        transport = new StdioClientTransport({ command: cmd, args });
      } else {
        const url = new URL(config.shiplensUrl!);
        const headers: Record<string, string> = {};
        if (config.shiplensApiKey) {
          headers['Authorization'] = `Bearer ${config.shiplensApiKey}`;
        }
        transport = new SSEClientTransport(url, {
          requestInit: { headers },
        });
      }

      await this.client.connect(transport);
      this.connected = true;
      this._lastConnectionTime = new Date();

      // Discover available tools
      const toolsResult = await this.client.listTools();
      this.availableTools = toolsResult.tools.map((t) => t.name);

      console.log(
        `[ShipLens] Connected via ${config.shiplensTransport}. Available tools: ${this.availableTools.join(', ')}`,
      );
    } catch (error) {
      this.connected = false;
      this.client = null;
      console.error('[ShipLens] Connection failed:', error);
      throw error;
    }
  }

  /**
   * Disconnect gracefully from the ShipLens MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        console.error('[ShipLens] Error during disconnect:', error);
      } finally {
        this.client = null;
        this.connected = false;
        this.availableTools = [];
      }
    }
  }

  /**
   * Generic tool call with auto-reconnect on connection failure.
   */
  async callTool(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new Error(
        'ShipLens is not configured. Set SHIPLENS_URL or SHIPLENS_COMMAND.',
      );
    }

    if (!this.connected || !this.client) {
      throw new Error(
        'ShipLens is not connected. Call connect() first.',
      );
    }

    try {
      const result = await this.client.callTool({
        name,
        arguments: params,
      });
      return result;
    } catch (error) {
      console.error(
        `[ShipLens] Tool call "${name}" failed, attempting reconnect:`,
        error,
      );
      this.connected = false;

      // Auto-reconnect once
      try {
        await this.disconnect();
        await this.connect();
        const result = await this.client!.callTool({
          name,
          arguments: params,
        });
        return result;
      } catch (retryError) {
        this.connected = false;
        console.error(
          `[ShipLens] Reconnect and retry for "${name}" failed:`,
          retryError,
        );
        throw retryError;
      }
    }
  }

  /**
   * Get the list of tools discovered during connect().
   */
  getAvailableTools(): string[] {
    return [...this.availableTools];
  }

  // ── Convenience wrappers ───────────────────────────────────────────

  async latestPulse(): Promise<unknown> {
    return this.callTool('latest_pulse');
  }

  async stalePRs(): Promise<unknown> {
    return this.callTool('stale_prs');
  }

  async doraLatest(): Promise<unknown> {
    return this.callTool('dora_latest');
  }

  async contributorAlerts(): Promise<unknown> {
    return this.callTool('contributor_alerts');
  }

  async attritionRisk(): Promise<unknown> {
    return this.callTool('attrition_risk');
  }

  async latest1on1(person: string): Promise<unknown> {
    return this.callTool('latest_1on1', { person });
  }

  async prHealth(): Promise<unknown> {
    return this.callTool('pr_health');
  }

  async reviewerRanking(): Promise<unknown> {
    return this.callTool('reviewer_ranking');
  }

  async crossTeamCoupling(): Promise<unknown> {
    return this.callTool('cross_team_coupling');
  }

  async beforeAfter(event: string, metric: string): Promise<unknown> {
    return this.callTool('before_after', { event, metric });
  }
}
