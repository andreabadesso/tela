# Bug 002 — Preview iframe shows JSON error before agent serves anything

**Status**: Open  
**Area**: `web/src/pages/ProjectChat.tsx`, `src/api/routes/app-proxy.ts`

## What happens

The preview pane renders an `<iframe src={appUrl}>` as soon as `project.app_url` is non-null. But `app_url` is set from the workspace ID at creation time — it's always set even before the agent has called `serve_workspace_app`. The app proxy returns `{"error":"no_port","message":"No exposed port available for this application"}` as raw JSON, which shows up in the iframe.

## Root cause

`project.app_url` is derived from `workspace.id`, not from whether the workspace actually has a static dir or port mapping. The preview renders eagerly.

## Fix (not yet implemented)

Before rendering the `<iframe>`, check if the workspace actually has something to serve:
- `GET /api/workspaces/:id` → check `static_app_dir` or `port_mappings` (non-empty array)
- If both are empty AND a session is active → show a placeholder ("Agent is building...") instead of the iframe
- Switch to iframe once either field is populated (poll with the same 3s interval used for session status)

Alternative: track in the SSE stream whether `serve_workspace_app` has been called (look for a `tool_call` event with `name === 'serve_workspace_app'`) and use that as the signal to show the iframe.
