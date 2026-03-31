import type { DatabaseService } from './database.js';
import type { CtoAgent } from '../agent.js';

interface InteractionLog {
  topic: string;
  queryType: 'question' | 'command' | 'decision' | 'checkin';
  toolUsed: string | null;
  dayOfWeek: number;
  hourOfDay: number;
  timestamp: string;
}

interface PatternInsight {
  type: 'temporal' | 'frequency' | 'behavioral' | 'gap';
  description: string;
  confidence: number;
  relevantOn?: string;
}

export class PatternLearningService {
  private minWeeksData = 4;

  constructor(private db: DatabaseService) {
    this.ensureTable();
  }

  private getDb() {
    // Access the underlying better-sqlite3 Database instance
    return (this.db as unknown as { db: import('better-sqlite3').Database }).db;
  }

  private ensureTable(): void {
    const db = this.getDb();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS interaction_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        query_type TEXT NOT NULL,
        tool_used TEXT,
        day_of_week INTEGER NOT NULL,
        hour_of_day INTEGER NOT NULL,
        timestamp TEXT NOT NULL
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS pattern_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        confidence REAL NOT NULL,
        relevant_on TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS pattern_dismissals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_description TEXT NOT NULL,
        dismissed_at TEXT NOT NULL
      )
    `).run();
  }

  logInteraction(data: {
    topic: string;
    queryType: 'question' | 'command' | 'decision' | 'checkin';
    toolUsed?: string;
  }): void {
    const now = new Date();
    this.getDb().prepare(`
      INSERT INTO interaction_logs (topic, query_type, tool_used, day_of_week, hour_of_day, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      data.topic,
      data.queryType,
      data.toolUsed ?? null,
      now.getDay(),
      now.getHours(),
      now.toISOString(),
    );
  }

  hasEnoughData(): boolean {
    const oldest = this.getDb().prepare(`
      SELECT MIN(timestamp) as first FROM interaction_logs
    `).get() as { first: string | null };

    if (!oldest?.first) return false;
    const weeks = (Date.now() - new Date(oldest.first).getTime()) / (7 * 24 * 60 * 60 * 1000);
    return weeks >= this.minWeeksData;
  }

  async analyzePatterns(agent: CtoAgent): Promise<PatternInsight[]> {
    if (!this.hasEnoughData()) return [];

    const logs = this.getDb().prepare(`
      SELECT topic, query_type, tool_used, day_of_week, hour_of_day, timestamp
      FROM interaction_logs ORDER BY timestamp DESC LIMIT 500
    `).all() as InteractionLog[];

    const topicCounts = new Map<string, number>();
    const hourDistribution = new Map<number, number>();

    for (const log of logs) {
      topicCounts.set(log.topic, (topicCounts.get(log.topic) || 0) + 1);
      hourDistribution.set(log.hourOfDay, (hourDistribution.get(log.hourOfDay) || 0) + 1);
    }

    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const recentTopics = new Set(
      (this.getDb().prepare(`
        SELECT DISTINCT topic FROM interaction_logs WHERE timestamp > ?
      `).all(twoWeeksAgo) as { topic: string }[]).map((r) => r.topic),
    );

    const allTopics = Array.from(topicCounts.keys());
    const gaps = allTopics.filter((t) => !recentTopics.has(t) && (topicCounts.get(t) || 0) >= 3);

    const summary = {
      totalInteractions: logs.length,
      topTopics: Array.from(topicCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15),
      gapTopics: gaps,
      peakHours: Array.from(hourDistribution.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5),
    };

    const result = await agent.process({
      text: JSON.stringify(summary, null, 2),
      source: 'cron',
    }, `Analyze the user's interaction patterns from this data.
Generate insights in these categories:
1. Temporal: when does he check on specific topics?
2. Frequency: what does he check most/least?
3. Gaps: topics he tracked regularly but stopped checking
4. Behavioral: any notable patterns in his CTO workflow?

Return as JSON array of: { type, description, confidence (0-1), relevantOn? }
Portuguese for descriptions. Max 10 insights.`);

    try {
      const jsonMatch = result.text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const insights = JSON.parse(jsonMatch[0]) as PatternInsight[];
        this.storeInsights(insights);
        return insights;
      }
    } catch {
      console.error('[patterns] Failed to parse Claude response');
    }

    return [];
  }

  getRelevantInsights(dayOfWeek?: number): PatternInsight[] {
    const now = new Date();
    const rows = this.getDb().prepare(`
      SELECT type, description, confidence, relevant_on
      FROM pattern_insights WHERE expires_at > ?
      ORDER BY confidence DESC LIMIT 5
    `).all(now.toISOString()) as PatternInsight[];

    if (dayOfWeek !== undefined) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return rows.filter((r) => !r.relevantOn || r.relevantOn === dayNames[dayOfWeek]);
    }
    return rows;
  }

  clearPatterns(): void {
    this.getDb().prepare('DELETE FROM interaction_logs').run();
    this.getDb().prepare('DELETE FROM pattern_insights').run();
  }

  private storeInsights(insights: PatternInsight[]): void {
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    this.getDb().prepare('DELETE FROM pattern_insights').run();

    const stmt = this.getDb().prepare(`
      INSERT INTO pattern_insights (type, description, confidence, relevant_on, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const insight of insights) {
      stmt.run(insight.type, insight.description, insight.confidence, insight.relevantOn ?? null, now, expires);
    }
  }
}
