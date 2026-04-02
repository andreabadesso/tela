import { readFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { extname } from 'node:path';
import { PDFParse } from 'pdf-parse';
import type { AgentService } from '../agent/service.js';
import type { createVaultTools } from '../tools/vault.js';
import type { GitSync } from '../core/git.js';
import type { NotificationManager } from '../notifications/manager.js';

const execFileAsync = promisify(execFileCb);

const URL_MAX_CHARS = 5_000;

type ContentType = 'url' | 'pdf' | 'image' | 'youtube' | 'tweet' | 'text' | 'audio';

interface IngestedContent {
  type: ContentType;
  rawContent: string;
  parsedContent: string;
  summary: string;
  classification: 'reference' | 'idea' | 'action' | 'ignore';
  savedTo: string | null;
  relatedNotes: string[];
}

type VaultTools = ReturnType<typeof createVaultTools>;

function todayDateStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Strip HTML to plain text: remove script/style blocks, tags, and decode entities.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export class KnowledgeIngestionService {
  constructor(
    private agentService: AgentService,
    private defaultAgentId: string,
    private vault: VaultTools,
    private gitSync: GitSync,
    private notificationManager: NotificationManager,
  ) {}

  /**
   * Main entry point: detect content type, parse, process with Claude, save, and notify.
   */
  async ingest(input: string, messageId: number): Promise<IngestedContent> {
    const type = this.detectType(input);
    let parsedContent: string;

    try {
      parsedContent = await this.parse(input, type);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[knowledge] Parse failed for type=${type}:`, errorMsg);
      parsedContent = input;
      await this.notificationManager.broadcast({
        body: `Erro ao processar conteudo (${type}): ${errorMsg}\nSalvando conteudo bruto.`,
        priority: 'high',
        source: 'knowledge',
      });
    }

    // Process with Claude
    let claudeResult: {
      summary: string;
      classification: 'reference' | 'idea' | 'action' | 'ignore';
      relatedNotes: string[];
    };

    try {
      claudeResult = await this.processWithClaude(parsedContent, type);
    } catch (err) {
      console.error('[knowledge] Claude processing failed:', err);
      claudeResult = {
        summary: parsedContent.slice(0, 200),
        classification: 'reference',
        relatedNotes: [],
      };
    }

    const content: IngestedContent = {
      type,
      rawContent: input,
      parsedContent,
      summary: claudeResult.summary,
      classification: claudeResult.classification,
      savedTo: null,
      relatedNotes: claudeResult.relatedNotes,
    };

    // Save to vault
    try {
      content.savedTo = await this.saveToVault(content);
    } catch (err) {
      console.error('[knowledge] Failed to save to vault:', err);
    }

    // Git push
    if (content.savedTo) {
      try {
        await this.gitSync.commitAndPush(`knowledge: ${type} — ${content.savedTo}`);
      } catch (err) {
        console.error('[knowledge] Git push failed:', err);
      }
    }

    // Notify result
    const relatedSection =
      content.relatedNotes.length > 0
        ? `\n\nNotas relacionadas:\n${content.relatedNotes.map((n) => `  - ${n}`).join('\n')}`
        : '';

    const savedSection = content.savedTo
      ? `\nSalvo em: ${content.savedTo}`
      : '\nNao salvo (classificado como ignore)';

    const body = [
      `${this.typeLabel(type)} — ${content.classification}`,
      '',
      content.summary,
      savedSection,
      relatedSection,
    ].join('\n');

    try {
      await this.notificationManager.broadcast({
        title: `${this.typeLabel(type)} ingested`,
        body,
        priority: 'normal',
        source: 'knowledge',
      });
    } catch (err) {
      console.error('[knowledge] Failed to send notification:', err);
    }

    return content;
  }

  /**
   * Detect the content type from the input string.
   */
  private detectType(input: string): ContentType {
    const trimmed = input.trim();

    // Check URLs first
    if (/^https?:\/\//i.test(trimmed)) {
      if (/(?:youtube\.com|youtu\.be)\//i.test(trimmed)) return 'youtube';
      if (/(?:twitter\.com|x\.com)\//i.test(trimmed)) return 'tweet';
      return 'url';
    }

    // File paths by extension
    const ext = extname(trimmed).toLowerCase();
    if (ext === '.pdf') return 'pdf';
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'image';
    if (['.mp3', '.ogg', '.m4a', '.wav'].includes(ext)) return 'audio';

    return 'text';
  }

  /**
   * Route to the appropriate parser based on type.
   */
  private async parse(input: string, type: ContentType): Promise<string> {
    switch (type) {
      case 'url':
        return this.parseUrl(input.trim());
      case 'pdf':
        return this.parsePdf(input.trim());
      case 'youtube':
        return this.parseYoutube(input.trim());
      case 'tweet':
        return this.parseTweet(input.trim());
      case 'image':
        return `[Image file: ${input.trim()}]`;
      case 'audio':
        return `[Audio file: ${input.trim()}]`;
      case 'text':
        return input;
    }
  }

  /**
   * Fetch a URL and strip HTML to plain text. Limited to first 5000 chars.
   */
  private async parseUrl(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeBot/1.0)',
        Accept: 'text/html,application/xhtml+xml,text/plain',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();

    if (contentType.includes('text/plain')) {
      return body.slice(0, URL_MAX_CHARS);
    }

    const text = stripHtml(body);
    return text.slice(0, URL_MAX_CHARS);
  }

  /**
   * Extract text from a PDF file using pdf-parse.
   */
  private async parsePdf(filePath: string): Promise<string> {
    const buffer = await readFile(filePath);
    const pdf = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await pdf.getText();
      return result.text;
    } finally {
      await pdf.destroy();
    }
  }

  /**
   * Attempt to get YouTube transcript via yt-dlp. Falls back to URL-only.
   */
  private async parseYoutube(url: string): Promise<string> {
    // Extract video ID for temp file naming
    const videoIdMatch = url.match(
      /(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    );
    const videoId = videoIdMatch?.[1] ?? 'unknown';

    try {
      await execFileAsync('yt-dlp', [
        '--write-auto-sub',
        '--skip-download',
        '--sub-lang', 'pt,en',
        '-o', `/tmp/yt-${videoId}`,
        url,
      ], { timeout: 60_000 });

      // Try to read the downloaded subtitle file
      const possibleExts = ['.pt.vtt', '.en.vtt', '.pt.srt', '.en.srt'];
      for (const ext of possibleExts) {
        try {
          const subtitleContent = await readFile(`/tmp/yt-${videoId}${ext}`, 'utf-8');
          // Strip VTT/SRT formatting
          return stripSubtitle(subtitleContent, ext);
        } catch {
          // Try next extension
        }
      }

      return `[YouTube: ${url}] (subtitle downloaded but could not be read)`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[knowledge] yt-dlp failed: ${message}`);
      return `[YouTube: ${url}] (transcript unavailable — yt-dlp not available or failed)`;
    }
  }

  /**
   * Attempt to get tweet content. Falls back to URL reference.
   */
  private async parseTweet(url: string): Promise<string> {
    // Try nitter instances for public tweet content
    const nitterInstances = [
      'nitter.net',
      'nitter.privacydev.net',
    ];

    const tweetPath = url
      .replace(/https?:\/\/(twitter\.com|x\.com)/, '')
      .split('?')[0];

    for (const instance of nitterInstances) {
      try {
        const nitterUrl = `https://${instance}${tweetPath}`;
        const response = await fetch(nitterUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeBot/1.0)',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) continue;

        const html = await response.text();
        const tweetText = stripHtml(html);
        if (tweetText.length > 50) {
          return tweetText.slice(0, URL_MAX_CHARS);
        }
      } catch {
        // Try next instance
      }
    }

    return `[Tweet: ${url}] (content could not be fetched — check manually)`;
  }

  /**
   * Send parsed content to Claude for summarization, classification, and related note discovery.
   */
  private async processWithClaude(
    content: string,
    type: ContentType,
  ): Promise<{
    summary: string;
    classification: 'reference' | 'idea' | 'action' | 'ignore';
    relatedNotes: string[];
  }> {
    const systemPromptAddition = `You are processing ingested content of type "${type}". Respond in Portuguese (BR).

Analyze the content and produce a JSON response with exactly these fields:
{
  "summary": "2-3 paragraph summary of the content",
  "classification": "reference|idea|action|ignore",
  "title": "short title for the content (max 60 chars)",
  "relatedNotes": ["list of vault note paths that might be related"]
}

Classification rules:
- "reference": articles, documentation, technical content worth archiving
- "idea": content that sparks a new idea or project
- "action": content that requires doing something (task, follow-up)
- "ignore": spam, irrelevant, or low-value content

To find related notes, use the search_vault tool to look for keywords from the content.

IMPORTANT: Your final response MUST be valid JSON and nothing else.`;

    const result = await this.agentService.process(
      this.defaultAgentId,
      { text: content.slice(0, 10_000), source: 'event', instructions: systemPromptAddition },
    );

    try {
      // Extract JSON from the response (may be wrapped in markdown code blocks)
      const jsonStr = result.text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(jsonStr) as {
        summary: string;
        classification: string;
        title?: string;
        relatedNotes: string[];
      };

      const validClassifications = ['reference', 'idea', 'action', 'ignore'] as const;
      const classification = validClassifications.includes(
        parsed.classification as typeof validClassifications[number],
      )
        ? (parsed.classification as typeof validClassifications[number])
        : 'reference';

      return {
        summary: parsed.summary || content.slice(0, 200),
        classification,
        relatedNotes: Array.isArray(parsed.relatedNotes) ? parsed.relatedNotes : [],
      };
    } catch (err) {
      console.error('[knowledge] Failed to parse Claude JSON response:', err);
      // Fallback: use the raw text as summary
      return {
        summary: result.text.slice(0, 500),
        classification: 'reference',
        relatedNotes: [],
      };
    }
  }

  /**
   * Save content to the vault based on its classification.
   */
  private async saveToVault(content: IngestedContent): Promise<string | null> {
    const dateStr = todayDateStr();

    // Extract title from summary (first line or first sentence)
    const title = this.extractTitle(content);
    const sanitizedTitle = title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 60);

    switch (content.classification) {
      case 'reference': {
        const path = `Knowledge/Articles/${dateStr} ${sanitizedTitle}.md`;
        const noteContent = this.buildNote(content, title, dateStr);
        await this.vault.write_note(path, noteContent);
        return path;
      }

      case 'idea': {
        const path = `Inbox/${dateStr} ${sanitizedTitle}.md`;
        const noteContent = this.buildNote(content, title, dateStr);
        await this.vault.write_note(path, noteContent);
        return path;
      }

      case 'action': {
        const dailyPath = `Daily/${dateStr}.md`;
        const actionText = `\n\n### Action: ${title}\n${content.summary}\n- Source: ${content.rawContent.slice(0, 200)}`;
        await this.vault.append_to_note(dailyPath, actionText);
        return dailyPath;
      }

      case 'ignore':
        return null;
    }
  }

  /**
   * Build a full Obsidian note with frontmatter.
   */
  private buildNote(content: IngestedContent, title: string, dateStr: string): string {
    const relatedLinks = content.relatedNotes
      .map((n) => `  - "[[${n}]]"`)
      .join('\n');

    const frontmatter = [
      '---',
      `title: "${title}"`,
      `date: ${dateStr}`,
      `type: ${content.type}`,
      `classification: ${content.classification}`,
      `source: "${content.rawContent.slice(0, 200).replace(/"/g, '\\"')}"`,
      '---',
    ].join('\n');

    const body = [
      `# ${title}`,
      '',
      content.summary,
      '',
      '## Source Content',
      '',
      content.parsedContent.slice(0, 20_000),
    ].join('\n');

    const related =
      content.relatedNotes.length > 0
        ? `\n\n## Related Notes\n${content.relatedNotes.map((n) => `- [[${n}]]`).join('\n')}`
        : '';

    return `${frontmatter}\n\n${body}${related}\n`;
  }

  /**
   * Extract a short title from the content.
   */
  private extractTitle(content: IngestedContent): string {
    // Try to get title from summary first line
    const firstLine = content.summary.split('\n')[0]?.trim();
    if (firstLine && firstLine.length > 5 && firstLine.length <= 80) {
      return firstLine.replace(/^#+\s*/, '');
    }

    // Fall back to source-based title
    if (content.type === 'url' || content.type === 'youtube' || content.type === 'tweet') {
      try {
        const url = new URL(content.rawContent.trim());
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length > 0) {
          return decodeURIComponent(pathParts[pathParts.length - 1])
            .replace(/[-_]+/g, ' ')
            .slice(0, 60);
        }
        return url.hostname;
      } catch {
        // Not a valid URL
      }
    }

    return content.parsedContent.slice(0, 50).replace(/\n/g, ' ').trim() || 'Untitled';
  }

  /**
   * Human-readable label for content types.
   */
  private typeLabel(type: ContentType): string {
    const labels: Record<ContentType, string> = {
      url: 'Artigo/URL',
      pdf: 'PDF',
      image: 'Imagem',
      youtube: 'YouTube',
      tweet: 'Tweet',
      text: 'Texto',
      audio: 'Audio',
    };
    return labels[type];
  }
}

/**
 * Strip subtitle formatting (SRT or VTT) to plain text.
 */
function stripSubtitle(content: string, ext: string): string {
  if (ext.endsWith('.vtt')) {
    return content
      .replace(/^WEBVTT.*$/m, '')
      .replace(/^Kind:.*$/gm, '')
      .replace(/^Language:.*$/gm, '')
      .replace(/\d{2}:\d{2}[:.]\d{2,3}\s*-->\s*\d{2}:\d{2}[:.]\d{2,3}.*$/gm, '')
      .replace(/<[^>]+>/g, '')
      .replace(/^\d+\s*$/gm, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // SRT
  return content
    .replace(/^\d+\s*$/gm, '')
    .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
