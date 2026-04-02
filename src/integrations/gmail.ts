import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { GoogleAuthService } from './google-auth.js';

export interface Email {
  id: string;
  threadId: string;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  subject: string;
  date: string;
  body: string;
  labels: string[];
  classification: 'urgent' | 'normal' | 'ignorable';
  hasAttachments: boolean;
}

export interface EmailDraft {
  id: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  replyToId?: string;
}

const URGENT_KEYWORDS = /\b(incident|down|outage|blocker|urgent)\b/i;
const IGNORABLE_SENDERS = /^(noreply|no-reply|notifications|mailer-daemon|postmaster|bounce|digest|newsletter)@/i;

function parseAddress(raw: string): { name: string; email: string } {
  // Handles "Name <email@example.com>" or plain "email@example.com"
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].replace(/^["']|["']$/g, '').trim(), email: match[2].trim() };
  }
  const emailOnly = raw.trim();
  return { name: '', email: emailOnly };
}

function parseAddressList(header: string | undefined): { name: string; email: string }[] {
  if (!header) return [];
  return header.split(',').map((s) => parseAddress(s.trim())).filter((a) => a.email);
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string | undefined {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBody(payload: gmail_v1.Schema$MessagePart): string {
  // Direct body (simple messages)
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart: walk parts looking for text/plain first, then text/html
  if (payload.parts) {
    // Prefer text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Fallback to text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return stripHtml(decodeBase64Url(part.body.data));
      }
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  // Fallback: html body at top level
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }

  return '';
}

function hasAttachments(payload: gmail_v1.Schema$MessagePart): boolean {
  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    return true;
  }
  return (payload.parts ?? []).some((p) => hasAttachments(p));
}

function classifyEmail(
  headers: gmail_v1.Schema$MessagePartHeader[],
  from: { name: string; email: string },
  subject: string,
): 'urgent' | 'normal' | 'ignorable' {
  // Urgent: keyword match in subject or from
  if (URGENT_KEYWORDS.test(subject) || URGENT_KEYWORDS.test(from.name)) {
    return 'urgent';
  }

  // Ignorable: list-unsubscribe header or noreply-like sender
  const listUnsub = getHeader(headers, 'List-Unsubscribe');
  if (listUnsub) return 'ignorable';
  if (IGNORABLE_SENDERS.test(from.email)) return 'ignorable';

  return 'normal';
}

function parseMessage(msg: gmail_v1.Schema$Message): Email {
  const headers = msg.payload?.headers ?? [];
  const fromRaw = getHeader(headers, 'From') ?? '';
  const from = parseAddress(fromRaw);
  const subject = getHeader(headers, 'Subject') ?? '(No subject)';
  const date = getHeader(headers, 'Date') ?? '';
  const toRaw = getHeader(headers, 'To');
  const ccRaw = getHeader(headers, 'Cc');

  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    from,
    to: parseAddressList(toRaw),
    cc: parseAddressList(ccRaw),
    subject,
    date,
    body: msg.payload ? extractBody(msg.payload) : '',
    labels: msg.labelIds ?? [],
    classification: classifyEmail(headers, from, subject),
    hasAttachments: msg.payload ? hasAttachments(msg.payload) : false,
  };
}

function buildRawMessage(to: string, subject: string, body: string, cc?: string, replyToId?: string): string {
  const lines: string[] = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (cc) lines.splice(1, 0, `Cc: ${cc}`);
  if (replyToId) lines.push(`In-Reply-To: ${replyToId}`, `References: ${replyToId}`);
  lines.push('', body);

  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

export class GmailService {
  constructor(private auth: GoogleAuthService) {}

  private getGmail(): gmail_v1.Gmail {
    return google.gmail({ version: 'v1', auth: this.auth.getClient() });
  }

  private async fetchFullMessage(gmail: gmail_v1.Gmail, id: string): Promise<gmail_v1.Schema$Message> {
    const res = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    return res.data;
  }

  async getUnread(label?: string, limit = 20): Promise<Email[]> {
    try {
      const gmail = this.getGmail();
      const labelIds = ['UNREAD'];
      if (label) labelIds.push(label);

      const res = await gmail.users.messages.list({
        userId: 'me',
        labelIds,
        maxResults: limit,
      });

      const messages = res.data.messages ?? [];
      const emails: Email[] = [];

      for (const msg of messages) {
        if (!msg.id) continue;
        const full = await this.fetchFullMessage(gmail, msg.id);
        emails.push(parseMessage(full));
      }

      return emails;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Gmail] Failed to get unread emails:', message);
      throw new Error(`Failed to get unread emails: ${message}`);
    }
  }

  async searchEmail(query: string, limit = 20): Promise<Email[]> {
    try {
      const gmail = this.getGmail();
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: limit,
      });

      const messages = res.data.messages ?? [];
      const emails: Email[] = [];

      for (const msg of messages) {
        if (!msg.id) continue;
        const full = await this.fetchFullMessage(gmail, msg.id);
        emails.push(parseMessage(full));
      }

      return emails;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Gmail] Failed to search emails:', message);
      throw new Error(`Failed to search emails: ${message}`);
    }
  }

  async readEmail(id: string): Promise<Email> {
    try {
      const gmail = this.getGmail();
      const full = await this.fetchFullMessage(gmail, id);
      return parseMessage(full);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Gmail] Failed to read email:', message);
      throw new Error(`Failed to read email ${id}: ${message}`);
    }
  }

  async getThreads(from: string, days: number): Promise<Email[]> {
    try {
      const after = new Date();
      after.setDate(after.getDate() - days);
      const afterEpoch = Math.floor(after.getTime() / 1000);
      const query = `from:${from} after:${afterEpoch}`;
      return this.searchEmail(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Gmail] Failed to get threads:', message);
      throw new Error(`Failed to get threads from ${from}: ${message}`);
    }
  }

  async draftEmail(
    to: string,
    subject: string,
    body: string,
    cc?: string,
    replyToId?: string,
  ): Promise<EmailDraft> {
    try {
      const gmail = this.getGmail();
      const raw = buildRawMessage(to, subject, body, cc, replyToId);

      const res = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: { raw },
        },
      });

      const draftId = res.data.id ?? '';
      console.log(`[Gmail] Draft created: ${draftId}`);

      return {
        id: draftId,
        to,
        subject,
        body,
        cc,
        replyToId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Gmail] Failed to create draft:', message);
      throw new Error(`Failed to create email draft: ${message}`);
    }
  }

  async sendDraft(draftId: string): Promise<void> {
    try {
      const gmail = this.getGmail();
      await gmail.users.drafts.send({
        userId: 'me',
        requestBody: {
          id: draftId,
        },
      });
      console.log(`[Gmail] Draft sent: ${draftId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Gmail] Failed to send draft:', message);
      throw new Error(`Failed to send draft ${draftId}: ${message}`);
    }
  }
}
