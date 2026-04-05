# Bug 003 — ProjectChat history lost on page refresh

**Status**: Open  
**Area**: `web/src/lib/project-session-runtime.ts`, `web/src/pages/ProjectChat.tsx`

## What happens

When the user refreshes the page while a session is active (or shortly after), the chat thread appears empty or shows only "Working..." without the accumulated tool calls and text generated so far.

## Root cause

`streamOverrides` in `useProjectChatRuntime` is plain React state — it lives only in memory. On refresh it's empty. For the active session, the runtime rebuilds messages from `sessions` (loaded from DB), but since `session.output` is only written on commit, the in-progress content has nowhere to come from.

For committed sessions, the history _should_ load correctly from DB via TanStack Query. If those are also missing, it's likely a rendering race (empty state flash before the query resolves) or a scroll issue in the Thread component.

## Fix (not yet implemented)

**Active session stream state**: persist to `localStorage` keyed by `sessionId` as SSE events arrive. On `useProjectChatRuntime` init, if any session has `status === 'running'`, seed `streamOverrides` from `localStorage`. Clear the entry when the session transitions to `committed` or `failed`.

```ts
// On each SSE event that updates the message:
localStorage.setItem(`tela:stream:${sessionId}`, JSON.stringify({ content, toolCalls }));

// On init:
const saved = localStorage.getItem(`tela:stream:${sessionId}`);
if (saved) initialOverrides.set(sessionId, JSON.parse(saved));
```

**Committed sessions**: verify the Thread component doesn't flash empty while the query is loading — add a loading skeleton or keep the previous data (`keepPreviousData: true` in TanStack Query).
