import nodemailer from 'nodemailer';
import type { NotificationChannel, NotificationMessage } from '../types.js';

export class EmailChannel implements NotificationChannel {
  readonly type = 'email' as const;
  private transporter: nodemailer.Transporter;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly config: Record<string, string>,
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: parseInt(config.smtp_port || '587', 10),
      secure: config.smtp_port === '465',
      auth: {
        user: config.smtp_user,
        pass: config.smtp_pass,
      },
    });
  }

  async send(message: NotificationMessage): Promise<void> {
    const subject = message.title ?? `[Tela] Notification (${message.priority})`;
    const html = message.html ?? `<p>${message.body.replace(/\n/g, '<br>')}</p>`;

    await this.transporter.sendMail({
      from: this.config.from,
      to: this.config.to,
      subject,
      text: message.body,
      html,
    });
  }

  async test(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}
