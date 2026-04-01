import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../types.js';

// @slack/bolt and @slack/web-api are optional peer dependencies.
// They are dynamically imported at runtime to avoid hard failures
// when Slack isn't configured.

/**
 * Slack adapter — wraps @slack/bolt for bidirectional messaging.
 *
 * Config keys:
 *   bot_token      — xoxb-... Bot User OAuth Token
 *   app_token      — xapp-... App-Level Token (for Socket Mode)
 *   signing_secret — Slack signing secret
 *
 * Thread ID encoding: "${channelId}:${threadTs}"
 *   If no thread_ts, uses the message ts as the thread anchor.
 *
 * Note: Requires @slack/bolt as a dependency.
 * Install with: npm install @slack/bolt
 */
export class SlackAdapter implements ChannelAdapter {
  readonly platform = 'slack' as const;

  private app: any = null; // slack bolt App instance
  private channelId = '';

  async start(
    config: Record<string, string>,
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): Promise<void> {
    let App: any;
    try {
      // @ts-expect-error — @slack/bolt is an optional peer dependency
      const bolt = await import('@slack/bolt');
      App = bolt.default?.App ?? bolt.App;
    } catch {
      throw new Error(
        'Slack adapter requires @slack/bolt. Install with: npm install @slack/bolt',
      );
    }

    this.app = new App({
      token: config.bot_token,
      appToken: config.app_token,
      signingSecret: config.signing_secret,
      socketMode: !!config.app_token,
    });

    // Listen for @mentions
    this.app.event('app_mention', async ({ event, client }: any) => {
      const threadTs = event.thread_ts || event.ts;
      const threadId = `${event.channel}:${threadTs}`;

      // Fetch thread context
      let threadMessages: any[] = [];
      try {
        const result = await client.conversations.replies({
          channel: event.channel,
          ts: threadTs,
          inclusive: true,
        });
        threadMessages = result.messages ?? [];
      } catch { /* ignore — thread context is best-effort */ }

      const msg: InboundMessage = {
        channelId: this.channelId,
        platform: 'slack',
        threadId,
        parentMessageId: event.thread_ts,
        sender: {
          platformId: event.user,
          displayName: event.user, // resolved later by gateway if needed
        },
        text: event.text.replace(/<@[A-Z0-9]+>/g, '').trim(), // strip mention
        metadata: {
          messageTs: event.ts,
          threadTs,
          slackChannel: event.channel,
          threadMessages: threadMessages.map((m: any) => ({
            user: m.user,
            text: m.text,
            ts: m.ts,
            botId: m.bot_id,
          })),
        },
      };

      await onMessage(msg);
    });

    // Listen for DMs
    this.app.event('message', async ({ event, client }: any) => {
      // Skip bot messages, subtypes (edits, deletes), and channel messages (handled by app_mention)
      if (event.bot_id || event.subtype || event.channel_type !== 'im') return;

      const threadTs = event.thread_ts || event.ts;
      const threadId = `${event.channel}:${threadTs}`;

      const msg: InboundMessage = {
        channelId: this.channelId,
        platform: 'slack',
        threadId,
        parentMessageId: event.thread_ts,
        sender: {
          platformId: event.user,
          displayName: event.user,
        },
        text: event.text,
        metadata: {
          messageTs: event.ts,
          threadTs,
          slackChannel: event.channel,
          channelType: 'im',
        },
      };

      await onMessage(msg);
    });

    await this.app.start();
    console.log(`[slack-adapter] Bot started (channel: ${this.channelId})`);
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
  }

  async sendMessage(platformThreadId: string, message: OutboundMessage): Promise<string> {
    if (!this.app) throw new Error('Slack adapter not started');

    const { channel, threadTs } = this.decodeThreadId(platformThreadId);

    const result = await this.app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: message.text,
      mrkdwn: true,
    });

    return result.ts ?? '';
  }

  async editMessage(platformThreadId: string, messageId: string, message: OutboundMessage): Promise<void> {
    if (!this.app) throw new Error('Slack adapter not started');

    const { channel } = this.decodeThreadId(platformThreadId);

    await this.app.client.chat.update({
      channel,
      ts: messageId,
      text: message.text,
    });
  }

  async fetchThreadHistory(platformThreadId: string, limit = 50): Promise<InboundMessage[]> {
    if (!this.app) return [];

    const { channel, threadTs } = this.decodeThreadId(platformThreadId);

    try {
      const result = await this.app.client.conversations.replies({
        channel,
        ts: threadTs,
        inclusive: true,
        limit,
      });

      return (result.messages ?? []).map((m: any) => ({
        channelId: this.channelId,
        platform: 'slack' as const,
        threadId: platformThreadId,
        sender: {
          platformId: m.user ?? m.bot_id ?? 'unknown',
          displayName: m.user ?? 'bot',
        },
        text: m.text ?? '',
        metadata: { ts: m.ts, botId: m.bot_id },
      }));
    } catch {
      return [];
    }
  }

  async test(config: Record<string, string>): Promise<boolean> {
    try {
      // @ts-expect-error — @slack/web-api is an optional peer dependency
      const { WebClient } = await import('@slack/web-api');
      const client = new WebClient(config.bot_token);
      const result = await client.auth.test();
      return !!result.ok;
    } catch {
      return false;
    }
  }

  setChannelId(id: string): void {
    this.channelId = id;
  }

  private decodeThreadId(threadId: string): { channel: string; threadTs: string } {
    const colonIndex = threadId.indexOf(':');
    return {
      channel: threadId.slice(0, colonIndex),
      threadTs: threadId.slice(colonIndex + 1),
    };
  }
}
