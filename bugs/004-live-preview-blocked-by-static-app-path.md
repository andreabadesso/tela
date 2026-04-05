# Bug 004 — Live preview always shows static deploy instead of running dev server

**Status**: Fixed  
**Area**: `src/api/routes/app-proxy.ts`

## What happened

The app proxy checked `workspace.static_app_path` FIRST. Once a previous session set it (via `serve_workspace_app(directory: "dist")`), it persisted forever and every request went to static files — even when a new session container was running a live dev server with port_mappings set.

## The wrong fix (don't repeat)

An earlier attempt added `clearStaticApp()` in workspace-tools when only `api_port` is provided. This was wrong: it wiped the static deploy from the DB, so after the session ended (container destroyed, port_mappings cleared), there was NOTHING to serve. Preview showed "Agent is building..." forever.

## The correct fix

Change the priority order in `handleAppProxy` in `src/api/routes/app-proxy.ts`:

1. **`status === 'running'` AND port_mappings non-empty** → proxy to live dev server (ALWAYS wins)
2. **`static_app_path` set** → serve from disk (fallback when container is stopped)
3. Neither → return `no_port` 502

This means:
- During active session: users always see the live dev server (HMR, instant updates)
- After session ends (container destroyed): users see the last static deploy
- The static deploy is NEVER wiped — it's the persistent fallback

## Session lifecycle (correct)

1. Container starts → `attachSessionContainer` → `status = 'running'`
2. Agent: `npm run dev -- --host 0.0.0.0 &` + `serve_workspace_app(api_port: 5173)` → port_mappings set → live proxy active
3. Agent: `npm run build` + `serve_workspace_app(directory: "dist")` → `static_app_path` set (static fallback updated)
4. Session ends → `detachSessionContainer` → `port_mappings = []`, `status = 'created'`
5. Next request → container not running, falls through to static files ✓
