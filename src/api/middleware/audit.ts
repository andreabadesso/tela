import type { DatabaseService } from '../../core/database.js';

/**
 * Audit logging middleware structure.
 * Provides functions to log various agent activities.
 * The actual hooking into agent processing will happen
 * when the agent service is refactored.
 */
export class AuditLogger {
  constructor(private db: DatabaseService) {}

  /** Log a tool call execution */
  logToolCall(agentId: string, toolName: string, args: Record<string, unknown>, result: string, durationMs: number): void {
    this.db.logAudit(agentId, 'tool_call', { tool: toolName, args, result }, 'agent', durationMs);
  }

  /** Log an MCP request */
  logMcpRequest(agentId: string, server: string, method: string, params: Record<string, unknown>, durationMs: number): void {
    this.db.logAudit(agentId, 'mcp_request', { server, method, params }, 'mcp', durationMs);
  }

  /** Log a schedule execution */
  logScheduleRun(agentId: string, scheduleName: string, prompt: string, result: string, durationMs: number): void {
    this.db.logAudit(agentId, 'schedule_run', { schedule: scheduleName, prompt, result }, 'scheduler', durationMs);
  }

  /** Log knowledge read access */
  logKnowledgeRead(agentId: string, sourceId: string, query: string, resultCount: number, durationMs: number): void {
    this.db.logAudit(agentId, 'knowledge_read', { sourceId, query, resultCount }, 'knowledge', durationMs);
  }

  /** Log knowledge write/update */
  logKnowledgeWrite(agentId: string, sourceId: string, operation: string, details: Record<string, unknown>, durationMs: number): void {
    this.db.logAudit(agentId, 'knowledge_write', { sourceId, operation, ...details }, 'knowledge', durationMs);
  }
}
