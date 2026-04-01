/** Platform types supported by the communication channels system. */
export type ChannelPlatform = 'telegram' | 'slack' | 'github' | 'jira' | 'email' | 'webhook' | 'web';

/** Direction of communication for a channel. */
export type ChannelDirection = 'inbound' | 'outbound' | 'bidirectional';

/** Runtime status of a channel adapter. */
export type ChannelStatus = 'stopped' | 'running' | 'error';

/** Normalized inbound message from any platform. */
export interface InboundMessage {
  channelId: string;
  platform: ChannelPlatform;
  threadId: string;
  parentMessageId?: string;
  sender: {
    platformId: string;
    displayName: string;
  };
  text: string;
  attachments?: Attachment[];
  metadata: Record<string, unknown>;
}

/** Outbound message sent back through a channel. */
export interface OutboundMessage {
  text: string;
  html?: string;
  attachments?: Attachment[];
  replyToMessageId?: string;
}

export interface Attachment {
  type: string;
  url?: string;
  data?: Buffer;
  name?: string;
}

/**
 * Adapter interface — one implementation per platform.
 *
 * Each adapter wraps a platform SDK (grammy, @slack/bolt, octokit, etc.)
 * and normalizes messages to/from the unified InboundMessage/OutboundMessage types.
 */
export interface ChannelAdapter {
  readonly platform: ChannelPlatform;

  /** Start listening for inbound messages. */
  start(
    config: Record<string, string>,
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): Promise<void>;

  /** Stop the adapter and clean up resources. */
  stop(): Promise<void>;

  /** Send a message to a platform thread. Returns the platform message ID. */
  sendMessage(platformThreadId: string, message: OutboundMessage): Promise<string>;

  /** Edit a previously sent message. */
  editMessage(platformThreadId: string, messageId: string, message: OutboundMessage): Promise<void>;

  /** Send a file/document. Returns the platform message ID. */
  sendFile?(platformThreadId: string, file: { data: Buffer; name: string; caption?: string }): Promise<string>;

  /** Fetch message history for a thread from the platform (if supported). */
  fetchThreadHistory(platformThreadId: string, limit?: number): Promise<InboundMessage[]>;

  /** Test connectivity with the platform. */
  test(config: Record<string, string>): Promise<boolean>;
}
