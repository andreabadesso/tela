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

  // Search the entire vault for files related to this person
  const results = await vault.search_vault(name, { maxResults: 10 });

  let personContent = '';
  for (const result of results) {
    // Prefer files that look like person docs (name in filename)
    if (result.file.toLowerCase().includes(name.toLowerCase())) {
      personContent = await vault.read_note(result.file);
      break;
    }
  }

  // Fallback: use search result content
  if (!personContent && results.length > 0) {
    personContent = results.map((r) => `## ${r.file}\n${r.content}`).join('\n\n');
  }

  if (!personContent) {
    await telegram.send(`Não encontrei nada sobre "${name}" no vault.`, { replyTo: messageId });
    return;
  }

  // Generate prep sheet with Claude
  const result = await agent.process({
    text: `Context found about "${name}":\n\n${personContent}`,
    source: 'telegram',
  }, `Generate a prep sheet for a conversation with ${name} based on the context found in the vault.
Include: recent topics, open items, suggested questions, any flags.
Keep it concise. Portuguese.`);

  const msg = `📋 <b>Prep — ${name}</b>\n\n${result.text}`;
  if (msg.length > 4000) {
    await telegram.send(result.text.slice(0, 3900) + '\n\n<i>(truncado)</i>', { replyTo: messageId, parseMode: 'HTML' });
  } else {
    await telegram.send(msg, { replyTo: messageId, parseMode: 'HTML' });
  }
}
