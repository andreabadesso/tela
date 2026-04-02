import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import cron from 'node-cron';
import type { DatabaseService } from '../core/database.js';
import type { JobRegistry } from '../jobs/registry.js';
import type { AgentService } from '../agent/service.js';

export interface ScheduleToolsContext {
  /** Channel ID the request originated from (e.g., Telegram channel). */
  sourceChannelId?: string;
  /** Platform thread ID within that channel. */
  sourceThreadId?: string;
  /** Source platform name (e.g., 'telegram', 'slack', 'web'). */
  sourcePlatform?: string;
}

/**
 * Build an MCP server that gives agents the ability to schedule jobs.
 * Scoped to the calling agent — defaults to self-scheduling.
 * When sourceContext is provided, scheduled jobs default to notifying
 * the channel/thread the request came from.
 */
export function buildScheduleMcpServer(
  db: DatabaseService,
  jobRegistry: JobRegistry,
  agentService: AgentService,
  callingAgentId: string,
  sourceContext?: ScheduleToolsContext,
) {
  const tools = [
    // ─── schedule_job ──────────────────────────────────────────
    tool(
      'schedule_job',
      'Schedule a job to run later. Use type "one_shot" with run_at for a single future execution, or type "cron" with cron_expression for recurring execution. Results are stored and sent via notification channels.',
      {
        name: z.string().describe('Human-readable job name'),
        prompt: z.string().describe('The prompt/instruction to execute when the job fires, OR the literal message to deliver (if mode is "message")'),
        type: z.enum(['cron', 'one_shot']).describe('Job type: "cron" for recurring, "one_shot" for a single future execution'),
        mode: z.enum(['agent', 'message']).optional().describe('Execution mode. "agent" (default) runs the prompt through the agent. "message" delivers the prompt text literally without agent processing. Use "message" for simple notifications/reminders.'),
        cron_expression: z.string().optional().describe('Cron expression (required for type "cron"). E.g., "0 5 * * *" for daily at 5 AM'),
        run_at: z.string().optional().describe('ISO 8601 datetime for one-shot jobs. E.g., "2026-04-02T17:00:00Z". Either run_at or delay_seconds is required for one_shot.'),
        delay_seconds: z.number().optional().describe('Delay in seconds from now for one-shot jobs. Use this instead of run_at for short delays (e.g., 5, 10, 30, 60). The server computes the exact timestamp. Preferred for anything under 5 minutes.'),
        agent_id: z.string().optional().describe('Target agent to run the job (defaults to the current agent)'),
        target_channel: z.string().optional().describe('Custom output destination in "platform:destination" format. E.g., "telegram:123456789" or "slack:@username" or "slack:#channel"'),
        notification_channels: z.array(z.string()).optional().describe('Override default notification channel IDs'),
      },
      async (args) => {
        // Validate type-specific fields
        if (args.type === 'cron') {
          if (!args.cron_expression) {
            return { content: [{ type: 'text' as const, text: 'Error: cron_expression is required for type "cron".' }] };
          }
          if (!cron.validate(args.cron_expression)) {
            return { content: [{ type: 'text' as const, text: `Error: Invalid cron expression "${args.cron_expression}".` }] };
          }
        }

        // Resolve run_at for one-shot jobs
        let resolvedRunAt = args.run_at ?? null;
        if (args.type === 'one_shot') {
          if (args.delay_seconds != null) {
            // Compute run_at from delay
            resolvedRunAt = new Date(Date.now() + args.delay_seconds * 1000).toISOString();
          } else if (!args.run_at) {
            return { content: [{ type: 'text' as const, text: 'Error: either run_at or delay_seconds is required for type "one_shot".' }] };
          } else {
            const runAt = new Date(args.run_at);
            if (isNaN(runAt.getTime())) {
              return { content: [{ type: 'text' as const, text: `Error: Invalid ISO datetime "${args.run_at}".` }] };
            }
            // Allow up to 60s of slack for agent processing time
            if (runAt.getTime() < Date.now() - 60_000) {
              return { content: [{ type: 'text' as const, text: 'Error: run_at is too far in the past.' }] };
            }
          }
        }

        // Resolve target agent
        const targetAgentId = args.agent_id || callingAgentId;

        // Permission check for delegated scheduling
        if (targetAgentId !== callingAgentId) {
          const callerConfig = db.getAgent(callingAgentId);
          const permissions = JSON.parse(callerConfig?.permissions || '{}');
          const canScheduleFor: string[] = permissions.can_schedule_for || [];

          if (!canScheduleFor.includes('*') && !canScheduleFor.includes(targetAgentId)) {
            return { content: [{ type: 'text' as const, text: `Error: You do not have permission to schedule jobs for agent "${targetAgentId}". Required permission: can_schedule_for.` }] };
          }

          const targetConfig = db.getAgent(targetAgentId);
          if (!targetConfig || !targetConfig.enabled) {
            return { content: [{ type: 'text' as const, text: `Error: Target agent "${targetAgentId}" not found or disabled.` }] };
          }
        }

        const execMode = args.mode ?? 'agent';

        // Resolve target channel: explicit > source channel > broadcast
        let resolvedTargetChannel = args.target_channel ?? null;
        if (!resolvedTargetChannel && sourceContext?.sourceChannelId && sourceContext.sourcePlatform) {
          // Default to the channel the request came from
          const destination = sourceContext.sourceThreadId || sourceContext.sourceChannelId;
          resolvedTargetChannel = `${sourceContext.sourcePlatform}:${destination}`;
        }

        // Create the schedule in the database
        const schedule = db.createSchedule({
          id: crypto.randomUUID(),
          name: args.name,
          cron_expression: args.cron_expression || '',
          agent_id: targetAgentId,
          prompt: args.prompt,
          notification_channels: args.notification_channels
            ? JSON.stringify(args.notification_channels)
            : '["telegram"]',
          enabled: 1,
          last_run_at: null,
          last_result: null,
          type: args.type,
          mode: execMode,
          run_at: resolvedRunAt,
          created_by_agent_id: callingAgentId,
          target_channel: resolvedTargetChannel,
          status: 'active',
        });

        // Register and dynamically activate in the JobRegistry
        const handler = execMode === 'message'
          ? () => Promise.resolve(args.prompt) // Deliver literally
          : () => agentService.process(targetAgentId, {
              text: args.prompt,
              source: 'schedule',
            }).then((r) => r.text);

        const jobName = `schedule:${schedule.id}`;
        jobRegistry.register({
          name: jobName,
          schedule: args.cron_expression || '',
          type: args.type,
          runAt: resolvedRunAt ?? undefined,
          targetChannel: resolvedTargetChannel ?? undefined,
          handler,
          channel: 'telegram',
          enabled: true,
        });
        jobRegistry.startJob(jobName);

        const summary = args.type === 'cron'
          ? `Recurring job "${args.name}" scheduled with cron "${args.cron_expression}".`
          : `One-shot job "${args.name}" scheduled for ${resolvedRunAt}.`;

        return {
          content: [{ type: 'text' as const, text: `${summary}\nSchedule ID: ${schedule.id}` }],
        };
      },
    ),

    // ─── list_scheduled_jobs ───────────────────────────────────
    tool(
      'list_scheduled_jobs',
      'List scheduled jobs. Shows jobs created by this agent by default.',
      {
        include_all: z.boolean().optional().describe('Show all schedules, not just ones created by this agent'),
        status: z.enum(['active', 'completed', 'disabled', 'expired']).optional().describe('Filter by status'),
      },
      async (args) => {
        let schedules = args.include_all
          ? db.getSchedules()
          : db.getSchedulesByCreator(callingAgentId);

        if (args.status) {
          schedules = schedules.filter((s) => s.status === args.status);
        }

        if (schedules.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No scheduled jobs found.' }] };
        }

        const formatted = schedules.map((s) => {
          const timing = s.type === 'cron'
            ? `cron: ${s.cron_expression}`
            : `run_at: ${s.run_at}`;
          return [
            `[${s.id}] ${s.name}`,
            `  Type: ${s.type} | Status: ${s.status} | Enabled: ${s.enabled ? 'yes' : 'no'}`,
            `  ${timing}`,
            `  Agent: ${s.agent_id}${s.created_by_agent_id ? ` (created by: ${s.created_by_agent_id})` : ''}`,
            `  Prompt: ${s.prompt.slice(0, 100)}${s.prompt.length > 100 ? '...' : ''}`,
            s.target_channel ? `  Target: ${s.target_channel}` : null,
            s.last_run_at ? `  Last run: ${s.last_run_at}` : null,
          ].filter(Boolean).join('\n');
        }).join('\n\n');

        return { content: [{ type: 'text' as const, text: formatted }] };
      },
    ),

    // ─── manage_scheduled_job ──────────────────────────────────
    tool(
      'manage_scheduled_job',
      'Update, enable, disable, or delete a scheduled job.',
      {
        schedule_id: z.string().describe('The schedule ID to manage'),
        action: z.enum(['disable', 'enable', 'delete', 'update']).describe('Action to perform'),
        updates: z.object({
          prompt: z.string().optional(),
          cron_expression: z.string().optional(),
          run_at: z.string().optional(),
          target_channel: z.string().optional(),
          name: z.string().optional(),
        }).optional().describe('Fields to update (only for "update" action)'),
      },
      async (args) => {
        const schedule = db.getSchedule(args.schedule_id);
        if (!schedule) {
          return { content: [{ type: 'text' as const, text: `Error: Schedule "${args.schedule_id}" not found.` }] };
        }

        // Security: only the creator or an admin-permissioned agent can manage
        if (schedule.created_by_agent_id && schedule.created_by_agent_id !== callingAgentId) {
          const callerConfig = db.getAgent(callingAgentId);
          const permissions = JSON.parse(callerConfig?.permissions || '{}');
          const roles: string[] = permissions.roles || [];
          if (!roles.includes('admin')) {
            return { content: [{ type: 'text' as const, text: 'Error: You can only manage jobs you created.' }] };
          }
        }

        const jobName = `schedule:${schedule.id}`;

        switch (args.action) {
          case 'disable': {
            db.updateSchedule(schedule.id, { enabled: 0 });
            db.updateScheduleStatus(schedule.id, 'disabled');
            jobRegistry.unregister(jobName);
            return { content: [{ type: 'text' as const, text: `Schedule "${schedule.name}" disabled.` }] };
          }

          case 'enable': {
            db.updateSchedule(schedule.id, { enabled: 1 });
            db.updateScheduleStatus(schedule.id, 'active');
            // Re-register and start
            const handler = () =>
              agentService.process(schedule.agent_id, {
                text: schedule.prompt,
                source: 'schedule',
              }).then((r) => r.text);
            jobRegistry.register({
              name: jobName,
              schedule: schedule.cron_expression || '',
              type: schedule.type,
              runAt: schedule.run_at ?? undefined,
              targetChannel: schedule.target_channel ?? undefined,
              handler,
              channel: 'telegram',
              enabled: true,
            });
            jobRegistry.startJob(jobName);
            return { content: [{ type: 'text' as const, text: `Schedule "${schedule.name}" enabled and activated.` }] };
          }

          case 'delete': {
            jobRegistry.unregister(jobName);
            db.deleteSchedule(schedule.id);
            return { content: [{ type: 'text' as const, text: `Schedule "${schedule.name}" deleted.` }] };
          }

          case 'update': {
            if (!args.updates) {
              return { content: [{ type: 'text' as const, text: 'Error: "updates" field is required for the "update" action.' }] };
            }

            // Validate cron if provided
            if (args.updates.cron_expression && !cron.validate(args.updates.cron_expression)) {
              return { content: [{ type: 'text' as const, text: `Error: Invalid cron expression "${args.updates.cron_expression}".` }] };
            }

            // Validate run_at if provided
            if (args.updates.run_at) {
              const runAt = new Date(args.updates.run_at);
              if (isNaN(runAt.getTime())) {
                return { content: [{ type: 'text' as const, text: `Error: Invalid ISO datetime "${args.updates.run_at}".` }] };
              }
              if (runAt.getTime() <= Date.now()) {
                return { content: [{ type: 'text' as const, text: 'Error: run_at must be in the future.' }] };
              }
            }

            const updated = db.updateSchedule(schedule.id, args.updates);

            // Re-register with updated definition if the job is active
            if (updated && updated.enabled && updated.status === 'active') {
              jobRegistry.unregister(jobName);
              const handler = () =>
                agentService.process(updated.agent_id, {
                  text: updated.prompt,
                  source: 'schedule',
                }).then((r) => r.text);
              jobRegistry.register({
                name: jobName,
                schedule: updated.cron_expression || '',
                type: updated.type,
                runAt: updated.run_at ?? undefined,
                targetChannel: updated.target_channel ?? undefined,
                handler,
                channel: 'telegram',
                enabled: true,
              });
              jobRegistry.startJob(jobName);
            }

            return { content: [{ type: 'text' as const, text: `Schedule "${updated?.name || schedule.name}" updated.` }] };
          }
        }
      },
    ),
  ];

  return createSdkMcpServer({
    name: 'schedule-tools',
    version: '1.0.0',
    tools,
  });
}
