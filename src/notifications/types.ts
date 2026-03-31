export interface NotificationChannel {
  id: string;
  type: 'telegram' | 'slack' | 'web' | 'email' | 'webhook';
  name: string;
  config: Record<string, string>;

  send(message: NotificationMessage): Promise<void>;
  test(): Promise<boolean>;
}

export interface NotificationMessage {
  title?: string;
  body: string;
  html?: string;
  priority: 'low' | 'normal' | 'high';
  source: string;
}
