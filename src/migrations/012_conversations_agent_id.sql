-- Add agent_id to conversations for per-agent history isolation
ALTER TABLE conversations ADD COLUMN agent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id);
