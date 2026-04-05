# Bug 004 — Live preview always shows old static deploy, never live dev server

**Status**: Fixed  
**Area**: `src/tools/workspace-tools.ts`, `src/runtime/workspace-manager.ts`, `src/api/routes/app-proxy.ts`

## What happened

The app proxy decision tree is:
1. If `workspace.static_app_path` is set → serve from disk (container only as API fallback)
2. Else if `workspace.status === 'running'` → proxy to live container port

Once a session committed with `serve_workspace_app(directory: "dist")`, `static_app_path` was set in the DB and **never cleared**. On the next session, even though the agent called `serve_workspace_app(api_port: 5173)` to set up a live preview, `static_app_path` was still set, so the proxy kept serving the old static build. The live dev server was completely ignored.

## Fix

When `serve_workspace_app` is called with **only** `api_port` (live preview mode, no `directory`), `WorkspaceManager.clearStaticApp(workspaceId)` is called first. This sets `static_app_path = null` so the proxy falls through to the live container path. 

When the agent later calls `serve_workspace_app(directory: "dist")` for the final deploy, `static_app_path` is set again and the static build takes over permanently (and survives container shutdown).

## Timeline within a session

1. Session starts → `attachSessionContainer` → `status = 'running'`
2. Agent: `serve_workspace_app(api_port: 5173)` → `clearStaticApp` + `exposePort` → live proxy active
3. Agent: `serve_workspace_app(directory: "dist")` → `setStaticApp` → static deploy active
4. Session ends → `detachSessionContainer` → `status = 'created'`, `port_mappings = []`
5. Next page load → static files still served from disk ✓

## How to avoid

- `static_app_path` persists across sessions. Any code that registers a live port must also clear the static path, otherwise the live server is invisible to the proxy.
- When adding new proxy priority logic, trace the full session lifecycle (attach → live → build → detach → next session).
