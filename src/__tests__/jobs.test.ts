import { vi } from 'vitest';
import type { DatabaseService } from '../core/database.js';
import type { JobDefinition } from '../types/index.js';
import type { ChannelGateway } from '../channels/gateway.js';

// Mock node-cron so start()/stop() don't set up real timers
vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(() => ({ stop: vi.fn() })),
  },
}));

import { JobRegistry } from '../jobs/registry.js';

const mockChannelGateway = {
  notify: vi.fn().mockResolvedValue(undefined),
  notifyTarget: vi.fn().mockResolvedValue(undefined),
} as unknown as ChannelGateway;

const mockDb = {
  startJobRun: vi.fn().mockReturnValue(1),
  finishJobRun: vi.fn(),
  getConsecutiveFailures: vi.fn().mockReturnValue(0),
  getCommunicationChannels: vi.fn().mockReturnValue([{ id: 'ch-1', enabled: true }]),
} as unknown as DatabaseService;

function makeJob(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    name: 'test-job',
    schedule: '0 9 * * *',
    handler: vi.fn().mockResolvedValue('Job output'),
    channel: 'telegram',
    enabled: true,
    ...overrides,
  };
}

describe('JobRegistry', () => {
  let registry: JobRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new JobRegistry(mockDb);
    registry.setChannelGateway(mockChannelGateway);
  });

  it('registers and lists jobs', () => {
    const job1 = makeJob({ name: 'job-a' });
    const job2 = makeJob({ name: 'job-b' });

    registry.register(job1);
    registry.register(job2);

    const listed = registry.list();
    expect(listed).toHaveLength(2);
    expect(listed.map((j) => j.name)).toEqual(['job-a', 'job-b']);
  });

  it('runNow() executes handler and sends output via channel gateway', async () => {
    const job = makeJob();
    registry.register(job);

    const output = await registry.runNow('test-job');

    expect(job.handler).toHaveBeenCalledOnce();
    expect(output).toBe('Job output');
    expect(mockChannelGateway.notify).toHaveBeenCalledWith(
      ['ch-1'],
      { body: 'Job output' },
    );
  });

  it('runNow() logs success to database', async () => {
    const job = makeJob();
    registry.register(job);

    await registry.runNow('test-job');

    expect(mockDb.startJobRun).toHaveBeenCalledWith('test-job');
    expect(mockDb.finishJobRun).toHaveBeenCalledWith(1, 'success', 'Job output');
  });

  it('failed job sends error notification', async () => {
    const job = makeJob({
      handler: vi.fn().mockRejectedValue(new Error('boom')),
    });
    registry.register(job);

    await expect(registry.runNow('test-job')).rejects.toThrow('boom');

    expect(mockDb.finishJobRun).toHaveBeenCalledWith(
      1,
      'error',
      undefined,
      'boom',
    );
    expect(mockChannelGateway.notify).toHaveBeenCalledWith(
      ['ch-1'],
      expect.objectContaining({ body: expect.stringContaining('boom') }),
    );
  });

  it('auto-disables job after 3 consecutive failures', async () => {
    (mockDb.getConsecutiveFailures as ReturnType<typeof vi.fn>).mockReturnValue(3);

    const job = makeJob({
      handler: vi.fn().mockRejectedValue(new Error('persistent error')),
    });
    registry.register(job);

    await expect(registry.runNow('test-job')).rejects.toThrow('persistent error');

    // Job should be disabled
    const listed = registry.list();
    expect(listed[0].enabled).toBe(false);

    // Should have sent the disable notification
    expect(mockChannelGateway.notify).toHaveBeenCalledWith(
      ['ch-1'],
      expect.objectContaining({ body: expect.stringContaining('disabled') }),
    );
  });

  it('runNow() throws for unknown job', async () => {
    await expect(registry.runNow('nonexistent')).rejects.toThrow(
      'Job not found: nonexistent',
    );
  });
});
