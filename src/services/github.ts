import { Octokit } from '@octokit/rest';
import { config } from '../config/env.js';

interface PullRequest {
  number: number;
  title: string;
  author: string;
  repo: string;
  createdAt: string;
  updatedAt: string;
  lastActivity: string;
  reviewStatus: 'approved' | 'changes_requested' | 'pending' | 'no_reviews';
  ciStatus: 'success' | 'failure' | 'pending' | 'unknown';
  labels: string[];
  url: string;
  additions: number;
  deletions: number;
  daysOpen: number;
}

interface Deployment {
  id: number;
  repo: string;
  environment: string;
  ref: string;
  status: string;
  createdAt: string;
  creator: string;
}

interface Incident {
  number: number;
  title: string;
  repo: string;
  severity: string | null;
  createdAt: string;
  assignees: string[];
  status: string;
  url: string;
}

interface CIStatus {
  repo: string;
  branch: string;
  status: 'success' | 'failure' | 'pending' | 'unknown';
  lastRun: string;
  url: string | null;
}

export class GitHubService {
  private octokit: Octokit;
  private org: string;
  private repos: string[];
  private rateLimitRemaining = Infinity;

  constructor() {
    if (!config.githubToken || !config.githubOrg || !config.githubRepos) {
      throw new Error(
        'GitHub integration requires GITHUB_TOKEN, GITHUB_ORG, and GITHUB_REPOS to be configured',
      );
    }

    this.octokit = new Octokit({ auth: config.githubToken });
    this.org = config.githubOrg;
    this.repos = config.githubRepos
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }

  isConfigured(): boolean {
    return !!(config.githubToken && config.githubOrg && config.githubRepos);
  }

  async getOpenPRs(repo?: string): Promise<PullRequest[]> {
    const repos = repo ? [repo] : this.getRepos();
    const results: PullRequest[] = [];

    for (const repoName of repos) {
      try {
        const { data: prs, headers } = await this.octokit.pulls.list({
          owner: this.org,
          repo: repoName,
          state: 'open',
          sort: 'updated',
          direction: 'desc',
          per_page: 100,
        });
        this.trackRateLimit(headers);

        for (const pr of prs) {
          if (!this.hasRateBudget()) break;

          // Fetch full PR details for additions/deletions (not available in list response)
          const { data: prDetail, headers: detailHeaders } = await this.octokit.pulls.get({
            owner: this.org,
            repo: repoName,
            pull_number: pr.number,
          });
          this.trackRateLimit(detailHeaders);

          const [reviewStatus, ciStatus] = await Promise.all([
            this.getReviewStatus(repoName, pr.number),
            this.getCheckStatus(repoName, pr.head.sha),
          ]);

          const now = Date.now();
          const createdAt = new Date(pr.created_at).getTime();
          const daysOpen = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));

          results.push({
            number: pr.number,
            title: pr.title,
            author: pr.user?.login ?? 'unknown',
            repo: repoName,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            lastActivity: pr.updated_at,
            reviewStatus,
            ciStatus,
            labels: pr.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
            url: pr.html_url,
            additions: prDetail.additions ?? 0,
            deletions: prDetail.deletions ?? 0,
            daysOpen,
          });
        }
      } catch (error) {
        console.error(`Failed to fetch PRs for ${repoName}:`, error);
      }
    }

    return results;
  }

  async getPRDetails(repo: string, number: number): Promise<PullRequest> {
    const { data: pr, headers } = await this.octokit.pulls.get({
      owner: this.org,
      repo,
      pull_number: number,
    });
    this.trackRateLimit(headers);

    const [reviewStatus, ciStatus] = await Promise.all([
      this.getReviewStatus(repo, number),
      this.getCheckStatus(repo, pr.head.sha),
    ]);

    const now = Date.now();
    const createdAt = new Date(pr.created_at).getTime();
    const daysOpen = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));

    return {
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? 'unknown',
      repo,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      lastActivity: pr.updated_at,
      reviewStatus,
      ciStatus,
      labels: pr.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
      url: pr.html_url,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      daysOpen,
    };
  }

  async getRecentDeploys(repo?: string, limit = 10): Promise<Deployment[]> {
    const repos = repo ? [repo] : this.getRepos();
    const results: Deployment[] = [];

    for (const repoName of repos) {
      if (!this.hasRateBudget()) break;

      try {
        const { data: deployments, headers } = await this.octokit.repos.listDeployments({
          owner: this.org,
          repo: repoName,
          per_page: limit,
        });
        this.trackRateLimit(headers);

        if (deployments.length > 0) {
          for (const dep of deployments) {
            if (!this.hasRateBudget()) break;

            let status = 'unknown';
            try {
              const { data: statuses, headers: statusHeaders } =
                await this.octokit.repos.listDeploymentStatuses({
                  owner: this.org,
                  repo: repoName,
                  deployment_id: dep.id,
                  per_page: 1,
                });
              this.trackRateLimit(statusHeaders);
              status = statuses[0]?.state ?? 'unknown';
            } catch {
              // status stays 'unknown'
            }

            results.push({
              id: dep.id,
              repo: repoName,
              environment: dep.environment,
              ref: dep.ref,
              status,
              createdAt: dep.created_at,
              creator: dep.creator?.login ?? 'unknown',
            });
          }
        } else {
          // Fall back to releases when no deployments exist
          const releases = await this.getReleasesAsDeploys(repoName, limit);
          results.push(...releases);
        }
      } catch (error) {
        console.error(`Failed to fetch deployments for ${repoName}:`, error);
      }
    }

    return results
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  async getIncidents(): Promise<Incident[]> {
    const repos = this.getRepos();
    const results: Incident[] = [];

    for (const repoName of repos) {
      if (!this.hasRateBudget()) break;

      try {
        const { data: issues, headers } = await this.octokit.issues.listForRepo({
          owner: this.org,
          repo: repoName,
          state: 'open',
          labels: 'incident',
          per_page: 100,
        });
        this.trackRateLimit(headers);

        for (const issue of issues) {
          const severityLabel = issue.labels.find((l) => {
            const name = typeof l === 'string' ? l : l.name ?? '';
            return name.startsWith('severity:') || name.startsWith('sev');
          });
          const severity =
            severityLabel == null
              ? null
              : typeof severityLabel === 'string'
                ? severityLabel
                : (severityLabel.name ?? null);

          results.push({
            number: issue.number,
            title: issue.title,
            repo: repoName,
            severity,
            createdAt: issue.created_at,
            assignees: issue.assignees?.map((a) => a.login) ?? [],
            status: issue.state ?? 'open',
            url: issue.html_url,
          });
        }
      } catch (error) {
        console.error(`Failed to fetch incidents for ${repoName}:`, error);
      }
    }

    return results;
  }

  async getCIStatus(repo?: string): Promise<CIStatus[]> {
    const repos = repo ? [repo] : this.getRepos();
    const results: CIStatus[] = [];

    for (const repoName of repos) {
      if (!this.hasRateBudget()) break;

      try {
        // Get the default branch
        const { data: repoData, headers: repoHeaders } = await this.octokit.repos.get({
          owner: this.org,
          repo: repoName,
        });
        this.trackRateLimit(repoHeaders);

        const defaultBranch = repoData.default_branch;

        // Get latest check suites for the default branch
        const { data: checkSuites, headers: checkHeaders } =
          await this.octokit.checks.listSuitesForRef({
            owner: this.org,
            repo: repoName,
            ref: defaultBranch,
            per_page: 10,
          });
        this.trackRateLimit(checkHeaders);

        if (checkSuites.check_suites.length === 0) {
          results.push({
            repo: repoName,
            branch: defaultBranch,
            status: 'unknown',
            lastRun: '',
            url: null,
          });
          continue;
        }

        // Use the most recent check suite
        const latest = checkSuites.check_suites[0];
        const status = this.mapCheckConclusion(latest.conclusion ?? null, latest.status ?? null);

        results.push({
          repo: repoName,
          branch: defaultBranch,
          status,
          lastRun: latest.created_at ?? '',
          url: `https://github.com/${this.org}/${repoName}/actions`,
        });
      } catch (error) {
        console.error(`Failed to fetch CI status for ${repoName}:`, error);
      }
    }

    return results;
  }

  private getRepos(): string[] {
    return this.repos;
  }

  private async getReviewStatus(
    repo: string,
    prNumber: number,
  ): Promise<PullRequest['reviewStatus']> {
    try {
      const { data: reviews, headers } = await this.octokit.pulls.listReviews({
        owner: this.org,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      this.trackRateLimit(headers);

      if (reviews.length === 0) return 'no_reviews';

      // Collect the latest review per reviewer
      const latestByUser = new Map<string, string>();
      for (const review of reviews) {
        if (review.state === 'COMMENTED') continue;
        const user = review.user?.login ?? 'unknown';
        latestByUser.set(user, review.state);
      }

      if (latestByUser.size === 0) return 'no_reviews';

      const states = Array.from(latestByUser.values());
      if (states.some((s) => s === 'CHANGES_REQUESTED')) return 'changes_requested';
      if (states.some((s) => s === 'APPROVED')) return 'approved';
      return 'pending';
    } catch {
      return 'pending';
    }
  }

  private async getCheckStatus(
    repo: string,
    ref: string,
  ): Promise<PullRequest['ciStatus']> {
    try {
      const { data, headers } = await this.octokit.checks.listForRef({
        owner: this.org,
        repo,
        ref,
        per_page: 100,
      });
      this.trackRateLimit(headers);

      if (data.check_runs.length === 0) return 'unknown';

      const hasFailure = data.check_runs.some(
        (r) => r.conclusion === 'failure' || r.conclusion === 'timed_out',
      );
      if (hasFailure) return 'failure';

      const allComplete = data.check_runs.every((r) => r.status === 'completed');
      if (!allComplete) return 'pending';

      const allSuccess = data.check_runs.every(
        (r) => r.conclusion === 'success' || r.conclusion === 'skipped' || r.conclusion === 'neutral',
      );
      return allSuccess ? 'success' : 'failure';
    } catch {
      return 'unknown';
    }
  }

  private async getReleasesAsDeploys(repo: string, limit: number): Promise<Deployment[]> {
    try {
      const { data: releases, headers } = await this.octokit.repos.listReleases({
        owner: this.org,
        repo,
        per_page: limit,
      });
      this.trackRateLimit(headers);

      return releases.map((rel) => ({
        id: rel.id,
        repo,
        environment: 'release',
        ref: rel.tag_name,
        status: rel.draft ? 'draft' : rel.prerelease ? 'prerelease' : 'published',
        createdAt: rel.created_at,
        creator: rel.author?.login ?? 'unknown',
      }));
    } catch {
      return [];
    }
  }

  private mapCheckConclusion(
    conclusion: string | null,
    status: string | null,
  ): CIStatus['status'] {
    if (status === 'queued' || status === 'in_progress') return 'pending';
    switch (conclusion) {
      case 'success':
      case 'neutral':
      case 'skipped':
        return 'success';
      case 'failure':
      case 'timed_out':
      case 'cancelled':
        return 'failure';
      default:
        return 'unknown';
    }
  }

  private trackRateLimit(headers: Record<string, string | number | undefined>): void {
    const remaining = headers['x-ratelimit-remaining'];
    if (remaining !== undefined) {
      this.rateLimitRemaining = typeof remaining === 'string' ? parseInt(remaining, 10) : remaining;
    }
  }

  private hasRateBudget(): boolean {
    if (this.rateLimitRemaining < 50) {
      console.warn(`GitHub rate limit low: ${this.rateLimitRemaining} requests remaining`);
      return false;
    }
    return true;
  }
}
