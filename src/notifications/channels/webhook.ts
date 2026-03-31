import type { NotificationChannel, NotificationMessage } from '../types.js';

export class WebhookChannel implements NotificationChannel {
  readonly type = 'webhook' as const;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly config: Record<string, string>,
  ) {}

  async send(message: NotificationMessage): Promise<void> {
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (this.config.headers) {
      try {
        const customHeaders = JSON.parse(this.config.headers) as Record<string, string>;
        headers = { ...headers, ...customHeaders };
      } catch {
        // ignore invalid headers JSON
      }
    }

    const response = await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
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
