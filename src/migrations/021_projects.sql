-- Projects: top-level entity for agent-built apps (owns a workspace + git repo)
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  stack       TEXT NOT NULL DEFAULT 'insforge',

  -- Ownership & access
  owner_id    TEXT NOT NULL REFERENCES users(id),
  team_id     TEXT REFERENCES teams(id),
  visibility  TEXT NOT NULL DEFAULT 'private',    -- 'private' | 'team' | 'public'

  -- Git
  git_repo_slug  TEXT NOT NULL UNIQUE,

  -- Deploy context (set after workspace is created)
  workspace_id   TEXT REFERENCES workspaces(id),

  -- InsForge integration
  insforge_project_id TEXT,

  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_projects_owner      ON projects(owner_id);
CREATE INDEX idx_projects_team       ON projects(team_id);
CREATE INDEX idx_projects_visibility ON projects(visibility);
CREATE INDEX idx_projects_git_slug   ON projects(git_repo_slug);
