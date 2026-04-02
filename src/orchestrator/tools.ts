import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Orchestrator } from './index.js';
import type { DatabaseService } from '../core/database.js';

/**
 * Create MCP tools that allow agents to communicate with each other
 * via the orchestrator.
 */
export function createOrchestratorTools(orchestrator: Orchestrator, db: DatabaseService) {
  const tools = [
    tool(
      'ask_agent',
      'Send a synchronous query to another agent and get the response. Use this to consult a specialist agent.',
      {
        agentId: z.string().describe('ID of the agent to query'),
        question: z.string().describe('The question or prompt to send'),
      },
      async (args) => {
        try {
          const output = await orchestrator.chat({
            text: args.question,
            source: 'agent',
            metadata: { agentId: args.agentId },
          });
          return {
            content: [{ type: 'text' as const, text: output.text }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error querying agent ${args.agentId}: ${message}` }],
            isError: true,
          };
        }
      },
    ),

    tool(
      'delegate_task',
      'Delegate an async task to another agent. Returns a run_id for tracking. The task runs in the background.',
      {
        taskRef: z.string().describe('Unique reference for this task (e.g. "review-pr-123")'),
        agentId: z.string().describe('ID of the agent to delegate to'),
        prompt: z.string().describe('The task description / prompt'),
      },
      async (args) => {
        try {
          const runId = await orchestrator.assign(args.taskRef, args.agentId, args.prompt);
          return {
            content: [{ type: 'text' as const, text: `Task delegated. run_id: ${runId}` }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error delegating task: ${message}` }],
            isError: true,
          };
        }
      },
    ),

    tool(
      'request_approval',
      'Request human approval before proceeding with an action. Creates an approval request in the queue.',
      {
        agentId: z.string().describe('ID of the requesting agent'),
        type: z.string().describe('Type of approval (e.g. "deploy", "budget_override", "data_access")'),
        context: z.string().describe('JSON string with details about what needs approval'),
      },
      async (args) => {
        try {
          const approval = db.createApproval({
            id: crypto.randomUUID(),
            agent_id: args.agentId,
            type: args.type,
            context: args.context,
          });
          return {
            content: [{
              type: 'text' as const,
              text: `Approval requested. id: ${approval.id}, type: ${args.type}, status: ${approval.status}. Waiting for human review.`,
            }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error requesting approval: ${message}` }],
            isError: true,
          };
        }
      },
    ),
  ];

  return createSdkMcpServer({
    name: 'orchestrator-tools',
    version: '1.0.0',
    tools,
  });
}
