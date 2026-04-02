import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config module to avoid env var validation at import time
vi.mock('../config/env.js', () => ({
  config: {
    telegramBotToken: 'test:token',
    telegramChatId: '123',
    vaultPath: '/tmp/test-vault',
    gitRemoteUrl: 'git@github.com:test/vault.git',
    timezone: 'America/Sao_Paulo',
    nodeEnv: 'test',
    agentMemoryEnabled: false,
  },
}));

// Mock external dependencies before any imports
const mockGit = {
  pull: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue(undefined),
  push: vi.fn().mockResolvedValue(undefined),
  status: vi.fn().mockResolvedValue({
    files: [],
    not_added: [],
    created: [],
    deleted: [],
    modified: [],
    renamed: [],
    conflicted: [],
    isClean: () => true,
  }),
  merge: vi.fn().mockResolvedValue(undefined),
};

vi.mock('simple-git', () => ({
  default: () => mockGit,
}));

// Mock claude-agent-sdk query to avoid real API calls
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: vi.fn().mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { result: 'Mocked response from Claude' };
      },
    })),
  };
});

import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../core/database.js';
import { GitSync } from '../core/git.js';
import { createVaultTools } from '../tools/vault.js';
import { AgentService } from '../agent/service.js';

describe('Integration: message processing flow', () => {
  let tempDir: string;
  let db: DatabaseService;
  let gitSync: GitSync;
  let agentService: AgentService;
  let defaultAgentId: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = await mkdtemp(join(tmpdir(), 'agent-int-'));
    const dbPath = join(tempDir, 'test.db');
    await mkdir(join(tempDir, 'Daily'), { recursive: true });

    db = new DatabaseService(dbPath);
    gitSync = new GitSync(tempDir);
    const vault = createVaultTools(tempDir);
    agentService = new AgentService(db, vault, gitSync);

    // Use the default seeded agent
    defaultAgentId = db.getAgents().find((a) => a.enabled)?.id ?? 'default';
  });

  it('processes a message through the agent', async () => {
    const response = await agentService.process(defaultAgentId, {
      text: 'Hello, test message',
      source: 'telegram',
    });

    expect(response.text).toBe('Mocked response from Claude');

    // Verify git pull was called (pre-read sync)
    expect(mockGit.pull).toHaveBeenCalled();

    // Verify conversation was logged
    const history = db.getRecentConversations('telegram', 1);
    expect(history).toHaveLength(1);
    expect(history[0].input).toBe('Hello, test message');
    expect(history[0].output).toBe('Mocked response from Claude');
  });

  it('logs conversation with timing data', async () => {
    await agentService.process(defaultAgentId, {
      text: 'Test timing',
      source: 'telegram',
    });

    const history = db.getRecentConversations('telegram', 1);
    expect(history[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('handles cron source input', async () => {
    const response = await agentService.process(defaultAgentId, {
      text: 'Morning briefing data',
      source: 'cron',
    });

    expect(response.text).toBe('Mocked response from Claude');

    const history = db.getRecentConversations('cron', 1);
    expect(history).toHaveLength(1);
    expect(history[0].source).toBe('cron');
  });
});
