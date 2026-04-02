import type { DatabaseService } from '../core/database.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { KnowledgeIngestionService } from '../services/knowledge.js';
import type { CommunicationChannelRow } from '../types/index.js';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { SlackAdapter } from './adapters/slack.js';
import { GitHubAdapter } from './adapters/github.js';
import { JiraAdapter } from './adapters/jira.js';

/**
 * ChannelGateway — manages communication channel lifecycle and routes
 * inbound messages from any platform to the appropriate agent.
 *
 * This is the central hub that replaces both the singleton TelegramService
 * and the NotificationManager for unified multi-channel communication.
 */
export class ChannelGateway {
  private adapters = new Map<string, ChannelAdapter & { setChannelId(id: string): void }>();
  private knowledgeIngestion: KnowledgeIngestionService | null = null;

  // Debounce: batch rapid messages from the same thread before processing
  private pendingMessages = new Map<string, { msgs: InboundMessage[]; timer: ReturnType<typeof setTimeout>; channel: CommunicationChannelRow }>();
  private activeThreads = new Set<string>(); // threads currently being processed
  private static DEBOUNCE_MS = 1500; // wait 1.5s for more messages

  constructor(
    private db: DatabaseService,
    private orchestrator: Orchestrator,
  ) {}

  /** Set the knowledge ingestion service for URL auto-ingestion. */
  setKnowledgeIngestion(service: KnowledgeIngestionService): void {
    this.knowledgeIngestion = service;
  }

  /** Start all enabled bidirectional/inbound channels. */
  async startAll(): Promise<void> {
    const channels = this.db.getCommunicationChannels();
    const startable = channels.filter(
      (ch) => ch.enabled && ch.direction !== 'outbound',
    );

    for (const channel of startable) {
      try {
        await this.startChannel(channel.id);
      } catch (err) {
        console.error(`[gateway] Failed to start channel ${channel.id} (${channel.platform}):`, err);
        this.db.updateCommunicationChannel(channel.id, {
          status: 'error',
          error_message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Start a specific channel by ID. */
  async startChannel(id: string): Promise<void> {
    // Stop existing adapter if running
    if (this.adapters.has(id)) {
      await this.stopChannel(id);
    }

    const channel = this.db.getCommunicationChannel(id);
    if (!channel) throw new Error(`Channel not found: ${id}`);
    if (!channel.enabled) throw new Error(`Channel is disabled: ${id}`);

    let config: Record<string, string>;
    try {
      config = JSON.parse(channel.config);
    } catch {
      throw new Error(`Invalid config JSON for channel ${id}`);
    }

    const adapter = this.createAdapter(channel.platform);
    if (!adapter) throw new Error(`Unsupported platform: ${channel.platform}`);

    adapter.setChannelId(id);
    this.adapters.set(id, adapter);

    await adapter.start(config, (msg) => this.handleInbound(channel, msg));

    this.db.updateCommunicationChannel(id, {
      status: 'running',
      error_message: null,
    });

    console.log(`[gateway] Channel started: ${channel.name} (${channel.platform})`);
  }

  /** Stop a specific channel. */
  async stopChannel(id: string): Promise<void> {
    const adapter = this.adapters.get(id);
    if (adapter) {
      await adapter.stop();
      this.adapters.delete(id);
    }
    this.db.updateCommunicationChannel(id, { status: 'stopped' });
  }

  /** Stop all channels. */
  async stopAll(): Promise<void> {
    const stops = Array.from(this.adapters.entries()).map(async ([id, adapter]) => {
      try {
        await adapter.stop();
      } catch (err) {
        console.error(`[gateway] Error stopping channel ${id}:`, err);
      }
    });
    await Promise.all(stops);
    this.adapters.clear();
  }

  /** Send an outbound message through a specific channel. */
  async send(channelId: string, platformThreadId: string, message: OutboundMessage): Promise<string> {
    let adapter = this.adapters.get(channelId);

    // For outbound-only channels, create a temporary adapter
    if (!adapter) {
      const channel = this.db.getCommunicationChannel(channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);

      let config: Record<string, string>;
      try {
        config = JSON.parse(channel.config);
      } catch {
        throw new Error(`Invalid config JSON for channel ${channelId}`);
      }

      const tempAdapter = this.createAdapter(channel.platform);
      if (!tempAdapter) throw new Error(`Unsupported platform: ${channel.platform}`);

      // For outbound-only, we use sendMessage directly without start()
      // Some adapters (telegram) can send without starting polling
      tempAdapter.setChannelId(channelId);

      // Start temporarily for sending
      await tempAdapter.start(config, async () => {});
      const messageId = await tempAdapter.sendMessage(platformThreadId, message);
      await tempAdapter.stop();
      return messageId;
    }

    return adapter.sendMessage(platformThreadId, message);
  }

  /**
   * Send a notification through one or more channels.
   * Uses the channel's default destination (e.g., chat_id for Telegram).
   * This is the bridge for schedule/job notifications.
   */
  async notify(channelIds: string[], message: { title?: string; body: string; priority?: string }): Promise<void> {
    const promises = channelIds.map(async (id) => {
      try {
        const channel = this.db.getCommunicationChannel(id);
        if (!channel) return;

        let config: Record<string, string>;
        try {
          config = JSON.parse(channel.config);
        } catch { return; }

        // Determine default thread ID from config
        const defaultThreadId = this.getDefaultThreadId(channel.platform, config);
        if (!defaultThreadId) return;

        const text = message.title
          ? `**${message.title}**\n\n${message.body}`
          : message.body;

        const outbound: OutboundMessage = this.formatForPlatform(
          channel.platform,
          message.priority === 'high' ? `⚠️ ${text}` : text,
          { metadata: {} } as InboundMessage,
        );

        await this.send(id, defaultThreadId, outbound);
      } catch (err) {
        console.error(`[gateway] Failed to notify channel ${id}:`, err);
      }
    });
    await Promise.all(promises);
  }

  /**
   * Send a notification to a specific target in "platform:destination" format.
   * E.g., "telegram:123456789" or "slack:#general".
   * Finds a running adapter for the platform and sends directly.
   */
  async notifyTarget(target: string, message: { body: string }): Promise<void> {
    const colonIdx = target.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`Invalid target format "${target}" — expected "platform:destination"`);
    }
    const platform = target.slice(0, colonIdx);
    let destination = target.slice(colonIdx + 1);

    // Find a running adapter for this platform
    for (const [id, adapter] of this.adapters) {
      const channel = this.db.getCommunicationChannel(id);
      if (channel?.platform === platform) {
        // For Telegram, resolve non-numeric destinations to the channel's default chat_id
        if (platform === 'telegram' && !/^\d+$/.test(destination)) {
          const resolved = this.resolveDefaultDestination(channel, destination);
          if (resolved) destination = resolved;
        }
        const outbound: OutboundMessage = platform === 'telegram'
          ? { text: message.body, html: markdownToTelegramHtml(message.body) }
          : { text: message.body };
        await adapter.sendMessage(destination, outbound);
        return;
      }
    }

    // No running adapter — try to find a configured channel for this platform and start temporarily
    const channels = this.db.getCommunicationChannels();
    const match = channels.find((ch) => ch.platform === platform && ch.enabled);
    if (!match) {
      throw new Error(`No configured channel for platform "${platform}"`);
    }
    // Resolve non-numeric Telegram destinations
    if (platform === 'telegram' && !/^\d+$/.test(destination)) {
      const resolved = this.resolveDefaultDestination(match, destination);
      if (resolved) destination = resolved;
    }
    const outbound: OutboundMessage = platform === 'telegram'
      ? { text: message.body, html: markdownToTelegramHtml(message.body) }
      : { text: message.body };
    await this.send(match.id, destination, outbound);
  }

  /** Broadcast a notification to all enabled channels. */
  async broadcastNotification(message: { title?: string; body: string; priority?: string }): Promise<void> {
    const channels = this.db.getCommunicationChannels();
    const enabledIds = channels.filter((ch) => ch.enabled).map((ch) => ch.id);
    await this.notify(enabledIds, message);
  }

  /** Get the default thread/destination ID for a channel based on its config. */
  private getDefaultThreadId(platform: string, config: Record<string, string>): string | null {
    switch (platform) {
      case 'telegram':
        return config.chat_id || null;
      case 'slack':
        return config.default_channel ? `${config.default_channel}:0` : null;
      case 'github':
        return null; // GitHub doesn't have a default thread
      case 'jira':
        return null; // Jira doesn't have a default thread
      default:
        return null;
    }
  }

  /**
   * Resolve a non-standard destination to the channel's default.
   * For Telegram: non-numeric usernames/handles → configured chat_id.
   */
  private resolveDefaultDestination(channel: CommunicationChannelRow, _destination: string): string | null {
    try {
      const config = JSON.parse(channel.config);
      return this.getDefaultThreadId(channel.platform, config);
    } catch {
      return null;
    }
  }

  /** Test connectivity for a channel. */
  async testChannel(id: string): Promise<boolean> {
    const channel = this.db.getCommunicationChannel(id);
    if (!channel) return false;

    let config: Record<string, string>;
    try {
      config = JSON.parse(channel.config);
    } catch {
      return false;
    }

    const adapter = this.createAdapter(channel.platform);
    if (!adapter) return false;

    return adapter.test(config);
  }

  /** Reload — stop all and restart from DB. */
  async reload(): Promise<void> {
    await this.stopAll();
    await this.startAll();
  }

  /** Get the adapter for a channel (if running). */
  getAdapter(channelId: string): (ChannelAdapter & { setChannelId(id: string): void }) | undefined {
    return this.adapters.get(channelId);
  }

  /** Number of running adapters. */
  get size(): number {
    return this.adapters.size;
  }

  /**
   * Handle an inbound message from any platform adapter.
   *
   * Flow:
   * 1. Resolve or create a channel_thread mapping
   * 2. Resolve the target agent
   * 3. Load conversation history from chat_messages
   * 4. Execute via orchestrator
   * 5. Send response back through the adapter
   * 6. Store messages in chat_messages
   */
  private async handleInbound(channel: CommunicationChannelRow, msg: InboundMessage): Promise<void> {
    const key = `${channel.id}:${msg.threadId}`;
    const pending = this.pendingMessages.get(key);

    if (pending) {
      // Another message arrived while debouncing or processing — append and reset timer
      pending.msgs.push(msg);
      clearTimeout(pending.timer);
      // If thread is actively processing, don't start timer yet — processBatch will drain after it finishes
      if (!this.activeThreads.has(key)) {
        pending.timer = setTimeout(() => this.processBatch(key), ChannelGateway.DEBOUNCE_MS);
      }
      return;
    }

    // First message — start debounce window
    const timer = setTimeout(() => this.processBatch(key), ChannelGateway.DEBOUNCE_MS);
    this.pendingMessages.set(key, { msgs: [msg], timer, channel });
  }

  /** Process a debounced batch of messages from the same thread. */
  private async processBatch(key: string): Promise<void> {
    const pending = this.pendingMessages.get(key);
    if (!pending) return;

    // If thread is already processing, wait — the current run will drain us when it finishes
    if (this.activeThreads.has(key)) return;

    this.pendingMessages.delete(key);
    this.activeThreads.add(key);

    const { msgs, channel } = pending;
    // Use the last message for metadata (replyTo, etc.) but combine all texts
    const lastMsg = msgs[msgs.length - 1];
    const combinedText = msgs.map(m => m.text).join('\n');
    const mergedMsg: InboundMessage = { ...lastMsg, text: combinedText };

    if (msgs.length > 1) {
      console.log(`[gateway] Debounced ${msgs.length} messages in ${channel.platform} thread ${lastMsg.threadId}`);
    }

    try {
      await this.processInbound(channel, mergedMsg);
    } finally {
      this.activeThreads.delete(key);

      // Check if more messages queued while we were processing
      if (this.pendingMessages.has(key)) {
        const next = this.pendingMessages.get(key)!;
        clearTimeout(next.timer);
        next.timer = setTimeout(() => this.processBatch(key), ChannelGateway.DEBOUNCE_MS);
      }
    }
  }

  /** Core inbound processing — handles a single (possibly merged) message. */
  private async processInbound(channel: CommunicationChannelRow, msg: InboundMessage): Promise<void> {
    const adapter = this.adapters.get(channel.id);
    if (!adapter) return;

    // Show typing indicator for Telegram
    let stopTyping: (() => void) | undefined;
    if (channel.platform === 'telegram' && 'startTyping' in adapter) {
      stopTyping = (adapter as TelegramAdapter).startTyping(msg.threadId);
    }

    try {
      // 1. Resolve agent
      const agentId = channel.agent_id ?? await this.resolveAgentFromMessage(msg);

      // 2. Resolve or create thread mapping
      let thread = this.db.getChannelThread(channel.id, msg.threadId);
      if (!thread) {
        thread = this.db.createChannelThread({
          channel_id: channel.id,
          platform_thread_id: msg.threadId,
          agent_id: agentId,
          chat_thread_id: null,
        });
      } else {
        this.db.updateChannelThreadActivity(channel.id, msg.threadId);
      }

      // Conversation history is handled by AgentService.process() — do NOT inject it here
      // to avoid recursive nesting (gateway prepends → gets logged → loaded again next time)

      // 5. Build platform context metadata
      const platformContext = this.buildPlatformContext(msg);

      // 5b. URL ingestion — if the message is just a URL, try to ingest it
      if (this.knowledgeIngestion && /^https?:\/\/\S+$/.test(msg.text.trim())) {
        try {
          const msgId = typeof msg.metadata.messageId === 'number' ? msg.metadata.messageId : 0;
          const result = await this.knowledgeIngestion.ingest(
            msg.text.trim(),
            msgId,
          );
          const reply = `📥 ${result.summary}\n\n📁 ${result.savedTo || 'Not saved'}`;
          await adapter.sendMessage(msg.threadId, this.formatForPlatform(channel.platform, reply, msg));
          if (thread.chat_thread_id) {
            this.db.addChatMessage(thread.chat_thread_id, 'assistant', reply);
          }
          return; // URL handled, skip agent execution
        } catch (err) {
          console.error('[gateway] URL ingestion failed, falling through to agent:', err);
        }
      }

      // 6. Build the prompt for the agent
      let promptText = msg.text;

      // Enrich prompt with command context
      if (msg.metadata.command) {
        const cmd = msg.metadata.command as string;
        const args = msg.metadata.commandArgs as string || '';
        promptText = `The user sent a /${cmd} command${args ? ` with arguments: "${args}"` : ''}. `
          + `Handle this command using your available tools. `;
        if (cmd === 'todo' && !args) promptText += 'List today\'s tasks from the daily note.';
        else if (cmd === 'todo' && args === 'all') promptText += 'List all pending tasks across the vault.';
        else if (cmd === 'todo') promptText += `Add this task to today's daily note: "${args}"`;
        else if (cmd === 'search') promptText += `Search the vault for: "${args}"`;
        else if (cmd === 'remember') promptText += `Save this to the vault as a note: "${args}"`;
        else if (cmd === 'status') promptText += 'Show the current system status.';
        else promptText += args ? `User said: "${args}"` : `Execute the /${cmd} action.`;
      }

      // Build the input — conversation history is injected by AgentService.process()
      const input = {
        text: promptText,
        source: channel.platform,
        metadata: {
          agentId,
          channelId: channel.id,
          threadId: msg.threadId,
          sender: msg.sender,
          platformContext,
          ...msg.metadata,
        },
      };

      const response = await this.orchestrator.chat(input);

      // 7. Send response back through the adapter
      const responseText = response.text.trim() || 'I could not generate a response. Please try again.';

      // Format for the platform
      const outbound: OutboundMessage = this.formatForPlatform(
        channel.platform,
        responseText,
        msg,
      );

      await adapter.sendMessage(msg.threadId, outbound);

      // 8. Store assistant response
      if (thread.chat_thread_id) {
        this.db.addChatMessage(thread.chat_thread_id, 'assistant', responseText);
      }
    } catch (err) {
      console.error(`[gateway] Error handling inbound message on ${channel.platform}:`, err instanceof Error ? err.stack : err);

      // Send error message back to user
      try {
        await adapter.sendMessage(msg.threadId, {
          text: 'Something went wrong processing your message. Please try again.',
          replyToMessageId: msg.metadata?.messageId?.toString(),
        });
      } catch { /* ignore send failure */ }
    } finally {
      stopTyping?.();
    }
  }

  /** Resolve agent from message content (e.g., @mention routing). */
  private async resolveAgentFromMessage(msg: InboundMessage): Promise<string> {
    // Check for @mention in message text
    const mentionMatch = msg.text.match(/@(\w+)/);
    if (mentionMatch) {
      const agents = this.db.getAgents();
      const found = agents.find(
        (a) =>
          a.name.toLowerCase().includes(mentionMatch[1].toLowerCase()) ||
          a.id === mentionMatch[1],
      );
      if (found) return found.id;
    }

    // Default to first enabled agent
    const agents = this.db.getAgents();
    const enabled = agents.filter((a) => a.enabled);
    return enabled[0]?.id ?? 'default';
  }

  /** Build platform-specific context string for the agent. */
  private buildPlatformContext(msg: InboundMessage): string {
    const parts: string[] = [
      `Platform: ${msg.platform}`,
      `From: ${msg.sender.displayName}`,
    ];

    if (msg.platform === 'github') {
      if (msg.metadata.issueTitle) parts.push(`Issue: ${msg.metadata.issueTitle}`);
      if (msg.metadata.isPullRequest) parts.push('Type: Pull Request');
      if (msg.metadata.diffHunk) parts.push(`Code context:\n${msg.metadata.diffHunk}`);
    }

    if (msg.platform === 'jira') {
      if (msg.metadata.issueSummary) parts.push(`Issue: ${msg.metadata.issueSummary}`);
      if (msg.metadata.issueStatus) parts.push(`Status: ${msg.metadata.issueStatus}`);
      if (msg.metadata.issueType) parts.push(`Type: ${msg.metadata.issueType}`);
    }

    if (msg.platform === 'slack') {
      if (msg.metadata.channelType === 'im') parts.push('Channel: Direct Message');
    }

    return parts.join('\n');
  }

  /** Format response text for the target platform. */
  private formatForPlatform(
    platform: string,
    text: string,
    originalMsg: InboundMessage,
  ): OutboundMessage {
    switch (platform) {
      case 'telegram':
        return {
          text,
          html: markdownToTelegramHtml(text),
          replyToMessageId: originalMsg.metadata?.messageId?.toString(),
        };
      case 'slack':
        // Slack uses mrkdwn natively, markdown passes through mostly fine
        return { text };
      case 'github':
        // GitHub supports full markdown
        return { text };
      case 'jira':
        // Jira uses ADF but sendMessage handles conversion
        return { text };
      default:
        return { text };
    }
  }

  /** Create a platform adapter instance. */
  private createAdapter(platform: string): (ChannelAdapter & { setChannelId(id: string): void }) | null {
    switch (platform) {
      case 'telegram':
        return new TelegramAdapter();
      case 'slack':
        return new SlackAdapter();
      case 'github':
        return new GitHubAdapter();
      case 'jira':
        return new JiraAdapter();
      default:
        return null;
    }
  }
}

/** Convert markdown to Telegram-safe HTML. */
function markdownToTelegramHtml(text: string): string {
  return text
    .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>')
    .replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}
