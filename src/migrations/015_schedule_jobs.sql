-- 015_schedule_jobs.sql: Agent-scheduled jobs support
-- Allows agents to autonomously create one-shot and recurring jobs via MCP tools.

-- Job type: 'cron' for recurring, 'one_shot' for fire-once
ALTER TABLE schedules ADD COLUMN type TEXT NOT NULL DEFAULT 'cron';

-- ISO datetime for one-shot jobs (NULL for cron)
ALTER TABLE schedules ADD COLUMN run_at TEXT;

-- Which agent created this schedule (may differ from agent_id that executes it)
ALTER TABLE schedules ADD COLUMN created_by_agent_id TEXT;

-- Optional custom output target (e.g., "telegram:@user_id", "slack:#channel")
ALTER TABLE schedules ADD COLUMN target_channel TEXT;

-- Lifecycle status: active, completed (one-shot ran), disabled, expired
ALTER TABLE schedules ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
