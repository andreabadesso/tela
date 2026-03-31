import type { TelegramService } from '../services/telegram.js';
import type { CtoAgent } from '../agent.js';
import type { createVaultTools } from '../tools/vault.js';
import type { GitSync } from '../services/git.js';
import type { ShipLensService } from '../services/shiplens.js';
import type { JiraService } from '../services/jira.js';
import type { GitHubService } from '../services/github.js';
import { handleTodo } from './todo.js';
import { handleSearch } from './search.js';
import { handleRemember } from './remember.js';
import { handlePrep } from './prep.js';
import { handleRead } from './read.js';
import { handleStatus } from './status.js';
import { registerEngineeringCommands } from './engineering.js';

export interface CommandDependencies {
  telegram: TelegramService;
  agent: CtoAgent;
  vault: ReturnType<typeof createVaultTools>;
  gitSync: GitSync;
  shiplens: ShipLensService | null;
  jira: JiraService | null;
  github: GitHubService | null;
}

export function registerCommands(deps: CommandDependencies): void {
  const { telegram, agent, vault, gitSync, shiplens, jira, github } = deps;

  // Phase 1 commands
  telegram.onCommand('todo', (text, msgId) => handleTodo(text, msgId, telegram, vault, gitSync));
  telegram.onCommand('search', (text, msgId) => handleSearch(text, msgId, telegram, vault));
  telegram.onCommand('remember', (text, msgId) => handleRemember(text, msgId, telegram, vault, gitSync));
  telegram.onCommand('prep', (text, msgId) => handlePrep(text, msgId, telegram, vault, agent));
  telegram.onCommand('read', (text, msgId) => handleRead(text, msgId, telegram, vault));
  telegram.onCommand('status', (text, msgId) => handleStatus(text, msgId, telegram, gitSync));

  // Phase 3 engineering commands
  registerEngineeringCommands(telegram, agent, vault, gitSync, shiplens, jira, github);
}
