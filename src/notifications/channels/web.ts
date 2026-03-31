import type { NotificationChannel, NotificationMessage } from '../types.js';
import type { DatabaseService } from '../../services/database.js';

export class WebChannel implements NotificationChannel {
  readonly type = 'web' as const;
  private db: DatabaseService | null = null;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly config: Record<string, string>,
  ) {}

  /** Inject the database service after construction. */
  setDb(db: DatabaseService): void {
    this.db = db;
  }

  async send(message: NotificationMessage): Promise<void> {
    if (!this.db) {
      throw new Error('WebChannel: database not configured');
    }
    this.db.createNotification({
      channel_id: this.id,
      title: message.title ?? null,
      body: message.body,
      priority: message.priority,
      source: message.source,
    });
    // TODO: push via WebSocket
  }

  async test(): Promise<boolean> {
    try {
      await this.send({
        title: 'Test Notification',
        body: 'Tela notification channel test successful.',
        priority: 'normal',
        source: 'test',
      });
      return true;
    } catch {
      return false;
    }
  }
}
