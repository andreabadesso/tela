import type { DatabaseService } from '../core/database.js';
import type { TaskStatusUpdateEvent } from './types.js';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

/**
 * Delivers A2A push notifications (webhooks) when task status changes.
 * Retries up to 3 times with exponential backoff.
 */
export class PushNotifier {
  constructor(private db: DatabaseService) {}

  async notify(taskId: string, event: TaskStatusUpdateEvent): Promise<void> {
    const configs = this.db.getA2APushConfigsForTask(taskId);
    if (configs.length === 0) return;

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tasks/status',
      params: event,
    });

    await Promise.allSettled(
      configs.map(config => this.deliver(config.url, payload, config.token ?? undefined)),
    );
  }

  private async deliver(url: string, payload: string, token?: string): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) return;

        // Don't retry client errors (4xx) except 429
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          console.warn(`[a2a:push] Client error ${response.status} for ${url}, not retrying`);
          return;
        }

        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      // Exponential backoff before retry
      if (attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    console.error(`[a2a:push] Failed to deliver to ${url} after ${MAX_RETRIES} attempts:`, lastError?.message);
  }
}
