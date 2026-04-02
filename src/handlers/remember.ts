import type { TelegramService } from '../services/telegram.js';
import type { createVaultTools } from '../tools/vault.js';
import type { GitSync } from '../core/git.js';

export async function handleRemember(
  text: string,
  messageId: number,
  telegram: TelegramService,
  vault: ReturnType<typeof createVaultTools>,
  gitSync: GitSync,
): Promise<void> {
  const arg = text.trim();

  if (!arg) {
    await telegram.send('Uso: /remember <texto>\nExemplo: /remember Verificar se o review foi terminado', { replyTo: messageId });
    return;
  }

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().slice(0, 5).replace(':', '');
  const titleWords = arg.split(' ').slice(0, 5).join(' ');
  const filename = `Inbox/${dateStr} ${timeStr} — ${titleWords}.md`;

  const content = [
    '---',
    `created: ${now.toISOString()}`,
    'type: inbox',
    '---',
    '',
    arg,
  ].join('\n');

  await vault.write_note(filename, content);
  gitSync.markDirty();

  await telegram.send('📥 Salvo no Inbox.', { replyTo: messageId });
}
