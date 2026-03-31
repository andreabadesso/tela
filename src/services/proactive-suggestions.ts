import type { CtoAgent } from '../agent.js';
import type { createVaultTools } from '../tools/vault.js';
import type { CalendarService } from './calendar.js';
import type { PatternLearningService } from './pattern-learning.js';
import type { DatabaseService } from './database.js';

interface Suggestion {
  type: 'people' | 'decision' | 'roadmap' | 'pattern';
  title: string;
  description: string;
  suggestedAction: string;
  urgency: 'low' | 'medium' | 'high';
}

export class ProactiveSuggestionsService {
  constructor(
    private agent: CtoAgent,
    private vault: ReturnType<typeof createVaultTools>,
    private calendar: CalendarService | null,
    private patterns: PatternLearningService | null,
    private db: DatabaseService,
  ) {
    this.ensureTable();
  }

  private getDb() {
    return (this.db as unknown as { db: import('better-sqlite3').Database }).db;
  }

  private ensureTable(): void {
    this.getDb().prepare(`
      CREATE TABLE IF NOT EXISTS suggestion_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        suggestion_title TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `).run();
  }

  async generateSuggestions(): Promise<Suggestion[]> {
    const suggestions: Suggestion[] = [];

    // 1. People-based: stale 1:1s
    try {
      const personNotes = await this.vault.list_notes('Work/Pessoas', { recursive: true });
      for (const note of personNotes.slice(0, 20)) {
        try {
          const content = await this.vault.read_note(note);
          const lastMeetingMatch = content.match(/(?:last\s+(?:1:1|meeting|interaction)|última\s+(?:reunião|interação)).*?(\d{4}-\d{2}-\d{2})/i);
          if (lastMeetingMatch) {
            const lastDate = new Date(lastMeetingMatch[1]);
            const daysSince = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince > 21) {
              const name = note.split('/').pop()?.replace('.md', '') || note;
              suggestions.push({
                type: 'people',
                title: `1:1 com ${name}`,
                description: `Última interação há ${Math.floor(daysSince)} dias.`,
                suggestedAction: `Agendar 1:1 com ${name}`,
                urgency: daysSince > 30 ? 'high' : 'medium',
              });
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* no Pessoas dir */ }

    // 2. Decision review dates
    try {
      const decisions = await this.vault.search_vault('review_date', { path: 'Work', maxResults: 20 });
      const today = new Date().toISOString().split('T')[0];
      for (const result of decisions) {
        const dateMatch = result.content.match(/review_date:\s*(\d{4}-\d{2}-\d{2})/);
        if (dateMatch && dateMatch[1] <= today) {
          suggestions.push({
            type: 'decision',
            title: `Revisão de decisão`,
            description: `Decisão em ${result.file} tem review marcado para ${dateMatch[1]}.`,
            suggestedAction: 'Revisar se a decisão ainda é válida',
            urgency: 'high',
          });
        }
      }
    } catch { /* no decisions */ }

    // 3. Pattern-based
    if (this.patterns?.hasEnoughData()) {
      const insights = this.patterns.getRelevantInsights(new Date().getDay());
      for (const insight of insights.filter((i) => i.type === 'gap')) {
        suggestions.push({
          type: 'pattern',
          title: 'Padrão detectado',
          description: insight.description,
          suggestedAction: 'Verificar se precisa de atenção',
          urgency: 'low',
        });
      }
    }

    // Filter dismissed
    const dismissed = this.getDismissed();
    const filtered = suggestions.filter((s) => !dismissed.has(s.title));

    const urgencyOrder = { high: 0, medium: 1, low: 2 };
    filtered.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

    return filtered.slice(0, 5);
  }

  dismiss(title: string): void {
    this.getDb().prepare(`
      INSERT INTO suggestion_feedback (suggestion_title, action, timestamp)
      VALUES (?, 'dismissed', ?)
    `).run(title, new Date().toISOString());
  }

  actedOn(title: string): void {
    this.getDb().prepare(`
      INSERT INTO suggestion_feedback (suggestion_title, action, timestamp)
      VALUES (?, 'acted', ?)
    `).run(title, new Date().toISOString());
  }

  private getDismissed(): Set<string> {
    const rows = this.getDb().prepare(`
      SELECT suggestion_title FROM suggestion_feedback
      WHERE action = 'dismissed' AND timestamp > ?
    `).all(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()) as { suggestion_title: string }[];
    return new Set(rows.map((r) => r.suggestion_title));
  }
}
