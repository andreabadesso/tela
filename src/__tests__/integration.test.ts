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

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    use: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue(undefined),
    },
  })),
  InputFile: vi.fn(),
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
import { DatabaseService } from '../services/database.js';
import { GitSync } from '../services/git.js';
import { TelegramService } from '../services/telegram.js';
import { createVaultTools } from '../tools/vault.js';
import { CtoAgent } from '../agent.js';

describe('Integration: message processing flow', () => {
  let tempDir: string;
  let db: DatabaseService;
  let gitSync: GitSync;
  let telegram: TelegramService;
  let agent: CtoAgent;

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = await mkdtemp(join(tmpdir(), 'agent-int-'));
    const dbPath = join(tempDir, 'test.db');
    await mkdir(join(tempDir, 'Daily'), { recursive: true });

    db = new DatabaseService(dbPath);
    gitSync = new GitSync(tempDir);
    telegram = new TelegramService('test:token', '123');
    const vault = createVaultTools(tempDir);
    agent = new CtoAgent(vault, telegram, gitSync, db);
  });

  it('processes a Telegram message through the agent', async () => {
    const response = await agent.process({
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
    await agent.process({
      text: 'Test timing',
      source: 'telegram',
    });

    const history = db.getRecentConversations('telegram', 1);
    expect(history[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('handles cron source input', async () => {
    const response = await agent.process({
      text: 'Morning briefing data',
      source: 'cron',
    });

    expect(response.text).toBe('Mocked response from Claude');

    const history = db.getRecentConversations('cron', 1);
    expect(history).toHaveLength(1);
    expect(history[0].source).toBe('cron');
  });
});
