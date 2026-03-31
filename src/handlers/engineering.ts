import type { TelegramService } from '../services/telegram.js';
import type { CtoAgent } from '../agent.js';
import type { createVaultTools } from '../tools/vault.js';
import type { GitSync } from '../services/git.js';
import type { ShipLensService } from '../services/shiplens.js';
import type { JiraService } from '../services/jira.js';
import type { GitHubService } from '../services/github.js';

export function registerEngineeringCommands(
  telegram: TelegramService,
  agent: CtoAgent,
  vault: ReturnType<typeof createVaultTools>,
  gitSync: GitSync,
  shiplens: ShipLensService | null,
  jira: JiraService | null,
  github: GitHubService | null,
): void {
  // /metrics — DORA metrics
  telegram.onCommand('metrics', async (_text, messageId) => {
    const sections: string[] = ['📊 <b>Engineering Metrics</b>'];

    if (shiplens?.isConnected()) {
      try {
        const dora = await shiplens.doraLatest();
        sections.push(JSON.stringify(dora, null, 2));
      } catch (err) {
        sections.push('ShipLens: unavailable');
        console.error('[/metrics] ShipLens error:', err);
      }
    }

    if (sections.length <= 1) {
      await telegram.send('Métricas não disponíveis — integrações não configuradas.', { replyTo: messageId });
      return;
    }

    // Process with Claude for formatting
    const result = await agent.process({
      text: sections.join('\n\n'),
      source: 'telegram',
    }, `Format these engineering metrics for Telegram.
Show DORA metrics with trend arrows (↑ ↓ →).
Compare vs baseline if available. Portuguese. HTML format.`);

    await telegram.send(result.text, { replyTo: messageId, parseMode: 'HTML' });
  });

  // /blocked — all blockers
  telegram.onCommand('blocked', async (_text, messageId) => {
    const blockers: string[] = [];

    if (jira?.isConfigured()) {
      try {
        const tickets = await jira.getBlockedTickets();
        if (tickets.length > 0) {
          blockers.push(`<b>🎫 Jira (${tickets.length})</b>`);
          for (const t of tickets.slice(0, 5)) {
            blockers.push(`  • <b>${t.key}</b>: ${t.summary}${t.assignee ? ` (${t.assignee})` : ''}`);
          }
        }
      } catch (err) {
        console.error('[/blocked] Jira error:', err);
      }
    }

    if (github?.isConfigured()) {
      try {
        const prs = await github.getOpenPRs();
        const stale = prs.filter((pr) => pr.daysOpen > 2 && pr.reviewStatus === 'pending');
        if (stale.length > 0) {
          blockers.push(`<b>🔀 Stale PRs (${stale.length})</b>`);
          for (const pr of stale.slice(0, 5)) {
            blockers.push(`  • ${pr.title} — ${pr.author} (${pr.daysOpen}d)`);
          }
        }
      } catch (err) {
        console.error('[/blocked] GitHub error:', err);
      }
    }

    if (blockers.length === 0) {
      await telegram.send('✅ Nenhum blocker encontrado.', { replyTo: messageId });
      return;
    }

    await telegram.send(`🚫 <b>Blockers</b>\n\n${blockers.join('\n')}`, { replyTo: messageId, parseMode: 'HTML' });
  });

  // /decision [topic] — structured decision framework
  telegram.onCommand('decision', async (text, messageId) => {
    const topic = text.trim();
    if (!topic) {
      await telegram.send('Uso: /decision <tópico>\nExemplo: /decision migração para Kubernetes', { replyTo: messageId });
      return;
    }

    const result = await agent.process({
      text: `Decision topic: ${topic}`,
      source: 'telegram',
    }, `The user wants to make a structured decision about: "${topic}"

Ask clarifying questions to understand:
1. What are the options?
2. What are the constraints?
3. What's the timeline?

Then generate a decision record with: options, tradeoffs, recommendation.
Portuguese.`);

    await telegram.send(result.text, { replyTo: messageId });
  });
}
