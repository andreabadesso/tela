import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { resolve, relative, dirname, extname, join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { SearchResult, Task } from '../types/index.js';

// execFile is safe against shell injection (no shell interpretation of arguments)
const execFileAsync = promisify(execFileCb);

function safePath(vaultPath: string, relativePath: string): string {
  const resolved = resolve(vaultPath, relativePath);
  if (!resolved.startsWith(vaultPath + '/') && resolved !== vaultPath) {
    throw new Error(`Path traversal rejected: ${relativePath}`);
  }
  return resolved;
}

function todaySaoPaulo(dateStr?: string): string {
  if (dateStr) return dateStr;
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now); // YYYY-MM-DD
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkDir(
  dir: string,
  extensions: string[],
  recursive: boolean,
): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      results.push(...(await walkDir(fullPath, extensions, recursive)));
    } else if (entry.isFile() && extensions.includes(extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}

async function searchWithRipgrep(
  vaultPath: string,
  query: string,
  searchPath: string,
  maxResults: number,
  contextLines: number,
): Promise<SearchResult[]> {
  const args = [
    '--json',
    '--max-count', String(maxResults),
    '-C', String(contextLines),
    '--type', 'md',
    query,
    searchPath,
  ];

  const { stdout } = await execFileAsync('rg', args, {
    maxBuffer: 10 * 1024 * 1024,
  });

  const results: SearchResult[] = [];
  const lines = stdout.trim().split('\n').filter(Boolean);

  let currentContext: string[] = [];
  let pendingResult: SearchResult | null = null;

  for (const line of lines) {
    const parsed = JSON.parse(line) as {
      type: string;
      data: {
        path?: { text: string };
        line_number?: number;
        lines?: { text: string };
        submatches?: unknown[];
      };
    };

    if (parsed.type === 'match') {
      if (pendingResult) {
        pendingResult.context = currentContext;
        results.push(pendingResult);
        currentContext = [];
      }
      pendingResult = {
        file: relative(vaultPath, parsed.data.path!.text),
        line: parsed.data.line_number!,
        content: parsed.data.lines!.text.trimEnd(),
        context: [],
      };
      currentContext.push(parsed.data.lines!.text.trimEnd());
    } else if (parsed.type === 'context' && pendingResult) {
      currentContext.push(parsed.data.lines!.text.trimEnd());
    }

    if (results.length >= maxResults) break;
  }

  if (pendingResult) {
    pendingResult.context = currentContext;
    results.push(pendingResult);
  }

  return results.slice(0, maxResults);
}

async function searchWithFs(
  vaultPath: string,
  query: string,
  searchPath: string,
  maxResults: number,
  contextLines: number,
): Promise<SearchResult[]> {
  const files = await walkDir(searchPath, ['.md'], true);
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  for (const filePath of files) {
    if (results.length >= maxResults) break;
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) break;
      if (lines[i].toLowerCase().includes(lowerQuery)) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        const context = lines.slice(start, end + 1);
        results.push({
          file: relative(vaultPath, filePath),
          line: i + 1,
          content: lines[i],
          context,
        });
      }
    }
  }

  return results;
}

export function createVaultTools(vaultPath: string) {
  const vault = resolve(vaultPath);

  async function read_note(path: string): Promise<string> {
    const filePath = safePath(vault, path);
    try {
      return await readFile(filePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(`Note not found: ${path}`);
      }
      throw err;
    }
  }

  async function write_note(path: string, content: string): Promise<string> {
    const filePath = safePath(vault, path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return `Written: ${path}`;
  }

  async function edit_note(path: string, oldString: string, newString: string): Promise<string> {
    const filePath = safePath(vault, path);
    const content = await readFile(filePath, 'utf-8');
    if (!content.includes(oldString)) {
      throw new Error(`String not found in ${path}: "${oldString}"`);
    }
    const updated = content.replace(oldString, newString);
    await writeFile(filePath, updated, 'utf-8');
    return `Edited: ${path}`;
  }

  async function append_to_note(path: string, content: string): Promise<string> {
    const filePath = safePath(vault, path);
    let existing = '';
    try {
      existing = await readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await mkdir(dirname(filePath), { recursive: true });
    }
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await writeFile(filePath, existing + separator + content, 'utf-8');
    return `Appended to: ${path}`;
  }

  async function prepend_to_note(path: string, content: string): Promise<string> {
    const filePath = safePath(vault, path);
    let existing = '';
    try {
      existing = await readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await mkdir(dirname(filePath), { recursive: true });
    }

    // Check for YAML frontmatter
    if (existing.startsWith('---\n')) {
      const endIndex = existing.indexOf('\n---\n', 4);
      if (endIndex !== -1) {
        const afterFrontmatter = endIndex + 5; // length of '\n---\n'
        const before = existing.slice(0, afterFrontmatter);
        const after = existing.slice(afterFrontmatter);
        await writeFile(filePath, before + content + '\n' + after, 'utf-8');
        return `Prepended after frontmatter: ${path}`;
      }
    }

    await writeFile(filePath, content + '\n' + existing, 'utf-8');
    return `Prepended to: ${path}`;
  }

  async function search_vault(
    query: string,
    options?: { path?: string; maxResults?: number; context?: number },
  ): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? 20;
    const contextLines = options?.context ?? 2;
    const searchPath = options?.path ? safePath(vault, options.path) : vault;

    try {
      return await searchWithRipgrep(vault, query, searchPath, maxResults, contextLines);
    } catch {
      return await searchWithFs(vault, query, searchPath, maxResults, contextLines);
    }
  }

  async function list_notes(
    dir?: string,
    options?: { recursive?: boolean; extensions?: string[] },
  ): Promise<string[]> {
    const targetDir = dir ? safePath(vault, dir) : vault;
    const extensions = (options?.extensions ?? ['.md']).map((e) =>
      e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`,
    );
    const recursive = options?.recursive ?? false;

    const files = await walkDir(targetDir, extensions, recursive);
    return files.map((f) => relative(vault, f)).sort();
  }

  async function get_tasks(
    options?: { path?: string; includeCompleted?: boolean },
  ): Promise<Task[]> {
    const searchDir = options?.path ? safePath(vault, options.path) : vault;
    const includeCompleted = options?.includeCompleted ?? false;
    const files = await walkDir(searchDir, ['.md'], true);
    const tasks: Task[] = [];
    const taskPattern = /^(\s*)-\s+\[([ x>])\]\s+(.+)$/;

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const match = taskPattern.exec(lines[i]);
        if (match) {
          const marker = match[2];
          const done = marker === 'x' || marker === '>';
          if (!done || includeCompleted) {
            tasks.push({
              text: match[3],
              done,
              file: relative(vault, filePath),
              line: i + 1,
            });
          }
        }
      }
    }

    return tasks;
  }

  async function get_daily_note(date?: string): Promise<string> {
    const dateStr = todaySaoPaulo(date);
    const notePath = `Daily/${dateStr}.md`;
    const filePath = safePath(vault, notePath);

    if (await fileExists(filePath)) {
      return await readFile(filePath, 'utf-8');
    }

    // Create from template
    const templatePath = safePath(vault, 'System/Templates/Daily.md');
    let content: string;
    try {
      const template = await readFile(templatePath, 'utf-8');
      content = template.replace(/\{\{date\}\}/g, dateStr);
    } catch {
      content = `# ${dateStr}\n`;
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return content;
  }

  return {
    read_note,
    write_note,
    edit_note,
    append_to_note,
    prepend_to_note,
    search_vault,
    list_notes,
    get_tasks,
    get_daily_note,
  };
}

export const vaultToolSchemas = [
  {
    name: 'read_note',
    description: 'Read a note from the Obsidian vault by relative path.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the note within the vault.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_note',
    description: 'Create or overwrite a note in the Obsidian vault. Creates parent directories if needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the note within the vault.' },
        content: { type: 'string', description: 'The full content to write to the note.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_note',
    description: 'Find and replace a string within a note. Fails if the old string is not found.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the note within the vault.' },
        oldString: { type: 'string', description: 'The exact string to find in the note.' },
        newString: { type: 'string', description: 'The string to replace it with.' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'append_to_note',
    description: 'Append text to the end of a note. Creates the file if it does not exist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the note within the vault.' },
        content: { type: 'string', description: 'The text to append.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'prepend_to_note',
    description: 'Insert text at the beginning of a note, after YAML frontmatter if present.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the note within the vault.' },
        content: { type: 'string', description: 'The text to prepend.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'search_vault',
    description: 'Full-text search across the Obsidian vault using ripgrep (with filesystem fallback).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query string.' },
        options: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Subdirectory to search within.' },
            maxResults: { type: 'number', description: 'Maximum results to return (default 20).' },
            context: { type: 'number', description: 'Number of context lines around matches (default 2).' },
          },
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_notes',
    description: 'List markdown files in a vault directory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dir: { type: 'string', description: 'Subdirectory to list (default: vault root).' },
        options: {
          type: 'object',
          properties: {
            recursive: { type: 'boolean', description: 'Whether to recurse into subdirectories.' },
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description: 'File extensions to include (default: [".md"]).',
            },
          },
        },
      },
    },
  },
  {
    name: 'get_tasks',
    description: 'Parse task items (- [ ], - [x], - [>]) across the vault.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        options: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Subdirectory to search for tasks.' },
            includeCompleted: { type: 'boolean', description: 'Include completed/deferred tasks (default false).' },
          },
        },
      },
    },
  },
  {
    name: 'get_daily_note',
    description: 'Read today\'s daily note (Daily/YYYY-MM-DD.md). Creates from template if missing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (defaults to today in America/Sao_Paulo).' },
      },
    },
  },
];
