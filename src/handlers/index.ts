import type { TelegramService } from '../services/telegram.js';
import type { AgentService } from '../agent/service.js';
import type { createVaultTools } from '../tools/vault.js';
import type { GitSync } from '../core/git.js';
import type { ShipLensService } from '../integrations/shiplens.js';
import type { JiraService } from '../integrations/jira.js';
import type { GitHubService } from '../integrations/github.js';
import { handleTodo } from './todo.js';
import { handleSearch } from './search.js';
import { handleRemember } from './remember.js';
import { handlePrep } from './prep.js';
import { handleRead } from './read.js';
import { handleStatus } from './status.js';
import { registerEngineeringCommands } from './engineering.js';

export interface CommandDependencies {
  telegram: TelegramService;
  agentService: AgentService;
  defaultAgentId: string;
  vault: ReturnType<typeof createVaultTools>;
  gitSync: GitSync;
  shiplens: ShipLensService | null;
  jira: JiraService | null;
  github: GitHubService | null;
}

export function registerCommands(deps: CommandDependencies): void {
  const { telegram, agentService, defaultAgentId, vault, gitSync, shiplens, jira, github } = deps;

  // Phase 1 commands
  telegram.onCommand('todo', (text, msgId) => handleTodo(text, msgId, telegram, vault, gitSync));
  telegram.onCommand('search', (text, msgId) => handleSearch(text, msgId, telegram, vault));
  telegram.onCommand('remember', (text, msgId) => handleRemember(text, msgId, telegram, vault, gitSync));
  telegram.onCommand('prep', (text, msgId) => handlePrep(text, msgId, telegram, vault, agentService, defaultAgentId));
  telegram.onCommand('read', (text, msgId) => handleRead(text, msgId, telegram, vault));
  telegram.onCommand('status', (text, msgId) => handleStatus(text, msgId, telegram, gitSync));

  // Phase 3 engineering commands
  registerEngineeringCommands(telegram, agentService, defaultAgentId, vault, gitSync, shiplens, jira, github);
}
