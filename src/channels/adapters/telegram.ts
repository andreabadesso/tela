import { Bot, InputFile } from 'grammy';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../types.js';

/**
 * Telegram adapter — wraps grammy Bot for bidirectional messaging.
 *
 * Config keys:
 *   bot_token  — Telegram Bot API token
 *   chat_id    — (optional) restrict to a single chat; if omitted, accepts all chats
 *
 * Thread ID encoding:
 *   Simple chats: "${chatId}"
 *   Forum topics: "${chatId}:${messageThreadId}"
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram' as const;

  private bot: Bot | null = null;
  private channelId = '';

  async start(
    config: Record<string, string>,
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): Promise<void> {
    const token = config.bot_token;
    if (!token) throw new Error('Telegram adapter requires bot_token in config');

    this.bot = new Bot(token);
    const restrictChatId = config.chat_id || null;

    // Middleware: optionally restrict to configured chat
    if (restrictChatId) {
      this.bot.use(async (ctx, next) => {
        if (ctx.chat?.id.toString() !== restrictChatId) return;
        await next();
      });
    }

    // Handle all text messages
    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const forumTopicId = ctx.message.message_thread_id;
      const threadId = forumTopicId ? `${chatId}:${forumTopicId}` : chatId;

      // Parse command if message starts with /
      const rawText = ctx.message.text;
      let text = rawText;
      let command: string | undefined;
      let commandArgs: string | undefined;

      const cmdMatch = rawText.match(/^\/(\w+)(@\w+)?(\s|$)(.*)/s);
      if (cmdMatch) {
        command = cmdMatch[1];
        commandArgs = (cmdMatch[4] ?? '').trim();
        text = commandArgs || `/${command}`; // keep original if no args
      }

      const msg: InboundMessage = {
        channelId: this.channelId,
        platform: 'telegram',
        threadId,
        parentMessageId: ctx.message.reply_to_message?.message_id?.toString(),
        sender: {
          platformId: ctx.from.id.toString(),
          displayName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
        },
        text,
        metadata: {
          messageId: ctx.message.message_id,
          chatType: ctx.chat.type,
          chatTitle: 'title' in ctx.chat ? ctx.chat.title : undefined,
          command,
          commandArgs,
        },
      };

      await onMessage(msg);
    });

    // Catch polling errors to prevent process crash
    this.bot.catch((err) => {
      console.error(`[telegram-adapter] Bot error (channel: ${this.channelId}):`, err.message ?? err);
    });

    this.bot.start({
      onStart: () => {
        console.log(`[telegram-adapter] Bot started (channel: ${this.channelId})`);
      },
    });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
  }

  async sendMessage(platformThreadId: string, message: OutboundMessage): Promise<string> {
    if (!this.bot) throw new Error('Telegram adapter not started');

    const { chatId, topicId } = this.decodeThreadId(platformThreadId);
    const text = message.html ?? escapeHtml(message.text);

    const msg = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: message.html ? 'HTML' : undefined,
      message_thread_id: topicId ? parseInt(topicId, 10) : undefined,
      reply_parameters: message.replyToMessageId
        ? { message_id: parseInt(message.replyToMessageId, 10) }
        : undefined,
    });

    return msg.message_id.toString();
  }

  async editMessage(platformThreadId: string, messageId: string, message: OutboundMessage): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter not started');

    const { chatId } = this.decodeThreadId(platformThreadId);
    const text = message.html ?? escapeHtml(message.text);

    await this.bot.api.editMessageText(chatId, parseInt(messageId, 10), text, {
      parse_mode: message.html ? 'HTML' : undefined,
    });
  }

  async sendFile(platformThreadId: string, file: { data: Buffer; name: string; caption?: string }): Promise<string> {
    if (!this.bot) throw new Error('Telegram adapter not started');
    const { chatId, topicId } = this.decodeThreadId(platformThreadId);
    const inputFile = new InputFile(file.data, file.name);
    const msg = await this.bot.api.sendDocument(chatId, inputFile, {
      caption: file.caption,
      message_thread_id: topicId ? parseInt(topicId, 10) : undefined,
    });
    return msg.message_id.toString();
  }

  async fetchThreadHistory(): Promise<InboundMessage[]> {
    // Telegram Bot API doesn't support fetching chat history.
    // Thread history is maintained via stored chat_messages in the DB.
    return [];
  }

  async test(config: Record<string, string>): Promise<boolean> {
    try {
      const bot = new Bot(config.bot_token);
      const me = await bot.api.getMe();
      return !!me.id;
    } catch {
      return false;
    }
  }

  /** Send typing indicator. Returns a stop function. */
  startTyping(platformThreadId: string): () => void {
    if (!this.bot) return () => {};
    const { chatId } = this.decodeThreadId(platformThreadId);
    const bot = this.bot;
    const send = () => { bot.api.sendChatAction(chatId, 'typing').catch(() => {}); };
    send();
    const interval = setInterval(send, 4_000);
    return () => clearInterval(interval);
  }

  /** Set the channel ID (called by gateway before start). */
  setChannelId(id: string): void {
    this.channelId = id;
  }

  private decodeThreadId(threadId: string): { chatId: string; topicId?: string } {
    const parts = threadId.split(':');
    return { chatId: parts[0], topicId: parts[1] };
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
