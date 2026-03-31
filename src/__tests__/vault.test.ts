import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultTools } from '../tools/vault.js';

let vaultPath: string;
let vault: ReturnType<typeof createVaultTools>;

beforeEach(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), 'vault-test-'));
  vault = createVaultTools(vaultPath);
});

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('read_note', () => {
  it('reads an existing file', async () => {
    await writeFile(join(vaultPath, 'hello.md'), 'Hello world', 'utf-8');
    const content = await vault.read_note('hello.md');
    expect(content).toBe('Hello world');
  });

  it('throws for a missing file', async () => {
    await expect(vault.read_note('missing.md')).rejects.toThrow('Note not found: missing.md');
  });
});

describe('write_note', () => {
  it('creates file with content and parent directories', async () => {
    const result = await vault.write_note('deep/nested/note.md', '# Deep note');
    expect(result).toBe('Written: deep/nested/note.md');

    const content = await readFile(join(vaultPath, 'deep/nested/note.md'), 'utf-8');
    expect(content).toBe('# Deep note');
  });
});

describe('edit_note', () => {
  it('replaces text in a note', async () => {
    await writeFile(join(vaultPath, 'edit.md'), 'Hello world', 'utf-8');
    const result = await vault.edit_note('edit.md', 'world', 'universe');
    expect(result).toBe('Edited: edit.md');

    const content = await readFile(join(vaultPath, 'edit.md'), 'utf-8');
    expect(content).toBe('Hello universe');
  });

  it('throws when old text is not found', async () => {
    await writeFile(join(vaultPath, 'edit.md'), 'Hello world', 'utf-8');
    await expect(vault.edit_note('edit.md', 'nonexistent', 'replacement')).rejects.toThrow(
      'String not found in edit.md',
    );
  });
});

describe('append_to_note', () => {
  it('appends to an existing file', async () => {
    await writeFile(join(vaultPath, 'append.md'), 'Line 1', 'utf-8');
    await vault.append_to_note('append.md', 'Line 2');

    const content = await readFile(join(vaultPath, 'append.md'), 'utf-8');
    expect(content).toBe('Line 1\nLine 2');
  });

  it('creates file if missing', async () => {
    const result = await vault.append_to_note('new-append.md', 'First line');
    expect(result).toBe('Appended to: new-append.md');

    const content = await readFile(join(vaultPath, 'new-append.md'), 'utf-8');
    expect(content).toBe('First line');
  });
});

describe('prepend_to_note', () => {
  it('inserts after YAML frontmatter', async () => {
    const original = '---\ntitle: Test\n---\nExisting content';
    await writeFile(join(vaultPath, 'frontmatter.md'), original, 'utf-8');
    await vault.prepend_to_note('frontmatter.md', 'Inserted');

    const content = await readFile(join(vaultPath, 'frontmatter.md'), 'utf-8');
    expect(content).toBe('---\ntitle: Test\n---\nInserted\nExisting content');
  });

  it('inserts at top when no frontmatter', async () => {
    await writeFile(join(vaultPath, 'plain.md'), 'Existing content', 'utf-8');
    await vault.prepend_to_note('plain.md', 'Top line');

    const content = await readFile(join(vaultPath, 'plain.md'), 'utf-8');
    expect(content).toBe('Top line\nExisting content');
  });
});

describe('search_vault', () => {
  it('finds matching content', async () => {
    await writeFile(join(vaultPath, 'searchable.md'), 'The quick brown fox\njumps over the lazy dog', 'utf-8');
    await writeFile(join(vaultPath, 'other.md'), 'Nothing here', 'utf-8');

    const results = await vault.search_vault('quick brown');
    expect(results.length).toBe(1);
    expect(results[0].file).toBe('searchable.md');
    expect(results[0].line).toBe(1);
    expect(results[0].content).toContain('quick brown fox');
  });
});

describe('list_notes', () => {
  it('lists .md files and supports recursive option', async () => {
    await writeFile(join(vaultPath, 'root.md'), '', 'utf-8');
    await writeFile(join(vaultPath, 'ignore.txt'), '', 'utf-8');
    await mkdir(join(vaultPath, 'sub'), { recursive: true });
    await writeFile(join(vaultPath, 'sub', 'nested.md'), '', 'utf-8');

    // Non-recursive: only root level
    const shallow = await vault.list_notes();
    expect(shallow).toEqual(['root.md']);

    // Recursive: includes nested
    const deep = await vault.list_notes(undefined, { recursive: true });
    expect(deep).toContain('root.md');
    expect(deep).toContain(join('sub', 'nested.md'));
    expect(deep).not.toContain('ignore.txt');
  });
});

describe('get_tasks', () => {
  it('parses - [ ], - [x], and - [>] correctly', async () => {
    const content = [
      '- [ ] Open task',
      '- [x] Done task',
      '- [>] Deferred task',
      '- Not a task',
    ].join('\n');
    await writeFile(join(vaultPath, 'tasks.md'), content, 'utf-8');

    // Without completed
    const open = await vault.get_tasks();
    expect(open).toHaveLength(1);
    expect(open[0].text).toBe('Open task');
    expect(open[0].done).toBe(false);
    expect(open[0].file).toBe('tasks.md');
    expect(open[0].line).toBe(1);

    // With completed
    const all = await vault.get_tasks({ includeCompleted: true });
    expect(all).toHaveLength(3);

    const done = all.find((t) => t.text === 'Done task');
    expect(done?.done).toBe(true);

    const deferred = all.find((t) => t.text === 'Deferred task');
    expect(deferred?.done).toBe(true);
  });
});

describe('get_daily_note', () => {
  it('creates note from template when missing', async () => {
    await mkdir(join(vaultPath, 'System/Templates'), { recursive: true });
    await writeFile(
      join(vaultPath, 'System/Templates/Daily.md'),
      '---\ndate: {{date}}\n---\n# {{date}}',
      'utf-8',
    );

    const content = await vault.get_daily_note('2025-06-15');
    expect(content).toBe('---\ndate: 2025-06-15\n---\n# 2025-06-15');

    // Verify the file was actually created
    const onDisk = await readFile(join(vaultPath, 'Daily/2025-06-15.md'), 'utf-8');
    expect(onDisk).toBe(content);
  });
});

describe('path traversal', () => {
  it('rejects path traversal attempts', async () => {
    await expect(vault.read_note('../../etc/passwd')).rejects.toThrow('Path traversal rejected');
  });
});
