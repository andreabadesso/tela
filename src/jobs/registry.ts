import cron from 'node-cron';
import type { TelegramService } from '../services/telegram.js';
import type { DatabaseService } from '../services/database.js';
import type { JobDefinition } from '../types/index.js';

interface ManagedJob {
  definition: JobDefinition;
  task: cron.ScheduledTask | null;
}

export class JobRegistry {
  private jobs = new Map<string, ManagedJob>();

  constructor(
    private telegram: TelegramService,
    private db: DatabaseService,
  ) {}

  register(job: JobDefinition): void {
    if (this.jobs.has(job.name)) {
      this.jobs.get(job.name)!.task?.stop();
    }
    this.jobs.set(job.name, { definition: job, task: null });
  }

  unregister(name: string): void {
    const managed = this.jobs.get(name);
    if (managed) {
      managed.task?.stop();
      this.jobs.delete(name);
    }
  }

  start(): void {
    for (const [name, managed] of this.jobs) {
      if (!managed.definition.enabled) continue;

      managed.task = cron.schedule(
        managed.definition.schedule,
        () => { void this.executeJob(name); },
        { timezone: process.env.TZ || 'America/Sao_Paulo' },
      );
      console.log(`[jobs] Scheduled ${name}: ${managed.definition.schedule}`);
    }
  }

  stop(): void {
    for (const managed of this.jobs.values()) {
      managed.task?.stop();
      managed.task = null;
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

  private async executeJob(name: string): Promise<string> {
    const managed = this.jobs.get(name);
    if (!managed) throw new Error(`Job not found: ${name}`);

    const runId = this.db.startJobRun(name);
    console.log(`[jobs] Running ${name}...`);

    try {
      const output = await managed.definition.handler();
      this.db.finishJobRun(runId, 'success', output);

      if (output && managed.definition.channel === 'telegram') {
        await this.telegram.send(output, { parseMode: 'HTML' });
      }

      console.log(`[jobs] ${name} completed.`);
      return output;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.db.finishJobRun(runId, 'error', undefined, errorMsg);

      const failures = this.db.getConsecutiveFailures(name);
      console.error(`[jobs] ${name} failed (${failures} consecutive):`, errorMsg);

      try {
        await this.telegram.send(
          `⚠️ Job <b>${name}</b> failed: ${errorMsg}`,
          { parseMode: 'HTML' },
        );
      } catch {
        // If we can't notify, just log
        console.error(`[jobs] Failed to send error notification for ${name}`);
      }

      // Auto-disable after 3 consecutive failures
      if (failures >= 3) {
        managed.definition.enabled = false;
        managed.task?.stop();
        managed.task = null;
        try {
          await this.telegram.send(
            `🛑 Job <b>${name}</b> disabled after ${failures} consecutive failures.`,
            { parseMode: 'HTML' },
          );
        } catch {
          console.error(`[jobs] Failed to send disable notification for ${name}`);
        }
      }

      throw err;
    }
  }
}
