import { Bot, InputFile } from 'grammy';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Section } from '../types/index.js';

const STUB_COMMANDS = [
  'todo',
  'search',
  'remember',
  'prep',
  'metrics',
  'status',
  'blocked',
  'decision',
  'read',
] as const;

export class TelegramService {
  private bot: Bot;
  private commandHandlers = new Map<
    string,
    (text: string, messageId: number) => Promise<void>
  >();
  private messageHandler:
    | ((text: string, messageId: number) => Promise<void>)
    | null = null;

  constructor(token: string, private chatId: string) {
    this.bot = new Bot(token);
    this.setupMiddleware();
    this.registerStubCommands();
    this.setupCommandDispatch();
    this.setupMessageDispatch();
  }

  /**
   * Middleware: silently ignore messages not from the configured chatId.
   */
  private setupMiddleware(): void {
    this.bot.use(async (ctx, next) => {
      if (ctx.chat?.id.toString() !== this.chatId) {
        return; // silently ignore
      }
      await next();
    });
  }

  /**
   * Register stub handlers for all predefined commands.
   */
  private registerStubCommands(): void {
    for (const cmd of STUB_COMMANDS) {
      this.commandHandlers.set(cmd, async (text, messageId) => {
        await this.send('Not implemented yet', { replyTo: messageId });
      });
    }
  }

  /**
   * Set up grammy command listeners that delegate to the registered handlers map.
   * This way later calls to onCommand() override stubs without re-registering with grammy.
   */
  private setupCommandDispatch(): void {
    for (const cmd of STUB_COMMANDS) {
      this.bot.command(cmd, async (ctx) => {
        const messageId = ctx.message?.message_id;
        if (messageId === undefined) return;

        const rawText = ctx.message?.text ?? '';
        // Strip the /command part, leaving just the argument text
        const text = rawText.replace(/^\/\w+(@\w+)?(\s|$)/, '').trim();
        const handler = this.commandHandlers.get(cmd);
        if (!handler) return;

        const stopTyping = this.startTyping();
        try {
          await handler(text, messageId);
        } catch (err) {
          console.error(`Error in /${cmd} handler:`, err);
          await this.send('Something went wrong. Please try again.', {
            replyTo: messageId,
          });
        } finally {
          stopTyping();
        }
      });
    }
  }

  /**
   * Set up a catch-all for non-command text messages.
   */
  private setupMessageDispatch(): void {
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      // Skip if it looks like a command (starts with /)
      if (text.startsWith('/')) return;

      const messageId = ctx.message.message_id;
      if (!this.messageHandler) return;

      const stopTyping = this.startTyping();
      try {
        await this.messageHandler(text, messageId);
      } catch (err) {
        console.error('Error in message handler:', err);
        await this.send('Something went wrong. Please try again.', {
          replyTo: messageId,
        });
      } finally {
        stopTyping();
      }
    });
  }

  /**
   * Start the bot using long polling.
   */
  start(): void {
    this.bot.start({
      onStart: () => {
        console.log('Telegram bot started (long polling)');
      },
    });
  }

  /**
   * Gracefully stop the bot.
   */
  stop(): void {
    this.bot.stop();
  }

  /**
   * Send "typing..." indicator. Repeats every 4s until the returned stop function is called.
   */
  startTyping(): () => void {
    const send = () => {
      this.bot.api.sendChatAction(this.chatId, 'typing').catch(() => {});
    };
    send();
    const interval = setInterval(send, 4_000);
    return () => clearInterval(interval);
  }

  /**
   * Send a text message to the configured chat.
   * Returns the message_id of the sent message.
   */
  async send(
    text: string,
    options?: { parseMode?: 'HTML' | 'MarkdownV2'; replyTo?: number },
  ): Promise<number> {
    const msg = await this.bot.api.sendMessage(this.chatId, text, {
      parse_mode: options?.parseMode,
      reply_parameters: options?.replyTo
        ? { message_id: options.replyTo }
        : undefined,
    });
    return msg.message_id;
  }

  /**
   * Send a file from the filesystem to the configured chat.
   */
  async sendFile(path: string, caption?: string): Promise<void> {
    const fileData = await readFile(path);
    const inputFile = new InputFile(fileData, basename(path));
    await this.bot.api.sendDocument(this.chatId, inputFile, {
      caption,
    });
  }

  /**
   * Register (or override) a command handler. Command should be without the leading slash.
   */
  onCommand(
    command: string,
    handler: (text: string, messageId: number) => Promise<void>,
  ): void {
    this.commandHandlers.set(command, handler);
  }

  /**
   * Register a handler for free-text messages (non-command).
   */
  onMessage(
    handler: (text: string, messageId: number) => Promise<void>,
  ): void {
    this.messageHandler = handler;
  }
}

/**
 * Format sections into Telegram HTML with bold titles and bullet points.
 */
export function formatBriefing(sections: Section[]): string {
  return sections
    .map((section) => {
      const title = `<b>${escapeHtml(section.title)}</b>`;
      const items = section.items
        .map((item) => `  \u2022 ${escapeHtml(item)}`)
        .join('\n');
      return items.length > 0 ? `${title}\n${items}` : title;
    })
    .join('\n\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
