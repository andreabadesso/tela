-- 016_schedule_mode.sql: Add execution mode to schedules
-- "agent" = run prompt through agent, "message" = deliver prompt text literally

ALTER TABLE schedules ADD COLUMN mode TEXT NOT NULL DEFAULT 'agent';
