import type { TelegramService } from '../services/telegram.js';
import type { createVaultTools } from '../tools/vault.js';

export async function handleSearch(
  text: string,
  messageId: number,
  telegram: TelegramService,
  vault: ReturnType<typeof createVaultTools>,
): Promise<void> {
  const arg = text.trim();

  if (!arg) {
    await telegram.send('Uso: /search <query>\nExemplo: /search roadmap', { replyTo: messageId });
    return;
  }

  // Parse optional path filter: "path:Work/ deploy"
  let searchPath: string | undefined;
  let query = arg;

  const pathMatch = arg.match(/^path:(\S+)\s+(.+)/);
  if (pathMatch) {
    searchPath = pathMatch[1];
    query = pathMatch[2];
  }

  const results = await vault.search_vault(query, {
    path: searchPath,
    maxResults: 10,
    context: 1,
  });

  if (results.length === 0) {
    await telegram.send(`Nenhum resultado para "${query}".`, { replyTo: messageId });
    return;
  }

  const output = results
    .map((r) => `<b>${r.file}:${r.line}</b>\n<code>${escapeHtml(r.content)}</code>`)
    .join('\n\n');

  const header = results.length >= 10
    ? `🔍 Mostrando 10 de possivelmente mais resultados:\n\n`
    : `🔍 ${results.length} resultado(s):\n\n`;

  const msg = header + output;
  if (msg.length > 4000) {
    await telegram.send(`🔍 ${results.length} resultados encontrados (output muito longo, mostrando resumo).`, { replyTo: messageId });
  } else {
    await telegram.send(msg, { replyTo: messageId, parseMode: 'HTML' });
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
