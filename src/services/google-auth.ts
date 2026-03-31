import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { DatabaseService } from './database.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  scopes: string;
}

export class GoogleAuthService {
  private oauth2Client: OAuth2Client;

  constructor(
    clientId: string,
    clientSecret: string,
    redirectUri: string,
    private db: DatabaseService,
  ) {
    this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    this.ensureTable();
    this.loadTokens();
    this.setupAutoRefresh();
  }

  private getDb(): import('better-sqlite3').Database {
    return (this.db as unknown as { db: import('better-sqlite3').Database }).db;
  }

  private ensureTable(): void {
    const db = this.getDb();
    const sql = `
      CREATE TABLE IF NOT EXISTS google_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expiry_date INTEGER NOT NULL,
        scopes TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    db.prepare(sql).run();
  }

  private loadTokens(): void {
    try {
      const db = this.getDb();
      const row = db.prepare(
        'SELECT access_token, refresh_token, expiry_date, scopes FROM google_tokens ORDER BY id DESC LIMIT 1',
      ).get() as StoredTokens | undefined;

      if (row) {
        this.oauth2Client.setCredentials({
          access_token: row.access_token,
          refresh_token: row.refresh_token,
          expiry_date: row.expiry_date,
        });
        console.log('[GoogleAuth] Loaded tokens from database');
      }
    } catch (error) {
      console.error('[GoogleAuth] Failed to load tokens:', error);
    }
  }

  private setupAutoRefresh(): void {
    this.oauth2Client.on('tokens', (tokens) => {
      try {
        const db = this.getDb();
        const current = db.prepare(
          'SELECT refresh_token FROM google_tokens ORDER BY id DESC LIMIT 1',
        ).get() as { refresh_token: string } | undefined;

        const refreshToken = tokens.refresh_token ?? current?.refresh_token ?? '';

        db.prepare(`
          INSERT INTO google_tokens (access_token, refresh_token, expiry_date, scopes, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          tokens.access_token ?? '',
          refreshToken,
          tokens.expiry_date ?? 0,
          SCOPES.join(' '),
          new Date().toISOString(),
        );

        console.log('[GoogleAuth] Tokens refreshed and saved');
      } catch (error) {
        console.error('[GoogleAuth] Failed to save refreshed tokens:', error);
      }
    });
  }

  getAuthUrl(): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });
  }

  async handleCallback(code: string): Promise<void> {
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      this.oauth2Client.setCredentials(tokens);

      const db = this.getDb();
      db.prepare(`
        INSERT INTO google_tokens (access_token, refresh_token, expiry_date, scopes, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        tokens.access_token ?? '',
        tokens.refresh_token ?? '',
        tokens.expiry_date ?? 0,
        SCOPES.join(' '),
        new Date().toISOString(),
      );

      console.log('[GoogleAuth] OAuth callback handled, tokens stored');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[GoogleAuth] OAuth callback failed:', message);
      throw new Error(`Google OAuth callback failed: ${message}`);
    }
  }

  getClient(): OAuth2Client {
    if (!this.isAuthenticated()) {
      throw new Error(
        'Google OAuth not authenticated. Run the auth flow first — use getAuthUrl() to get the consent URL.',
      );
    }
    return this.oauth2Client;
  }

  isAuthenticated(): boolean {
    const credentials = this.oauth2Client.credentials;
    return !!(credentials.access_token || credentials.refresh_token);
  }
}
