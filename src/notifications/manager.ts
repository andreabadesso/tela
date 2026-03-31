import type { DatabaseService } from '../services/database.js';
import type { NotificationChannelRow } from '../types/index.js';
import type { NotificationChannel, NotificationMessage } from './types.js';
import { TelegramChannel } from './channels/telegram.js';
import { SlackChannel } from './channels/slack.js';
import { EmailChannel } from './channels/email.js';
import { WebhookChannel } from './channels/webhook.js';
import { WebChannel } from './channels/web.js';

export class NotificationManager {
  private channels = new Map<string, NotificationChannel>();

  constructor(private db: DatabaseService) {}

  /** Load enabled channels from the database. */
  async loadFromDb(): Promise<void> {
    const rows = this.db.getNotificationChannels();
    for (const row of rows) {
      if (!row.enabled) continue;
      const channel = createChannel(row, this.db);
      if (channel) this.channels.set(row.id, channel);
    }
  }

  /** Send a message to specific channels by ID. */
  async send(channelIds: string[], message: NotificationMessage): Promise<void> {
    const promises = channelIds.map(async (id) => {
      const channel = this.channels.get(id);
      if (!channel) return;
      try {
        await channel.send(message);
      } catch (err) {
        console.error(`[notifications] Failed to send to ${id}:`, err);
      }
    });
    await Promise.all(promises);
  }

  /** Send a message to all enabled channels. */
  async broadcast(message: NotificationMessage): Promise<void> {
    await this.send(Array.from(this.channels.keys()), message);
  }

  /** Test a specific channel. */
  async test(channelId: string): Promise<boolean> {
    const channel = this.channels.get(channelId);
    if (!channel) return false;
    return channel.test();
  }

  /** Reload all channels from the database. */
  async reload(): Promise<void> {
    this.channels.clear();
    await this.loadFromDb();
  }

  /** Get channel count (useful for diagnostics). */
  get size(): number {
    return this.channels.size;
  }
}

function createChannel(
  row: NotificationChannelRow,
  db: DatabaseService,
): NotificationChannel | null {
  let config: Record<string, string>;
  try {
    config = JSON.parse(row.config);
  } catch {
    console.error(`[notifications] Invalid config JSON for channel ${row.id}`);
    return null;
  }

  switch (row.type) {
    case 'telegram':
      return new TelegramChannel(row.id, row.name, config);
    case 'slack':
      return new SlackChannel(row.id, row.name, config);
    case 'email':
      return new EmailChannel(row.id, row.name, config);
    case 'webhook':
      return new WebhookChannel(row.id, row.name, config);
    case 'web': {
      const ch = new WebChannel(row.id, row.name, config);
      ch.setDb(db);
      return ch;
    }
    default:
      return null;
  }
}
