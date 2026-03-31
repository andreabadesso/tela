import matter from 'gray-matter';
import { basename, dirname } from 'node:path';

export interface VaultChunk {
  content: string;
  metadata: {
    file: string;
    folder: string;
    heading: string;
    tags: string[];
    lastModified: string;
  };
}

const MAX_CHUNK_SIZE = 2000;

/**
 * Extract tags from frontmatter + inline #tags in body.
 */
export function extractTags(frontmatter: Record<string, unknown>, body: string): string[] {
  const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [];
  const inlineTags = [...body.matchAll(/#([a-zA-Z][\w/-]*)/g)].map((m) => m[1]);
  return [...new Set([...fmTags, ...inlineTags])];
}

/**
 * Extract wikilinks from body: [[Note Name]] and [[Note Name|Display Text]].
 */
export function extractWikilinks(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]);
}

/**
 * Parse an Obsidian note, returning frontmatter, body, tags, and wikilinks.
 */
export function parseNote(content: string) {
  const { data: frontmatter, content: body } = matter(content);
  return {
    frontmatter,
    body,
    tags: extractTags(frontmatter, body),
    wikilinks: extractWikilinks(body),
  };
}

/**
 * Split text on paragraph boundaries (double newline), keeping chunks under maxSize.
 */
function splitOnParagraphs(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxSize && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Heading-aware Markdown chunking for vector search.
 *
 * 1. Parses frontmatter with gray-matter
 * 2. Splits on ## headings
 * 3. Each section becomes a chunk with heading path context
 * 4. Sections > 2000 chars split on paragraph boundaries
 * 5. Prepends note title + heading path to each chunk
 * 6. Includes tags and folder in metadata
 */
export function chunkMarkdown(filePath: string, content: string, lastModified: Date): VaultChunk[] {
  const { frontmatter, body, tags } = parseNote(content);

  const noteTitle =
    typeof frontmatter.title === 'string'
      ? frontmatter.title
      : basename(filePath, '.md');
  const folder = dirname(filePath).split('/')[0] || '';

  const chunks: VaultChunk[] = [];
  const lastModifiedStr = lastModified.toISOString();

  // Split body on heading boundaries (## or deeper)
  // We track heading hierarchy to build heading paths
  const lines = body.split('\n');
  const sections: { headingPath: string; content: string }[] = [];
  let currentHeadings: string[] = [];
  let currentContent = '';

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      // Flush previous section
      if (currentContent.trim()) {
        const headingPath = currentHeadings.length > 0
          ? noteTitle + ' > ' + currentHeadings.join(' > ')
          : noteTitle;
        sections.push({ headingPath, content: currentContent.trim() });
      }
      currentContent = '';

      // Update heading hierarchy
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      // Truncate headings array to the parent level
      currentHeadings = currentHeadings.slice(0, level - 1);
      currentHeadings[level - 1] = text;
      // Trim any undefined gaps
      currentHeadings = currentHeadings.filter(Boolean);
    } else {
      currentContent += line + '\n';
    }
  }

  // Flush final section
  if (currentContent.trim()) {
    const headingPath = currentHeadings.length > 0
      ? noteTitle + ' > ' + currentHeadings.join(' > ')
      : noteTitle;
    sections.push({ headingPath, content: currentContent.trim() });
  }

  // If no sections at all (empty note), return empty
  if (sections.length === 0) return [];

  // Process each section into chunks
  for (const section of sections) {
    const prefix = `[${section.headingPath}]\n\n`;

    if (section.content.length + prefix.length <= MAX_CHUNK_SIZE) {
      chunks.push({
        content: prefix + section.content,
        metadata: {
          file: filePath,
          folder,
          heading: section.headingPath,
          tags,
          lastModified: lastModifiedStr,
        },
      });
    } else {
      // Split large sections on paragraph boundaries
      const subChunks = splitOnParagraphs(section.content, MAX_CHUNK_SIZE - prefix.length);
      for (const sub of subChunks) {
        chunks.push({
          content: prefix + sub,
          metadata: {
            file: filePath,
            folder,
            heading: section.headingPath,
            tags,
            lastModified: lastModifiedStr,
          },
        });
      }
    }
  }

  return chunks;
}
