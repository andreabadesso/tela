-- Add team_id to connections for team-scoped tokens
ALTER TABLE connections ADD COLUMN team_id TEXT REFERENCES teams(id);

-- Update token_strategy to support 'team'
-- (SQLite can't modify constraints, but the column already accepts any TEXT)
