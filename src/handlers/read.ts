import type { TelegramService } from '../services/telegram.js';
import type { createVaultTools } from '../tools/vault.js';

export async function handleRead(
  text: string,
  messageId: number,
  telegram: TelegramService,
  vault: ReturnType<typeof createVaultTools>,
): Promise<void> {
  const arg = text.trim();

  if (!arg) {
    await telegram.send('Uso: /read <caminho ou termo>\nExemplo: /read Notes/Roadmap.md', { replyTo: messageId });
    return;
  }

  let content: string;

  // If it looks like a file path (contains / or ends in .md)
  if (arg.includes('/') || arg.endsWith('.md')) {
    try {
      content = await vault.read_note(arg);
    } catch {
      await telegram.send(`Arquivo não encontrado: ${arg}`, { replyTo: messageId });
      return;
    }
  } else {
    // Fuzzy search for matching note names
    const allNotes = await vault.list_notes(undefined, { recursive: true });
    const matches = allNotes.filter((n) =>
      n.toLowerCase().includes(arg.toLowerCase()),
    );

    if (matches.length === 0) {
      await telegram.send(`Nenhuma nota encontrada para "${arg}".`, { replyTo: messageId });
      return;
    }

    if (matches.length > 1) {
      const list = matches.slice(0, 10).map((m) => `• ${m}`).join('\n');
      await telegram.send(`Múltiplas notas encontradas:\n${list}\n\nUse o caminho completo.`, { replyTo: messageId });
      return;
    }

    content = await vault.read_note(matches[0]);
  }

  if (content.length > 4000) {
    // Send as file
    const tmpPath = `/tmp/vault-read-${Date.now()}.md`;
    const fs = await import('node:fs/promises');
    await fs.writeFile(tmpPath, content);
    await telegram.sendFile(tmpPath, arg);
    await fs.unlink(tmpPath);
  } else {
    await telegram.send(`<pre>${escapeHtml(content)}</pre>`, { replyTo: messageId, parseMode: 'HTML' });
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
