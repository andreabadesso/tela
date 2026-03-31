import type { TelegramService } from '../services/telegram.js';
import type { GitSync } from '../services/git.js';

const startTime = Date.now();

export async function handleStatus(
  _text: string,
  messageId: number,
  telegram: TelegramService,
  gitSync: GitSync,
): Promise<void> {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);

  const lastSync = gitSync.lastSyncTime
    ? gitSync.lastSyncTime.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : 'Nunca';

  const gitStatus = await gitSync.status();
  const hasChanges = gitStatus.files.length > 0;

  const msg = [
    '🤖 <b>Agent Status</b>',
    '',
    `⏱ Uptime: ${hours}h ${minutes}m`,
    `🔄 Último git sync: ${lastSync}`,
    `📝 Mudanças pendentes: ${hasChanges ? 'Sim' : 'Não'}`,
  ].join('\n');

  await telegram.send(msg, { replyTo: messageId, parseMode: 'HTML' });
}
