import chokidar, { type FSWatcher } from 'chokidar';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { CtoAgent } from '../agent.js';
import type { createVaultTools } from '../tools/vault.js';
import type { GitSync } from './git.js';
import type { TelegramService } from './telegram.js';
import type { CalendarService, CalendarEvent } from './calendar.js';

const DEBOUNCE_MS = 5_000;
const WATCHED_EXTENSIONS = ['.txt', '.md', '.srt', '.vtt'];
const MEETING_MATCH_WINDOW_MS = 2 * 60 * 60 * 1_000; // 2 hours

type VaultTools = ReturnType<typeof createVaultTools>;

interface MeetingMatch {
  title: string;
  attendees: string[];
}

/**
 * Strip SRT timestamps and sequence numbers, returning plain text.
 * SRT format: sequence number, timestamp line, text, blank line.
 */
function stripSrt(raw: string): string {
  return raw
    .replace(/^\d+\s*$/gm, '')                          // sequence numbers
    .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '') // timestamps
    .replace(/<[^>]+>/g, '')                             // HTML-style tags
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Strip VTT timestamps and metadata, returning plain text.
 */
function stripVtt(raw: string): string {
  const lines = raw.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip WEBVTT header, NOTE blocks, timestamp lines, blank lines
    if (
      trimmed === 'WEBVTT' ||
      trimmed.startsWith('NOTE') ||
      trimmed.startsWith('Kind:') ||
      trimmed.startsWith('Language:') ||
      /^\d{2}:\d{2}[:.]\d{2,3}\s*-->\s*\d{2}:\d{2}[:.]\d{2,3}/.test(trimmed) ||
      /^\d+$/.test(trimmed) ||
      trimmed === ''
    ) {
      continue;
    }
    textLines.push(trimmed.replace(/<[^>]+>/g, ''));
  }

  return textLines.join(' ').replace(/\s{2,}/g, ' ').trim();
}

function todayDateStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export class TranscriptProcessor {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private watchDir: string,
    private agent: CtoAgent,
    private vault: VaultTools,
    private gitSync: GitSync,
    private telegram: TelegramService,
    private calendar: CalendarService | null,
  ) {}

  /**
   * Start watching the transcript directory for new files.
   */
  start(): void {
    if (this.watcher) return;

    const globPattern = WATCHED_EXTENSIONS.map((ext) => `**/*${ext}`);

    this.watcher = chokidar.watch(globPattern, {
      cwd: this.watchDir,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: DEBOUNCE_MS, pollInterval: 500 },
    });

    this.watcher.on('add', (relativePath: string) => {
      this.scheduleProcess(`${this.watchDir}/${relativePath}`);
    });

    this.watcher.on('change', (relativePath: string) => {
      this.scheduleProcess(`${this.watchDir}/${relativePath}`);
    });

    console.log(`[transcript] Watching ${this.watchDir} for transcripts`);
  }

  /**
   * Stop watching and clear pending timers.
   */
  stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    console.log('[transcript] Stopped watching');
  }

  /**
   * Debounce processing: wait 5s after last write before processing.
   */
  private scheduleProcess(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.processFile(filePath).catch((err) => {
        console.error(`[transcript] Failed to process ${filePath}:`, err);
      });
    }, DEBOUNCE_MS);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Process a single transcript file end-to-end.
   */
  async processFile(filePath: string): Promise<void> {
    console.log(`[transcript] Processing ${filePath}`);

    let rawContent: string;
    try {
      rawContent = await readFile(filePath, 'utf-8');
    } catch (err) {
      console.error(`[transcript] Could not read ${filePath}:`, err);
      return;
    }

    if (rawContent.trim().length === 0) {
      console.log(`[transcript] Skipping empty file: ${filePath}`);
      return;
    }

    // Strip timestamps from subtitle formats
    const ext = extname(filePath).toLowerCase();
    let content: string;
    if (ext === '.srt') {
      content = stripSrt(rawContent);
    } else if (ext === '.vtt') {
      content = stripVtt(rawContent);
    } else {
      content = rawContent;
    }

    // Try to match with a calendar event
    const meetingMatch = await this.findMeetingMatch(filePath, content);
    const meetingTitle = meetingMatch?.title ?? this.inferTitle(filePath);
    const meetingType = this.classifyMeeting(content);
    const attendeesList = meetingMatch?.attendees ?? [];

    // Process with Claude
    const systemPromptAddition = `You are processing a meeting transcript. Respond in Portuguese (BR).

Meeting type: ${meetingType}
Meeting title: ${meetingTitle}
Known attendees: ${attendeesList.length > 0 ? attendeesList.join(', ') : 'Unknown'}

Analyze this transcript and produce:

1. **Resumo** (3-5 paragraphs summarizing the meeting)
2. **Decisoes** — each decision with who decided, formatted as:
   - [Decision]: decided by [Person]
3. **Action Items** — each action with owner, formatted as:
   - [ ] [Action]: @[Owner]
4. **Observacoes por Pessoa** — behavioral observations for each participant:
   - [Name]: [observations about their behavior, engagement, concerns]
5. **Red Flags / Tensoes** — any tensions, disagreements, or concerns flagged

Structure the output as a full Obsidian-compatible markdown note with YAML frontmatter:
---
title: "${meetingTitle}"
date: ${todayDateStr()}
type: meeting
meeting_type: ${meetingType}
attendees: [${attendeesList.map((a) => `"${a}"`).join(', ')}]
---

Then the sections above.

Also, at the very end, in a section called "## Meta", include:
- DECISIONS_COUNT: <number>
- ACTION_ITEMS_COUNT: <number>
- A one-line summary (max 100 chars) for Telegram notification.`;

    const result = await this.agent.process(
      { text: content, source: 'event' },
      systemPromptAddition,
    );

    const noteContent = result.text;
    const dateStr = todayDateStr();

    // Write the full meeting note
    const sanitizedTitle = meetingTitle.replace(/[/\\:*?"<>|]/g, '-');
    const meetingNotePath = `Work/Meetings/${dateStr} ${sanitizedTitle}.md`;

    try {
      await this.vault.write_note(meetingNotePath, noteContent);
      console.log(`[transcript] Written meeting note: ${meetingNotePath}`);
    } catch (err) {
      console.error('[transcript] Failed to write meeting note:', err);
    }

    // Update Pessoas docs for each attendee
    for (const attendee of attendeesList) {
      try {
        const pessoaPath = `Work/Pessoas/${attendee}.md`;
        const appendText = `\n\n### ${dateStr} — ${meetingTitle}\n- Participou da reuniao\n- Ver: [[${meetingNotePath}]]`;
        await this.vault.append_to_note(pessoaPath, appendText);
      } catch (err) {
        console.error(`[transcript] Failed to update Pessoas/${attendee}:`, err);
      }
    }

    // Extract decisions and append to Decisoes.md
    const decisionsMatch = noteContent.match(/## Decisoes\n([\s\S]*?)(?=\n## |$)/i);
    if (decisionsMatch) {
      try {
        const decisionsText = `\n### ${dateStr} — ${meetingTitle}\n${decisionsMatch[1].trim()}`;
        await this.vault.append_to_note('Work/Decisoes.md', decisionsText);
      } catch (err) {
        console.error('[transcript] Failed to append to Decisoes.md:', err);
      }
    }

    // Append summary to daily note
    try {
      const summaryMatch = noteContent.match(/## Resumo\n([\s\S]*?)(?=\n## |$)/i);
      const summaryText = summaryMatch
        ? summaryMatch[1].trim()
        : `Reuniao processada: ${meetingTitle}`;
      await this.vault.append_to_note(
        `Daily/${dateStr}.md`,
        `\n\n### Reuniao: ${meetingTitle}\n${summaryText}\n- Ver: [[${meetingNotePath}]]`,
      );
    } catch (err) {
      console.error('[transcript] Failed to append to daily note:', err);
    }

    // Git commit + push
    try {
      await this.gitSync.commitAndPush(`transcript: ${meetingTitle} (${dateStr})`);
    } catch (err) {
      console.error('[transcript] Git push failed:', err);
    }

    // Extract counts for Telegram notification
    const decisionsCount = (noteContent.match(/^- .+: decided by/gim) ?? []).length;
    const actionItemsCount = (noteContent.match(/^- \[ \]/gm) ?? []).length;
    const oneLineSummary =
      noteContent.match(/ONE_LINE_SUMMARY:\s*(.+)/i)?.[1]?.trim() ??
      `Reuniao "${meetingTitle}" processada`;

    // Send Telegram notification
    const telegramMsg = [
      `<b>Reuniao processada</b>`,
      ``,
      oneLineSummary,
      ``,
      `Decisoes: ${decisionsCount}`,
      `Action items: ${actionItemsCount}`,
      `Salvo em: ${meetingNotePath}`,
    ].join('\n');

    try {
      await this.telegram.send(telegramMsg, { parseMode: 'HTML' });
    } catch (err) {
      console.error('[transcript] Failed to send Telegram notification:', err);
    }

    console.log(`[transcript] Finished processing ${filePath}`);
  }

  /**
   * Cross-reference the transcript file with calendar events.
   * Looks for a meeting within 2 hours of the file's modification time.
   */
  private async findMeetingMatch(
    filePath: string,
    content: string,
  ): Promise<MeetingMatch | null> {
    if (!this.calendar) return null;

    try {
      const fileStat = await stat(filePath);
      const fileMtime = fileStat.mtime.getTime();

      // Search for events in a window around the file's mtime
      const windowStart = new Date(fileMtime - MEETING_MATCH_WINDOW_MS).toISOString();
      const windowEnd = new Date(fileMtime + MEETING_MATCH_WINDOW_MS).toISOString();

      const events = await this.calendar.getEventsForDateRange(windowStart, windowEnd);

      if (events.length === 0) return null;

      // Score each event by time proximity and attendee name matches
      let bestEvent: CalendarEvent | null = null;
      let bestScore = -1;

      const contentLower = content.toLowerCase();

      for (const event of events) {
        let score = 0;

        // Time proximity: closer = higher score (max 100)
        const eventStart = new Date(event.start).getTime();
        const timeDiff = Math.abs(fileMtime - eventStart);
        score += Math.max(0, 100 - (timeDiff / MEETING_MATCH_WINDOW_MS) * 100);

        // Attendee name matches: each match adds 50
        for (const attendee of event.attendees) {
          const name = attendee.name.toLowerCase();
          if (name && contentLower.includes(name)) {
            score += 50;
          }
        }

        // Title words in content
        const titleWords = event.title
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);
        for (const word of titleWords) {
          if (contentLower.includes(word)) {
            score += 10;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestEvent = event;
        }
      }

      if (bestEvent && bestScore > 30) {
        return {
          title: bestEvent.title,
          attendees: bestEvent.attendees
            .map((a) => a.name || a.email.split('@')[0])
            .filter(Boolean),
        };
      }

      return null;
    } catch (err) {
      console.error('[transcript] Calendar match failed:', err);
      return null;
    }
  }

  /**
   * Classify the meeting type based on transcript content keywords.
   */
  private classifyMeeting(content: string): string {
    const lower = content.toLowerCase();

    const patterns: [string, string[]][] = [
      ['1:1', ['one-on-one', '1:1', '1-on-1', 'one on one']],
      ['standup', ['standup', 'stand-up', 'daily', 'scrum']],
      ['sprint', ['sprint', 'planning', 'retrospectiva', 'retro']],
      ['entrevista', ['entrevista', 'interview', 'candidato', 'candidate']],
      ['arquitetura', ['arquitetura', 'architecture', 'design review', 'rfc', 'adr']],
      ['produto', ['produto', 'product', 'roadmap', 'backlog', 'prioridade']],
      ['alinhamento', ['alinhamento', 'sync', 'alignment', 'all-hands']],
      ['incidente', ['incidente', 'incident', 'postmortem', 'outage', 'hotfix']],
    ];

    for (const [type, keywords] of patterns) {
      for (const keyword of keywords) {
        if (lower.includes(keyword)) return type;
      }
    }

    return 'geral';
  }

  /**
   * Infer a title from the filename when no calendar match is found.
   */
  private inferTitle(filePath: string): string {
    const name = basename(filePath, extname(filePath));
    // Clean up common patterns: timestamps, underscores, dashes
    return name
      .replace(/^\d{4}-?\d{2}-?\d{2}[_\-\s]*/, '')
      .replace(/^\d{10,13}[_\-\s]*/, '')
      .replace(/[_-]+/g, ' ')
      .trim() || 'Reuniao sem titulo';
  }
}
