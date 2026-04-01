import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../types.js';

/**
 * GitHub adapter — listens for @mentions in issues/PRs and responds in-thread.
 *
 * Config keys:
 *   app_id          — GitHub App ID
 *   private_key     — GitHub App private key (PEM)
 *   webhook_secret  — Webhook signing secret
 *   bot_username    — The bot's GitHub username (for @mention detection)
 *   installation_id — GitHub App installation ID
 *
 * Thread ID encoding: "${owner}/${repo}#${issueNumber}"
 *
 * Note: Requires @octokit/rest and @octokit/auth-app as dependencies.
 * This adapter registers webhook handlers on the Hono app via the gateway.
 */
export class GitHubAdapter implements ChannelAdapter {
  readonly platform = 'github' as const;

  private channelId = '';
  private config: Record<string, string> = {};
  private onMessage: ((msg: InboundMessage) => Promise<void>) | null = null;

  async start(
    config: Record<string, string>,
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): Promise<void> {
    this.config = config;
    this.onMessage = onMessage;
    console.log(`[github-adapter] Ready for webhooks (channel: ${this.channelId})`);
  }

  /**
   * Process a GitHub webhook payload. Called by the channel gateway's
   * webhook endpoint when a GitHub event is received.
   */
  async handleWebhook(event: string, payload: any): Promise<void> {
    if (!this.onMessage) return;

    const botUsername = this.config.bot_username;

    if (event === 'issue_comment' && payload.action === 'created') {
      const body = payload.comment?.body ?? '';
      if (botUsername && !body.includes(`@${botUsername}`)) return;

      const repo = payload.repository?.full_name ?? '';
      const issueNumber = payload.issue?.number;
      const threadId = `${repo}#${issueNumber}`;

      const msg: InboundMessage = {
        channelId: this.channelId,
        platform: 'github',
        threadId,
        sender: {
          platformId: payload.comment.user.login,
          displayName: payload.comment.user.login,
        },
        text: body.replace(new RegExp(`@${botUsername}\\s*`, 'g'), '').trim(),
        metadata: {
          event,
          commentId: payload.comment.id,
          issueTitle: payload.issue?.title,
          issueBody: payload.issue?.body,
          isPullRequest: !!payload.issue?.pull_request,
          repo,
          issueNumber,
          installationId: payload.installation?.id,
        },
      };

      await this.onMessage(msg);
    }

    if (event === 'pull_request_review_comment' && payload.action === 'created') {
      const body = payload.comment?.body ?? '';
      if (botUsername && !body.includes(`@${botUsername}`)) return;

      const repo = payload.repository?.full_name ?? '';
      const prNumber = payload.pull_request?.number;
      const threadId = `${repo}#${prNumber}`;

      const msg: InboundMessage = {
        channelId: this.channelId,
        platform: 'github',
        threadId,
        sender: {
          platformId: payload.comment.user.login,
          displayName: payload.comment.user.login,
        },
        text: body.replace(new RegExp(`@${botUsername}\\s*`, 'g'), '').trim(),
        metadata: {
          event,
          commentId: payload.comment.id,
          prTitle: payload.pull_request?.title,
          filePath: payload.comment.path,
          diffHunk: payload.comment.diff_hunk,
          repo,
          prNumber,
          installationId: payload.installation?.id,
        },
      };

      await this.onMessage(msg);
    }
  }

  async stop(): Promise<void> {
    this.onMessage = null;
  }

  async sendMessage(platformThreadId: string, message: OutboundMessage): Promise<string> {
    const { owner, repo, issueNumber } = this.decodeThreadId(platformThreadId);

    let Octokit: any;
    try {
      const mod = await import('@octokit/rest');
      Octokit = mod.Octokit;
    } catch {
      throw new Error('GitHub adapter requires @octokit/rest. Install with: npm install @octokit/rest');
    }

    const octokit = new Octokit({ auth: await this.getInstallationToken() });
    const result = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: message.text,
    });

    return result.data.id.toString();
  }

  async editMessage(platformThreadId: string, messageId: string, message: OutboundMessage): Promise<void> {
    const { owner, repo } = this.decodeThreadId(platformThreadId);

    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: await this.getInstallationToken() });
    await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: parseInt(messageId, 10),
      body: message.text,
    });
  }

  async fetchThreadHistory(platformThreadId: string, limit = 50): Promise<InboundMessage[]> {
    const { owner, repo, issueNumber } = this.decodeThreadId(platformThreadId);

    try {
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: await this.getInstallationToken() });

      const [issue, comments] = await Promise.all([
        octokit.issues.get({ owner, repo, issue_number: issueNumber }),
        octokit.issues.listComments({ owner, repo, issue_number: issueNumber, per_page: limit }),
      ]);

      const messages: InboundMessage[] = [
        {
          channelId: this.channelId,
          platform: 'github',
          threadId: platformThreadId,
          sender: {
            platformId: issue.data.user?.login ?? 'unknown',
            displayName: issue.data.user?.login ?? 'unknown',
          },
          text: `${issue.data.title}\n\n${issue.data.body ?? ''}`,
          metadata: { type: 'issue_body' },
        },
        ...comments.data.map((c) => ({
          channelId: this.channelId,
          platform: 'github' as const,
          threadId: platformThreadId,
          sender: {
            platformId: c.user?.login ?? 'unknown',
            displayName: c.user?.login ?? 'unknown',
          },
          text: c.body ?? '',
          metadata: { commentId: c.id },
        })),
      ];

      return messages;
    } catch {
      return [];
    }
  }

  async test(config: Record<string, string>): Promise<boolean> {
    try {
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: config.personal_access_token ?? config.private_key });
      const result = await octokit.users.getAuthenticated();
      return !!result.data.login;
    } catch {
      return false;
    }
  }

  setChannelId(id: string): void {
    this.channelId = id;
  }

  private decodeThreadId(threadId: string): { owner: string; repo: string; issueNumber: number } {
    // Format: "owner/repo#123"
    const [fullRepo, num] = threadId.split('#');
    const [owner, repo] = fullRepo.split('/');
    return { owner, repo, issueNumber: parseInt(num, 10) };
  }

  private async getInstallationToken(): Promise<string> {
    // For now, use a static token from config.
    // Full GitHub App auth with createAppAuth can be added later.
    return this.config.personal_access_token ?? this.config.private_key ?? '';
  }
}
