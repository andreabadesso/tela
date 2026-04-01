import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../types.js';

/**
 * Jira adapter — listens for comment @mentions and responds in-thread.
 *
 * Config keys:
 *   base_url         — Jira Cloud base URL (e.g., https://org.atlassian.net)
 *   api_token        — Jira API token
 *   user_email       — Jira user email (for Basic auth)
 *   bot_mention_name — Name to detect in @mentions (e.g., "tela-bot")
 *   poll_interval_ms — Polling interval in ms (default: 30000)
 *
 * Thread ID encoding: "${issueKey}" (e.g., "ENG-123")
 *
 * This adapter uses polling for comment detection.
 * Webhook mode can be added later for Jira Cloud Connect apps.
 */
export class JiraAdapter implements ChannelAdapter {
  readonly platform = 'jira' as const;

  private channelId = '';
  private config: Record<string, string> = {};
  private onMessage: ((msg: InboundMessage) => Promise<void>) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTime: string = new Date().toISOString();

  async start(
    config: Record<string, string>,
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): Promise<void> {
    this.config = config;
    this.onMessage = onMessage;
    this.lastPollTime = new Date().toISOString();

    const intervalMs = parseInt(config.poll_interval_ms || '30000', 10);
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
    console.log(`[jira-adapter] Polling started every ${intervalMs}ms (channel: ${this.channelId})`);
  }

  /**
   * Process a Jira webhook payload. Can be used instead of polling
   * when webhooks are configured.
   */
  async handleWebhook(event: string, payload: any): Promise<void> {
    if (!this.onMessage) return;
    if (event !== 'comment_created') return;

    const comment = payload.comment;
    const issue = payload.issue;
    if (!comment || !issue) return;

    const bodyText = this.extractTextFromAdf(comment.body);
    const botName = this.config.bot_mention_name;
    if (botName && !bodyText.includes(`@${botName}`)) return;

    const msg: InboundMessage = {
      channelId: this.channelId,
      platform: 'jira',
      threadId: issue.key,
      sender: {
        platformId: comment.author?.accountId ?? 'unknown',
        displayName: comment.author?.displayName ?? 'Unknown',
      },
      text: botName ? bodyText.replace(new RegExp(`@${botName}\\s*`, 'g'), '').trim() : bodyText,
      metadata: {
        commentId: comment.id,
        issueKey: issue.key,
        issueSummary: issue.fields?.summary,
        issueStatus: issue.fields?.status?.name,
        issueType: issue.fields?.issuetype?.name,
        priority: issue.fields?.priority?.name,
      },
    };

    await this.onMessage(msg);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.onMessage = null;
  }

  async sendMessage(platformThreadId: string, message: OutboundMessage): Promise<string> {
    const issueKey = platformThreadId;
    const url = `${this.config.base_url}/rest/api/3/issue/${issueKey}/comment`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${btoa(`${this.config.user_email}:${this.config.api_token}`)}`,
      },
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: message.text }],
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Jira comment failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { id: string };
    return data.id;
  }

  async editMessage(platformThreadId: string, messageId: string, message: OutboundMessage): Promise<void> {
    const issueKey = platformThreadId;
    const url = `${this.config.base_url}/rest/api/3/issue/${issueKey}/comment/${messageId}`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${btoa(`${this.config.user_email}:${this.config.api_token}`)}`,
      },
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: message.text }],
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Jira comment edit failed: ${response.status}`);
    }
  }

  async fetchThreadHistory(platformThreadId: string, limit = 50): Promise<InboundMessage[]> {
    const issueKey = platformThreadId;
    const auth = `Basic ${btoa(`${this.config.user_email}:${this.config.api_token}`)}`;

    try {
      const [issueRes, commentsRes] = await Promise.all([
        fetch(`${this.config.base_url}/rest/api/3/issue/${issueKey}`, {
          headers: { Authorization: auth },
        }),
        fetch(`${this.config.base_url}/rest/api/3/issue/${issueKey}/comment?maxResults=${limit}&orderBy=created`, {
          headers: { Authorization: auth },
        }),
      ]);

      if (!issueRes.ok || !commentsRes.ok) return [];

      const issue = await issueRes.json() as any;
      const commentsData = await commentsRes.json() as any;

      const messages: InboundMessage[] = [
        {
          channelId: this.channelId,
          platform: 'jira',
          threadId: issueKey,
          sender: {
            platformId: issue.fields?.creator?.accountId ?? 'unknown',
            displayName: issue.fields?.creator?.displayName ?? 'Unknown',
          },
          text: `${issue.fields?.summary ?? ''}\n\n${this.extractTextFromAdf(issue.fields?.description)}`,
          metadata: { type: 'issue_body', status: issue.fields?.status?.name },
        },
      ];

      for (const comment of commentsData.comments ?? []) {
        messages.push({
          channelId: this.channelId,
          platform: 'jira',
          threadId: issueKey,
          sender: {
            platformId: comment.author?.accountId ?? 'unknown',
            displayName: comment.author?.displayName ?? 'Unknown',
          },
          text: this.extractTextFromAdf(comment.body),
          metadata: { commentId: comment.id },
        });
      }

      return messages;
    } catch {
      return [];
    }
  }

  async test(config: Record<string, string>): Promise<boolean> {
    try {
      const response = await fetch(`${config.base_url}/rest/api/3/myself`, {
        headers: {
          'Authorization': `Basic ${btoa(`${config.user_email}:${config.api_token}`)}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  setChannelId(id: string): void {
    this.channelId = id;
  }

  private async poll(): Promise<void> {
    if (!this.onMessage) return;

    const botName = this.config.bot_mention_name;
    if (!botName) return; // can't detect mentions without a bot name

    try {
      const jql = `comment ~ "@${botName}" AND updated >= "${this.lastPollTime.replace('T', ' ').slice(0, 19)}"`;
      const url = `${this.config.base_url}/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=comment,summary,status,issuetype,priority`;
      const auth = `Basic ${btoa(`${this.config.user_email}:${this.config.api_token}`)}`;

      const response = await fetch(url, { headers: { Authorization: auth } });
      if (!response.ok) return;

      const data = await response.json() as any;
      this.lastPollTime = new Date().toISOString();

      for (const issue of data.issues ?? []) {
        const comments = issue.fields?.comment?.comments ?? [];
        const recentComments = comments.filter((c: any) =>
          this.extractTextFromAdf(c.body).includes(`@${botName}`) &&
          new Date(c.created) > new Date(Date.now() - 60_000),
        );

        for (const comment of recentComments) {
          await this.handleWebhook('comment_created', { comment, issue });
        }
      }
    } catch (err) {
      console.error('[jira-adapter] Poll error:', err);
    }
  }

  /** Extract plain text from Atlassian Document Format (ADF). */
  private extractTextFromAdf(adf: any): string {
    if (!adf || typeof adf === 'string') return adf ?? '';
    if (adf.type === 'text') return adf.text ?? '';
    if (Array.isArray(adf.content)) {
      return adf.content.map((node: any) => this.extractTextFromAdf(node)).join('');
    }
    return '';
  }
}
