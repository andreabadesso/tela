import type { TelegramService } from '../services/telegram.js';
import type { createVaultTools } from '../tools/vault.js';
import type { CtoAgent } from '../agent.js';

export async function handlePrep(
  text: string,
  messageId: number,
  telegram: TelegramService,
  vault: ReturnType<typeof createVaultTools>,
  agent: CtoAgent,
): Promise<void> {
  const name = text.trim();

  if (!name) {
    await telegram.send('Uso: /prep <nome>\nExemplo: /prep João', { replyTo: messageId });
    return;
  }

  // Search for person file
  const notes = await vault.list_notes('Work/Pessoas', { recursive: true });
  const match = notes.find((n) =>
    n.toLowerCase().includes(name.toLowerCase()),
  );

  let personContent = '';

  if (match) {
    personContent = await vault.read_note(match);
  } else {
    // Fallback: search vault for the name
    const results = await vault.search_vault(name, {
      path: 'Work/Pessoas',
      maxResults: 5,
    });
    if (results.length > 0) {
      personContent = await vault.read_note(results[0].file);
    }
  }

  if (!personContent) {
    await telegram.send(`Não encontrei arquivo para "${name}" em Pessoas/.`, { replyTo: messageId });
    return;
  }

  // Generate prep sheet with Claude
  const result = await agent.process({
    text: `Person file contents:\n\n${personContent}`,
    source: 'telegram',
  }, `Generate a prep sheet for a conversation with ${name} based on their file.
Include: recent topics, open items, suggested questions, any flags.
Keep it concise. Portuguese.`);

  const msg = `📋 <b>Prep — ${name}</b>\n\n${result.text}`;
  if (msg.length > 4000) {
    await telegram.send(result.text.slice(0, 3900) + '\n\n<i>(truncado)</i>', { replyTo: messageId, parseMode: 'HTML' });
  } else {
    await telegram.send(msg, { replyTo: messageId, parseMode: 'HTML' });
  }
}
