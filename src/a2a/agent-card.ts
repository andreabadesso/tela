import type { DatabaseService } from '../core/database.js';
import type { A2AAgentCard, A2AAgentSkill } from './types.js';

/**
 * Generates an A2A Agent Card from the agents table.
 * Each enabled agent becomes a skill in the card.
 */
export function generateAgentCard(db: DatabaseService, baseUrl: string): A2AAgentCard {
  const agents = db.getAgents().filter(a => a.enabled);

  const skills: A2AAgentSkill[] = agents.map(agent => ({
    id: agent.id,
    name: agent.name,
    description: extractDescription(agent.system_prompt),
    tags: extractTags(agent),
  }));

  return {
    name: 'Tela',
    description: 'AI operating system — multi-agent platform powered by Claude',
    url: `${baseUrl}/a2a`,
    version: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: ['apiKey'],
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills,
  };
}

/**
 * Extended card includes more agent details (requires authentication).
 */
export function generateExtendedAgentCard(db: DatabaseService, baseUrl: string): A2AAgentCard & { skillDetails: Record<string, { model: string; maxTurns: number }> } {
  const card = generateAgentCard(db, baseUrl);
  const agents = db.getAgents().filter(a => a.enabled);

  const skillDetails: Record<string, { model: string; maxTurns: number }> = {};
  for (const agent of agents) {
    skillDetails[agent.id] = {
      model: agent.model,
      maxTurns: agent.max_turns,
    };
  }

  return { ...card, skillDetails };
}

/** Extract a one-line description from the system prompt. */
function extractDescription(systemPrompt: string): string {
  const firstLine = systemPrompt.split('\n').find(l => l.trim().length > 0) ?? systemPrompt;
  // Trim to reasonable length
  return firstLine.length > 200 ? firstLine.slice(0, 197) + '...' : firstLine;
}

/** Infer tags from agent config. */
function extractTags(agent: { id: string; name: string; permissions: string }): string[] {
  const tags: string[] = [];
  const name = agent.name.toLowerCase();
  const perms = safeJsonParse(agent.permissions);

  if (name.includes('coding') || name.includes('developer') || perms.runtime === 'devcontainer') {
    tags.push('coding', 'development');
  }
  if (name.includes('cto') || name.includes('engineering')) tags.push('engineering');
  if (name.includes('ceo') || name.includes('leadership')) tags.push('leadership');
  if (name.includes('finance') || name.includes('cfo')) tags.push('finance');

  return tags;
}

function safeJsonParse(json: string): Record<string, unknown> {
  try { return JSON.parse(json); } catch { return {}; }
}
