import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config/env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SprintStatus {
  sprintName: string;
  squad: string;
  state: string;
  startDate: string;
  endDate: string;
  daysRemaining: number;
  totalIssues: number;
  completedIssues: number;
  totalPoints: number;
  completedPoints: number;
}

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  squad: string;
  priority: string;
  created: string;
  updated: string;
  dueDate: string | null;
  labels: string[];
  blockerReason: string | null;
  isBlocked: boolean;
  storyPoints: number | null;
}

export interface VelocityData {
  squad: string;
  sprints: { name: string; completed: number; committed: number }[];
}

// ---------------------------------------------------------------------------
// Internal Jira API response shapes (partial)
// ---------------------------------------------------------------------------

interface JiraIssueFields {
  summary: string;
  status: { name: string };
  assignee: { displayName: string } | null;
  priority: { name: string };
  created: string;
  updated: string;
  duedate: string | null;
  labels: string[];
  flagged?: boolean;
  // story points – the custom field varies per instance; we try common ones
  [key: string]: unknown;
}

interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
  startAt: number;
}

interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
}

interface JiraBoard {
  id: number;
  name: string;
  location?: { projectKey?: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_POINTS_FIELDS = [
  'customfield_10016', // Jira Cloud default
  'customfield_10028',
  'customfield_10002',
  'story_points',
];

const DONE_CATEGORIES = new Set(['Done', 'done', 'Closed', 'closed', 'Resolved', 'resolved']);

const MIN_REQUEST_INTERVAL_MS = 200; // basic self-throttle

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class JiraService {
  private client: AxiosInstance;
  private squadMap: Record<string, string>; // project key -> squad name
  private reverseSquadMap: Record<string, string>; // squad name (lowercase) -> project key
  private lastRequestTime = 0;

  constructor() {
    if (!config.jiraBaseUrl || !config.jiraApiToken || !config.jiraUserEmail) {
      throw new Error(
        'Jira integration requires JIRA_BASE_URL, JIRA_API_TOKEN, and JIRA_USER_EMAIL environment variables.',
      );
    }

    const token = Buffer.from(`${config.jiraUserEmail}:${config.jiraApiToken}`).toString('base64');

    this.client = axios.create({
      baseURL: config.jiraBaseUrl.replace(/\/+$/, ''),
      headers: {
        Authorization: `Basic ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });

    // Intercept 429 responses and retry once after the indicated delay.
    this.client.interceptors.response.use(undefined, async (error: AxiosError) => {
      if (error.response?.status === 429) {
        const retryAfter = Number(error.response.headers['retry-after'] ?? 5);
        const delayMs = retryAfter * 1000;
        await this.sleep(delayMs);
        return this.client.request(error.config!);
      }
      return Promise.reject(error);
    });

    // Parse squad mapping
    this.squadMap = {};
    this.reverseSquadMap = {};
    if (config.jiraSquadMapping) {
      try {
        const parsed: Record<string, string> = JSON.parse(config.jiraSquadMapping);
        for (const [projectKey, squadName] of Object.entries(parsed)) {
          this.squadMap[projectKey.toUpperCase()] = squadName;
          this.reverseSquadMap[squadName.toLowerCase()] = projectKey.toUpperCase();
        }
      } catch {
        throw new Error(
          `Failed to parse JIRA_SQUAD_MAPPING – expected valid JSON, got: ${config.jiraSquadMapping}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Whether the service has all required configuration. */
  isConfigured(): boolean {
    return Boolean(config.jiraBaseUrl && config.jiraApiToken && config.jiraUserEmail);
  }

  /** Get the active sprint status for a squad. */
  async getSprintStatus(squad: string): Promise<SprintStatus> {
    const projectKey = this.resolveSquad(squad);
    const board = await this.findBoard(projectKey);
    const sprint = await this.getActiveSprint(board.id);

    // Fetch all issues in the sprint
    const jql = `sprint = ${sprint.id} AND project = ${projectKey}`;
    const issues = await this.searchTicketsRaw(jql, 500);

    let totalPoints = 0;
    let completedPoints = 0;
    let completedIssues = 0;

    for (const issue of issues) {
      const pts = this.extractStoryPoints(issue);
      totalPoints += pts ?? 0;
      const statusCat = issue.fields.status?.name ?? '';
      if (DONE_CATEGORIES.has(statusCat)) {
        completedIssues++;
        completedPoints += pts ?? 0;
      }
    }

    const now = new Date();
    const endDate = sprint.endDate ? new Date(sprint.endDate) : now;
    const daysRemaining = Math.max(
      0,
      Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
    );

    return {
      sprintName: sprint.name,
      squad: this.squadMap[projectKey] ?? squad,
      state: sprint.state,
      startDate: sprint.startDate ?? '',
      endDate: sprint.endDate ?? '',
      daysRemaining,
      totalIssues: issues.length,
      completedIssues,
      totalPoints,
      completedPoints,
    };
  }

  /** Get all blocked tickets across configured projects. */
  async getBlockedTickets(): Promise<JiraTicket[]> {
    const projectKeys = Object.keys(this.squadMap);
    const projectClause =
      projectKeys.length > 0
        ? `AND project IN (${projectKeys.join(', ')})`
        : '';
    const jql = `(status = Blocked OR flagged = impediment) ${projectClause} ORDER BY priority DESC`;
    return this.searchTickets(jql, 100);
  }

  /** Get a single ticket by key. */
  async getTicket(key: string): Promise<JiraTicket> {
    await this.throttle();
    try {
      const resp = await this.client.get<JiraIssue>(
        `/rest/api/3/issue/${encodeURIComponent(key)}`,
        {
          params: {
            fields: this.issueFields(),
          },
        },
      );
      return this.mapIssue(resp.data);
    } catch (err) {
      throw this.wrapError(err, `Failed to fetch ticket ${key}`);
    }
  }

  /** Get velocity data for a squad over the last N sprints (default 5). */
  async getVelocity(squad: string, sprints = 5): Promise<VelocityData> {
    const projectKey = this.resolveSquad(squad);
    const board = await this.findBoard(projectKey);

    // Fetch closed sprints
    await this.throttle();
    const sprintResp = await this.client.get<{ values: JiraSprint[] }>(
      `/rest/agile/1.0/board/${board.id}/sprint`,
      { params: { state: 'closed', maxResults: sprints } },
    );
    const closedSprints = sprintResp.data.values.slice(-sprints);

    const sprintData: VelocityData['sprints'] = [];

    for (const sp of closedSprints) {
      // All issues that were in the sprint
      const allIssues = await this.searchTicketsRaw(
        `sprint = ${sp.id} AND project = ${projectKey}`,
        500,
      );

      let committed = 0;
      let completed = 0;
      for (const issue of allIssues) {
        const pts = this.extractStoryPoints(issue) ?? 0;
        committed += pts;
        const statusName = issue.fields.status?.name ?? '';
        if (DONE_CATEGORIES.has(statusName)) {
          completed += pts;
        }
      }

      sprintData.push({ name: sp.name, completed, committed });
    }

    return { squad: this.squadMap[projectKey] ?? squad, sprints: sprintData };
  }

  /** Get backlog size (count and total story points) for a squad. */
  async getBacklogSize(squad: string): Promise<{ count: number; points: number }> {
    const projectKey = this.resolveSquad(squad);
    const jql = `project = ${projectKey} AND statusCategory != Done AND sprint NOT IN openSprints() ORDER BY rank ASC`;
    const issues = await this.searchTicketsRaw(jql, 1000);

    let points = 0;
    for (const issue of issues) {
      points += this.extractStoryPoints(issue) ?? 0;
    }

    return { count: issues.length, points };
  }

  /** Get overdue tickets across all configured projects. */
  async getOverdueTickets(): Promise<JiraTicket[]> {
    const projectKeys = Object.keys(this.squadMap);
    const projectClause =
      projectKeys.length > 0
        ? `AND project IN (${projectKeys.join(', ')})`
        : '';
    const jql = `duedate < now() AND statusCategory != Done ${projectClause} ORDER BY duedate ASC`;
    return this.searchTickets(jql, 100);
  }

  /** Execute an arbitrary JQL search. */
  async searchTickets(jql: string, maxResults = 50): Promise<JiraTicket[]> {
    const raw = await this.searchTicketsRaw(jql, maxResults);
    return raw.map((issue) => this.mapIssue(issue));
  }

  /** Add a comment to a ticket. */
  async addComment(key: string, comment: string): Promise<void> {
    await this.throttle();
    try {
      await this.client.post(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
        body: {
          version: 1,
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: comment }],
            },
          ],
        },
      });
    } catch (err) {
      throw this.wrapError(err, `Failed to add comment to ${key}`);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Resolve a friendly squad name (or project key) to the Jira project key. */
  private resolveSquad(squad: string): string {
    // Try reverse map first (friendly name -> project key)
    const fromReverse = this.reverseSquadMap[squad.toLowerCase()];
    if (fromReverse) return fromReverse;

    // Try direct project key match
    const upper = squad.toUpperCase();
    if (this.squadMap[upper]) return upper;

    // If there's no mapping at all, assume the caller passed a project key
    return upper;
  }

  /** Find the first Scrum/Kanban board for a project. */
  private async findBoard(projectKey: string): Promise<JiraBoard> {
    await this.throttle();
    try {
      const resp = await this.client.get<{ values: JiraBoard[] }>(
        '/rest/agile/1.0/board',
        { params: { projectKeyOrId: projectKey, maxResults: 1 } },
      );
      const boards = resp.data.values;
      if (boards.length === 0) {
        throw new Error(`No Agile board found for project ${projectKey}`);
      }
      return boards[0];
    } catch (err) {
      throw this.wrapError(err, `Failed to find board for project ${projectKey}`);
    }
  }

  /** Get the currently active sprint on a board. */
  private async getActiveSprint(boardId: number): Promise<JiraSprint> {
    await this.throttle();
    try {
      const resp = await this.client.get<{ values: JiraSprint[] }>(
        `/rest/agile/1.0/board/${boardId}/sprint`,
        { params: { state: 'active' } },
      );
      const sprints = resp.data.values;
      if (sprints.length === 0) {
        throw new Error(`No active sprint found on board ${boardId}`);
      }
      return sprints[0];
    } catch (err) {
      throw this.wrapError(err, `Failed to fetch active sprint for board ${boardId}`);
    }
  }

  /** Raw search returning Jira issue objects (handles pagination). */
  private async searchTicketsRaw(jql: string, maxResults: number): Promise<JiraIssue[]> {
    const allIssues: JiraIssue[] = [];
    let startAt = 0;
    const pageSize = Math.min(maxResults, 100);

    while (allIssues.length < maxResults) {
      await this.throttle();
      try {
        const resp = await this.client.post<JiraSearchResponse>('/rest/api/3/search', {
          jql,
          startAt,
          maxResults: pageSize,
          fields: this.issueFields(),
        });

        allIssues.push(...resp.data.issues);

        if (
          resp.data.issues.length < pageSize ||
          allIssues.length >= resp.data.total
        ) {
          break;
        }

        startAt += pageSize;
      } catch (err) {
        throw this.wrapError(err, `JQL search failed: ${jql}`);
      }
    }

    return allIssues.slice(0, maxResults);
  }

  /** Map a raw Jira issue to our JiraTicket shape. */
  private mapIssue(issue: JiraIssue): JiraTicket {
    const f = issue.fields;
    const projectKey = issue.key.split('-')[0];

    const flagged = Boolean(f.flagged);
    const statusName = (f.status?.name ?? '').toLowerCase();

    return {
      key: issue.key,
      summary: f.summary ?? '',
      status: f.status?.name ?? 'Unknown',
      assignee: f.assignee?.displayName ?? null,
      squad: this.squadMap[projectKey.toUpperCase()] ?? projectKey,
      priority: f.priority?.name ?? 'None',
      created: f.created ?? '',
      updated: f.updated ?? '',
      dueDate: f.duedate ?? null,
      labels: f.labels ?? [],
      blockerReason: typeof f['customfield_10005'] === 'string' ? f['customfield_10005'] : null,
      isBlocked: flagged || statusName === 'blocked',
      storyPoints: this.extractStoryPoints(issue),
    };
  }

  /** Try to extract story points from common custom fields. */
  private extractStoryPoints(issue: JiraIssue): number | null {
    for (const field of STORY_POINTS_FIELDS) {
      const val = issue.fields[field];
      if (typeof val === 'number') return val;
    }
    return null;
  }

  /** The standard set of fields we request from the API. */
  private issueFields(): string[] {
    return [
      'summary',
      'status',
      'assignee',
      'priority',
      'created',
      'updated',
      'duedate',
      'labels',
      'flagged',
      'customfield_10005', // blocker reason (common)
      ...STORY_POINTS_FIELDS,
    ];
  }

  /** Simple self-throttle to avoid hammering the API. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await this.sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Wrap Axios/network errors into descriptive messages. */
  private wrapError(err: unknown, context: string): Error {
    if (err instanceof Error && 'isAxiosError' in err) {
      const axErr = err as AxiosError<{ errorMessages?: string[]; message?: string }>;
      const status = axErr.response?.status;
      const body = axErr.response?.data;

      if (status === 401) {
        return new Error(`${context}: Authentication failed – check JIRA_USER_EMAIL and JIRA_API_TOKEN.`);
      }
      if (status === 403) {
        return new Error(`${context}: Forbidden – the API token may lack required permissions.`);
      }
      if (status === 404) {
        return new Error(`${context}: Not found – verify the resource exists and JIRA_BASE_URL is correct.`);
      }

      const detail =
        body?.errorMessages?.join('; ') ?? body?.message ?? axErr.message;
      return new Error(`${context}: HTTP ${status ?? 'unknown'} – ${detail}`);
    }

    if (err instanceof Error) return err;
    return new Error(`${context}: ${String(err)}`);
  }
}
