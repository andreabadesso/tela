import cron from 'node-cron';
import type { ChannelGateway } from '../channels/gateway.js';
import type { DatabaseService } from '../core/database.js';
import type { JobDefinition } from '../types/index.js';
import type { AgentService } from '../agent/service.js';

interface ManagedJob {
  definition: JobDefinition;
  task: cron.ScheduledTask | null;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_TIMEOUT = 2_147_483_647; // ~24.8 days — setTimeout max safe delay

export class JobRegistry {
  private jobs = new Map<string, ManagedJob>();
  private channelGateway: ChannelGateway | null = null;
  private started = false;

  /** Callback invoked when a one-shot job completes. */
  onOneShotComplete: ((jobName: string) => void) | null = null;

  constructor(private db: DatabaseService) {}

  /** Set the channel gateway for multi-channel job notifications. */
  setChannelGateway(gateway: ChannelGateway): void {
    this.channelGateway = gateway;
  }

  register(job: JobDefinition): void {
    if (this.jobs.has(job.name)) {
      const existing = this.jobs.get(job.name)!;
      existing.task?.stop();
      if (existing.timer) clearTimeout(existing.timer);
    }
    this.jobs.set(job.name, { definition: job, task: null });
  }

  unregister(name: string): void {
    const managed = this.jobs.get(name);
    if (managed) {
      managed.task?.stop();
      if (managed.timer) clearTimeout(managed.timer);
      this.jobs.delete(name);
    }
  }

  /** Load active schedules from the database and register them. */
  async loadSchedulesFromDb(db: DatabaseService, agentService: AgentService): Promise<void> {
    const schedules = db.getActiveSchedules();
    for (const schedule of schedules) {
      // Skip one-shot jobs whose run_at has passed
      if (schedule.type === 'one_shot' && schedule.run_at) {
        const runAt = new Date(schedule.run_at);
        if (runAt.getTime() < Date.now() - 60_000) {
          // More than 1 minute past due — mark as expired
          db.updateScheduleStatus(schedule.id, 'expired');
          console.log(`[jobs] Schedule ${schedule.name} expired (run_at was ${schedule.run_at})`);
          continue;
        }
      }

      const handler = schedule.mode === 'message'
        ? () => Promise.resolve(schedule.prompt)
        : () => agentService.process(schedule.agent_id, {
            text: schedule.prompt,
            source: 'schedule',
          }).then((r) => r.text);

      this.register({
        name: `schedule:${schedule.id}`,
        schedule: schedule.cron_expression || '',
        type: schedule.type,
        runAt: schedule.run_at ?? undefined,
        targetChannel: schedule.target_channel ?? undefined,
        handler,
        enabled: true,
      });
    }
    console.log(`[jobs] Loaded ${schedules.length} schedules from DB.`);
  }

  start(): void {
    this.started = true;
    for (const [name, managed] of this.jobs) {
      if (!managed.definition.enabled) continue;
      this.activateJob(name, managed);
    }
  }

  /** Dynamically activate a single job after start() has been called. */
  startJob(name: string): void {
    const managed = this.jobs.get(name);
    if (!managed || !managed.definition.enabled) return;
    if (managed.task || managed.timer) return; // already active
    this.activateJob(name, managed);
  }

  stop(): void {
    this.started = false;
    for (const managed of this.jobs.values()) {
      managed.task?.stop();
      managed.task = null;
      if (managed.timer) {
        clearTimeout(managed.timer);
        managed.timer = undefined;
      }
    }
  }

  async runNow(name: string): Promise<string> {
    const managed = this.jobs.get(name);
    if (!managed) throw new Error(`Job not found: ${name}`);
    return this.executeJob(name);
  }

  list(): JobDefinition[] {
    return Array.from(this.jobs.values()).map((m) => m.definition);
  }

  private activateJob(name: string, managed: ManagedJob): void {
    if (managed.definition.type === 'one_shot' && managed.definition.runAt) {
      this.scheduleOneShot(name, managed);
    } else {
      managed.task = cron.schedule(
        managed.definition.schedule,
        () => { void this.executeJob(name); },
        { timezone: process.env.TZ || 'America/Sao_Paulo' },
      );
      console.log(`[jobs] Scheduled ${name}: ${managed.definition.schedule}`);
    }
  }

  private scheduleOneShot(name: string, managed: ManagedJob): void {
    const runAt = new Date(managed.definition.runAt!);
    const delayMs = runAt.getTime() - Date.now();

    if (delayMs <= 0) {
      // Past due — run immediately
      console.log(`[jobs] One-shot ${name} is past due, running immediately.`);
      void this.executeJob(name).then(() => this.markOneShotCompleted(name));
      return;
    }

    if (delayMs > MAX_TIMEOUT) {
      // Chain timeouts for very long delays
      console.log(`[jobs] One-shot ${name} scheduled for ${managed.definition.runAt} (chaining timeout, ${Math.round(delayMs / 86_400_000)}d away)`);
      managed.timer = setTimeout(() => {
        managed.timer = undefined;
        this.scheduleOneShot(name, managed);
      }, MAX_TIMEOUT);
    } else {
      console.log(`[jobs] One-shot ${name} scheduled for ${managed.definition.runAt} (${Math.round(delayMs / 1000)}s from now)`);
      managed.timer = setTimeout(async () => {
        managed.timer = undefined;
        try {
          await this.executeJob(name);
        } finally {
          this.markOneShotCompleted(name);
        }
      }, delayMs);
    }
  }

  private markOneShotCompleted(name: string): void {
    const managed = this.jobs.get(name);
    if (managed) {
      managed.definition.enabled = false;
      managed.task = null;
      if (managed.timer) {
        clearTimeout(managed.timer);
        managed.timer = undefined;
      }
    }
    this.onOneShotComplete?.(name);
  }

  private async executeJob(name: string): Promise<string> {
    const managed = this.jobs.get(name);
    if (!managed) throw new Error(`Job not found: ${name}`);

    const runId = this.db.startJobRun(name);
    console.log(`[jobs] Running ${name}...`);

    try {
      const output = await managed.definition.handler();
      this.db.finishJobRun(runId, 'success', output);

      if (output) {
        await this.sendJobOutput(name, output, managed.definition.targetChannel);
      }

      console.log(`[jobs] ${name} completed.`);
      return output;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.db.finishJobRun(runId, 'error', undefined, errorMsg);

      const failures = this.db.getConsecutiveFailures(name);
      console.error(`[jobs] ${name} failed (${failures} consecutive):`, errorMsg);

      try {
        await this.sendJobOutput(name, `⚠️ Job <b>${name}</b> failed: ${errorMsg}`);
      } catch {
        console.error(`[jobs] Failed to send error notification for ${name}`);
      }

      // Auto-disable after 3 consecutive failures
      if (failures >= 3) {
        managed.definition.enabled = false;
        managed.task?.stop();
        managed.task = null;
        if (managed.timer) {
          clearTimeout(managed.timer);
          managed.timer = undefined;
        }
        try {
          await this.sendJobOutput(name, `🛑 Job <b>${name}</b> disabled after ${failures} consecutive failures.`);
        } catch {
          console.error(`[jobs] Failed to send disable notification for ${name}`);
        }
      }

      throw err;
    }
  }

  /**
   * Send job output to the appropriate channels.
   * If a targetChannel is specified, routes to that specific destination.
   * Otherwise tries ChannelGateway, falls back to legacy TelegramService.
   */
  private async sendJobOutput(jobName: string, output: string, targetChannel?: string): Promise<void> {
    // Targeted routing: "platform:destination" format
    if (targetChannel && this.channelGateway) {
      try {
        await this.channelGateway.notifyTarget(targetChannel, { body: output });
        return;
      } catch (err) {
        console.error(`[jobs] Failed to send to target channel ${targetChannel}:`, err);
        // Fall through to default routing
      }
    }

    if (this.channelGateway) {
      // Use all enabled communication channels
      const channels = this.db.getCommunicationChannels();
      const enabled = channels.filter((ch) => ch.enabled);
      if (enabled.length > 0) {
        await this.channelGateway.notify(
          enabled.map((ch) => ch.id),
          { body: output },
        );
        return;
      }
    }

    if (!this.channelGateway) {
      console.warn(`[jobs] No channel gateway configured — output from ${jobName} was not delivered.`);
    }
  }
}
