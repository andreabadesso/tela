import { Bot } from 'grammy';
import type { NotificationChannel, NotificationMessage } from '../types.js';

export class TelegramChannel implements NotificationChannel {
  readonly type = 'telegram' as const;
  private bot: Bot;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly config: Record<string, string>,
  ) {
    this.bot = new Bot(config.bot_token);
  }

  async send(message: NotificationMessage): Promise<void> {
    const parts: string[] = [];
    if (message.title) {
      parts.push(`<b>${escapeHtml(message.title)}</b>`);
    }
    if (message.html) {
      parts.push(message.html);
    } else {
      parts.push(escapeHtml(message.body));
    }
    if (message.priority === 'high') {
      parts.unshift('\u26a0\ufe0f');
    }
    const text = parts.join('\n\n');
    await this.bot.api.sendMessage(this.config.chat_id, text, {
      parse_mode: 'HTML',
    });
  }

  async test(): Promise<boolean> {
    try {
      await this.bot.api.sendMessage(
        this.config.chat_id,
        '\u2705 Tela notification channel test successful.',
      );
      return true;
    } catch {
      return false;
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
