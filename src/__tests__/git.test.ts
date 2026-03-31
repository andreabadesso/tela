import { vi } from 'vitest';

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

import { GitSync } from '../services/git.js';

describe('GitSync', () => {
  let gitSync: GitSync;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    gitSync = new GitSync('/tmp/test-repo');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('pull()', () => {
    it('returns true on success and updates lastSyncTime', async () => {
      const before = new Date();

      const result = await gitSync.pull();

      expect(result).toBe(true);
      expect(mockGit.pull).toHaveBeenCalledOnce();
      expect(gitSync.lastSyncTime).toBeInstanceOf(Date);
      expect(gitSync.lastSyncTime!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('returns false on conflict, stores conflicted files, and aborts merge', async () => {
      mockGit.pull.mockRejectedValueOnce(new Error('CONFLICT'));
      mockGit.status.mockResolvedValueOnce({
        files: [],
        not_added: [],
        created: [],
        deleted: [],
        modified: [],
        renamed: [],
        conflicted: ['file-a.md', 'file-b.md'],
        isClean: () => false,
      });

      const result = await gitSync.pull();

      expect(result).toBe(false);
      expect(gitSync.lastConflictFiles).toEqual(['file-a.md', 'file-b.md']);
      expect(mockGit.merge).toHaveBeenCalledWith(['--abort']);
    });
  });

  describe('commitAndPush()', () => {
    it('stages, commits with auto-message, and pushes', async () => {
      mockGit.status.mockResolvedValueOnce({
        files: [{ path: 'notes.md' }],
        not_added: [],
        created: [],
        deleted: [],
        modified: ['notes.md'],
        renamed: [],
        conflicted: [],
        isClean: () => false,
      });

      await gitSync.commitAndPush();

      expect(mockGit.add).toHaveBeenCalledWith('.');
      expect(mockGit.commit).toHaveBeenCalledWith(
        expect.stringContaining('notes.md'),
      );
      expect(mockGit.push).toHaveBeenCalledOnce();
    });

    it('does nothing when there are no changes', async () => {
      // Default mock already returns a clean status
      await gitSync.commitAndPush();

      expect(mockGit.add).not.toHaveBeenCalled();
      expect(mockGit.commit).not.toHaveBeenCalled();
      expect(mockGit.push).not.toHaveBeenCalled();
    });
  });

  describe('hasChanges()', () => {
    it('returns false for a clean repo', async () => {
      const result = await gitSync.hasChanges();

      expect(result).toBe(false);
      expect(mockGit.status).toHaveBeenCalledOnce();
    });
  });

  describe('flush()', () => {
    it('cancels any pending batch timer and commits immediately', async () => {
      // Set up status to show changes so commitAndPush actually does work
      mockGit.status.mockResolvedValue({
        files: [{ path: 'data.md' }],
        not_added: [],
        created: [],
        deleted: [],
        modified: ['data.md'],
        renamed: [],
        conflicted: [],
        isClean: () => false,
      });

      // Start a batch timer
      gitSync.markDirty();

      // Flush immediately — should cancel the timer and commit right away
      await gitSync.flush();

      expect(mockGit.add).toHaveBeenCalledTimes(1);
      expect(mockGit.commit).toHaveBeenCalledTimes(1);
      expect(mockGit.push).toHaveBeenCalledTimes(1);

      // Advance timers past the batch delay — should NOT trigger another commit
      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockGit.add).toHaveBeenCalledTimes(1);
      expect(mockGit.commit).toHaveBeenCalledTimes(1);
      expect(mockGit.push).toHaveBeenCalledTimes(1);
    });
  });
});
