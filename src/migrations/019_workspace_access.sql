-- Workspace access control: owner, visibility, team scoping, JWT secret
ALTER TABLE workspaces ADD COLUMN owner_id TEXT REFERENCES users(id);
ALTER TABLE workspaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE workspaces ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE workspaces ADD COLUMN jwt_secret TEXT;

CREATE INDEX idx_workspaces_owner ON workspaces(owner_id);
CREATE INDEX idx_workspaces_visibility ON workspaces(visibility);
