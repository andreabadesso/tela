# Bug 001 — Workspace creation fails silently (FK constraint on agent_id)

**Status**: Fixed  
**Area**: `src/runtime/project-session.ts`, `src/runtime/workspace-manager.ts`

## What happened

When a project session started, it tried to lazily create a workspace by calling `workspaceManager.create('project-...', 'app-builder', userId)`. The string `'app-builder'` was passed as `agent_id`, but the `workspaces` table has a foreign key constraint `agent_id REFERENCES agents(id)`. Since no agent with ID `'app-builder'` exists in the DB, the insert silently failed (caught by a try/catch), leaving `workspace = null`. Without a workspace, the `workspace-tools` MCP server was never registered, so the agent had no `serve_workspace_app` tool.

## Fix

In `runSession`, the actual `agentId` from the session is now passed to `workspaceManager.create()` instead of the hardcoded string.

## How to avoid

- Never pass hardcoded strings as foreign key values to DB inserts.
- When workspace creation fails, check the error message — FK violations on `agent_id` mean the agent doesn't exist in the DB.
- The `workspace-tools` MCP server is only registered when `workspaceId` is truthy. If `serve_workspace_app` is missing from the agent's toolset, the workspace wasn't created.
