import type { TelegramService } from '../services/telegram.js';
import type { createVaultTools } from '../tools/vault.js';
import type { GitSync } from '../services/git.js';

export async function handleTodo(
  text: string,
  messageId: number,
  telegram: TelegramService,
  vault: ReturnType<typeof createVaultTools>,
  gitSync: GitSync,
): Promise<void> {
  const arg = text.trim();

  if (!arg) {
    // List today's tasks
    const dailyNote = await vault.get_daily_note();
    const lines = dailyNote.split('\n').filter((l) => /^- \[[ x>]\]/.test(l.trim()));
    if (lines.length === 0) {
      await telegram.send('Nenhuma task no daily note de hoje.', { replyTo: messageId });
      return;
    }
    await telegram.send(lines.join('\n'), { replyTo: messageId });
    return;
  }

  if (arg === 'all') {
    // List all pending tasks across vault
    const tasks = await vault.get_tasks({ includeCompleted: false });
    if (tasks.length === 0) {
      await telegram.send('Nenhuma task pendente no vault.', { replyTo: messageId });
      return;
    }

    // Group by file
    const grouped = new Map<string, string[]>();
    for (const t of tasks) {
      const list = grouped.get(t.file) || [];
      list.push(`- [ ] ${t.text}`);
      grouped.set(t.file, list);
    }

    const output = Array.from(grouped.entries())
      .map(([file, items]) => `<b>${file}</b>\n${items.join('\n')}`)
      .join('\n\n');

    if (output.length > 4000) {
      await telegram.send(`${tasks.length} tasks pendentes (output truncado).`, { replyTo: messageId });
    } else {
      await telegram.send(output, { replyTo: messageId, parseMode: 'HTML' });
    }
    return;
  }

  // Add task to today's daily note
  const today = new Date().toISOString().split('T')[0];
  const dailyPath = `Daily/${today}.md`;

  try {
    const content = await vault.read_note(dailyPath);
    if (content.includes('## Tasks')) {
      // Append under ## Tasks section
      const taskLine = `- [ ] ${arg}`;
      const lines = content.split('\n');
      const taskIdx = lines.findIndex((l) => l.trim() === '## Tasks');
      // Find the end of the tasks section (next ## or end of file)
      let insertIdx = lines.length;
      for (let i = taskIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) {
          insertIdx = i;
          break;
        }
      }
      lines.splice(insertIdx, 0, taskLine);
      await vault.write_note(dailyPath, lines.join('\n'));
    } else {
      await vault.append_to_note(dailyPath, `\n\n## Tasks\n\n- [ ] ${arg}`);
    }
  } catch {
    // Daily note doesn't exist yet, create it
    await vault.get_daily_note();
    await vault.append_to_note(dailyPath, `\n\n## Tasks\n\n- [ ] ${arg}`);
  }

  gitSync.markDirty();
  await telegram.send(`✅ Task adicionada: ${arg}`, { replyTo: messageId });
}
