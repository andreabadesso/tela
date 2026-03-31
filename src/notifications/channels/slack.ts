import type { NotificationChannel, NotificationMessage } from '../types.js';

export class SlackChannel implements NotificationChannel {
  readonly type = 'slack' as const;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly config: Record<string, string>,
  ) {}

  async send(message: NotificationMessage): Promise<void> {
    const blocks: unknown[] = [];

    if (message.title) {
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: message.title },
      });
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: message.body },
    });

    if (message.priority === 'high') {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: ':warning: *High Priority*' }],
      });
    }

    const payload = {
      text: message.title ?? message.body,
      blocks,
    };

    const response = await fetch(this.config.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
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
