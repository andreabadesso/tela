import simpleGit, { SimpleGit, StatusResult } from 'simple-git';

const BATCH_DELAY_MS = 5_000;

export class GitSync {
  private git: SimpleGit | null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastSyncTime: Date | null = null;
  private _lastConflictFiles: string[] = [];

  constructor(repoPath: string, enabled = true) {
    this.git = enabled ? simpleGit(repoPath) : null;
    if (!enabled) {
      console.log('[git] Git sync disabled (no GIT_REMOTE_URL configured).');
    }
  }

  /**
   * Pull latest changes. Returns true if successful, false on conflict.
   * On conflict, aborts the merge and stores the conflicting file list.
   */
  async pull(): Promise<boolean> {
    if (!this.git) return true;
    try {
      await this.git.pull();
      this._lastSyncTime = new Date();
      return true;
    } catch (error) {
      // Check if this is a merge conflict
      try {
        const status = await this.git.status();
        const conflicted = status.conflicted;

        if (conflicted.length > 0) {
          this._lastConflictFiles = [...conflicted];
          await this.git.merge(['--abort']);
          console.error(
            `Git pull conflict in files: ${conflicted.join(', ')}`,
          );
          return false;
        }
      } catch {
        // merge --abort or status failed — fall through to generic error
      }

      console.error('Git pull failed:', error);
      return false;
    }
  }

  /**
   * Stage all changes, commit, and push.
   * If no message is provided, one is auto-generated from the changed files.
   */
  async commitAndPush(message?: string): Promise<void> {
    if (!this.git) return;
    try {
      const status = await this.git.status();

      const changedFiles = [
        ...status.not_added,
        ...status.created,
        ...status.deleted,
        ...status.modified,
        ...status.renamed.map((r) => r.to),
      ];

      if (changedFiles.length === 0) {
        return;
      }

      await this.git.add('.');

      const commitMessage =
        message ?? this.generateCommitMessage(changedFiles);
      await this.git.commit(commitMessage);
      await this.git.push();

      this._lastSyncTime = new Date();
    } catch (error) {
      console.error('Git commit and push failed:', error);
    }
  }

  /**
   * Check if there are uncommitted changes.
   */
  async hasChanges(): Promise<boolean> {
    if (!this.git) return false;
    try {
      const status = await this.git.status();
      return !status.isClean();
    } catch (error) {
      console.error('Git status check failed:', error);
      return false;
    }
  }

  /**
   * Get current git status.
   */
  async status(): Promise<StatusResult | null> {
    if (!this.git) return null;
    return this.git.status();
  }

  /**
   * Write batching: mark that a write happened.
   * After 5 seconds of no new writes, auto-triggers commitAndPush.
   */
  markDirty(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
    }

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.commitAndPush();
    }, BATCH_DELAY_MS);
  }

  /**
   * Force flush: commitAndPush now (used at end of agent turn).
   */
  async flush(): Promise<void> {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    await this.commitAndPush();
  }

  /**
   * Get timestamp of last sync for health checks.
   */
  get lastSyncTime(): Date | null {
    return this._lastSyncTime;
  }

  /**
   * Get the list of files that conflicted during the last failed pull.
   */
  get lastConflictFiles(): string[] {
    return this._lastConflictFiles;
  }

  /**
   * Generate a commit message from the list of changed files.
   */
  private generateCommitMessage(files: string[]): string {
    const MAX_FILES_IN_MESSAGE = 5;

    const listed = files.slice(0, MAX_FILES_IN_MESSAGE).join(', ');
    const suffix =
      files.length > MAX_FILES_IN_MESSAGE
        ? ` (+${files.length - MAX_FILES_IN_MESSAGE} more)`
        : '';

    return `vault: update ${listed}${suffix}`;
  }
}
