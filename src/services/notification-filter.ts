import type { DatabaseService } from './database.js';

type FilterDecision = 'send' | 'suppress' | 'delay';

export class NotificationFilterService {
  private minWeeksData = 4;

  constructor(private db: DatabaseService) {
    this.ensureTable();
  }

  private getDb() {
    return (this.db as unknown as { db: import('better-sqlite3').Database }).db;
  }

  private ensureTable(): void {
    const db = this.getDb();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS notification_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        response_time INTEGER,
        action TEXT NOT NULL DEFAULT 'ignored'
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS notification_overrides (
        type TEXT PRIMARY KEY,
        rule TEXT NOT NULL
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS notification_suppressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        suppressed_at TEXT NOT NULL,
        reason TEXT
      )
    `).run();
  }

  recordNotification(type: string): number {
    const result = this.getDb().prepare(`
      INSERT INTO notification_records (type, sent_at, action) VALUES (?, ?, 'ignored')
    `).run(type, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  recordResponse(notificationId: number, action: 'replied' | 'acknowledged' | 'dismissed'): void {
    const record = this.getDb().prepare(`
      SELECT sent_at FROM notification_records WHERE id = ?
    `).get(notificationId) as { sent_at: string } | undefined;

    if (!record) return;

    const responseTime = Math.floor((Date.now() - new Date(record.sent_at).getTime()) / 1000);
    this.getDb().prepare(`
      UPDATE notification_records SET response_time = ?, action = ? WHERE id = ?
    `).run(responseTime, action, notificationId);
  }

  shouldSend(type: string): FilterDecision {
    if (type.includes('incident')) return 'send';

    const override = this.getDb().prepare(`
      SELECT rule FROM notification_overrides WHERE type = ?
    `).get(type) as { rule: string } | undefined;

    if (override) return override.rule as FilterDecision;
    if (!this.hasEnoughData()) return 'send';

    const stats = this.getEngagementStats(type);
    if (!stats) return 'send';

    if (stats.ignoreRate > 0.8) return 'suppress';
    if (stats.avgResponseTime > 3600 && stats.ignoreRate > 0.5) return 'delay';

    return 'send';
  }

  setOverride(type: string, rule: 'send' | 'suppress'): void {
    this.getDb().prepare(`
      INSERT OR REPLACE INTO notification_overrides (type, rule) VALUES (?, ?)
    `).run(type, rule);
  }

  removeOverride(type: string): void {
    this.getDb().prepare('DELETE FROM notification_overrides WHERE type = ?').run(type);
  }

  getSettings(): { type: string; engagement: string; rule: string }[] {
    const types = this.getDb().prepare(
      'SELECT DISTINCT type FROM notification_records',
    ).all() as { type: string }[];

    return types.map((t) => {
      const stats = this.getEngagementStats(t.type);
      const override = this.getDb().prepare(
        'SELECT rule FROM notification_overrides WHERE type = ?',
      ).get(t.type) as { rule: string } | undefined;

      return {
        type: t.type,
        engagement: stats ? `${Math.round((1 - stats.ignoreRate) * 100)}%` : 'N/A',
        rule: override?.rule || 'auto',
      };
    });
  }

  getWeeklySuppressedCount(): number {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const row = this.getDb().prepare(
      'SELECT COUNT(*) as count FROM notification_suppressions WHERE suppressed_at > ?',
    ).get(weekAgo) as { count: number };
    return row.count;
  }

  logSuppression(type: string, reason: string): void {
    this.getDb().prepare(
      'INSERT INTO notification_suppressions (type, suppressed_at, reason) VALUES (?, ?, ?)',
    ).run(type, new Date().toISOString(), reason);
  }

  private hasEnoughData(): boolean {
    const oldest = this.getDb().prepare(
      'SELECT MIN(sent_at) as first FROM notification_records',
    ).get() as { first: string | null };

    if (!oldest?.first) return false;
    const weeks = (Date.now() - new Date(oldest.first).getTime()) / (7 * 24 * 60 * 60 * 1000);
    return weeks >= this.minWeeksData;
  }

  private getEngagementStats(type: string): { ignoreRate: number; avgResponseTime: number } | null {
    const records = this.getDb().prepare(`
      SELECT action, response_time FROM notification_records
      WHERE type = ? ORDER BY id DESC LIMIT 20
    `).all(type) as { action: string; response_time: number | null }[];

    if (records.length < 5) return null;

    const ignored = records.filter((r) => r.action === 'ignored').length;
    const responded = records.filter((r) => r.response_time !== null);
    const avgTime = responded.length > 0
      ? responded.reduce((sum, r) => sum + (r.response_time || 0), 0) / responded.length
      : Infinity;

    return { ignoreRate: ignored / records.length, avgResponseTime: avgTime };
  }
}
