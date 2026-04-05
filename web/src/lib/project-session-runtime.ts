import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import type { ProjectSession } from './api';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  toolCalls?: Array<{ name: string; args?: unknown; result?: unknown }>;
  timestamp: Date;
}

function convertMessage(msg: ChatMessage): ThreadMessageLike {
  if (msg.role === 'user') {
    return { role: 'user', id: msg.id, content: msg.content, createdAt: msg.timestamp };
  }
  if (msg.toolCalls?.length) {
    const toolParts = msg.toolCalls.map((tc) => ({
      type: 'tool-call' as const,
      toolCallId: generateId(),
      toolName: tc.name,
      args: (tc.args ?? {}) as Readonly<Record<string, string | number | boolean | null>>,
      result: tc.result != null ? JSON.stringify(tc.result) : ('(no result)' as const),
    }));
    const textParts = msg.content ? [{ type: 'text' as const, text: msg.content }] : [];
    return {
      role: 'assistant', id: msg.id, content: [...toolParts, ...textParts],
      createdAt: msg.timestamp,
      status: { type: 'complete' },
    };
  }
  const displayText = msg.content || msg.status || '';
  return {
    role: 'assistant', id: msg.id,
    content: displayText,
    createdAt: msg.timestamp,
    status: msg.content ? { type: 'complete' } : { type: 'running' },
  };
}

async function* streamProjectSession(
  projectId: string,
  sessionId: string,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const token = localStorage.getItem('api_token') ?? '';
  const response = await fetch(`/api/projects/${projectId}/sessions/${sessionId}/stream`, {
    credentials: 'include',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal,
  });
  if (!response.ok) {
    const err = await response.text();
    yield { event: 'error', data: JSON.stringify({ error: err }) };
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) { yield { event: 'error', data: JSON.stringify({ error: 'No response body' }) }; return; }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      let currentEvent = 'message';
      for (const line of lines) {
        if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); }
        else if (line.startsWith('data: ')) { yield { event: currentEvent, data: line.slice(6) }; currentEvent = 'message'; }
      }
    }
  } finally { reader.releaseLock(); }
}

export function parseUserInput(session: ProjectSession): string {
  try { const p = JSON.parse(session.input); return p.message ?? session.input; }
  catch { return session.input; }
}

/**
 * Unified chat runtime for a project — shows ALL sessions as a single conversation thread.
 * Committed sessions render directly from DB. Active session streams live.
 */
export function useProjectChatRuntime(projectId: string, sessions: ProjectSession[]) {
  // Map<sessionId, streaming assistant message>
  const [streamOverrides, setStreamOverrides] = useState<Map<string, ChatMessage>>(() => {
    const initial = new Map<string, ChatMessage>();
    for (const session of sessions) {
      if (session.status === 'pending' || session.status === 'running') {
        try {
          const saved = localStorage.getItem(`tela:stream:${session.id}`);
          if (saved) initial.set(session.id, JSON.parse(saved));
        } catch { /* ignore */ }
      }
    }
    return initial;
  });
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef<string | null>(null);

  const activeSession = sessions.find((s) => s.status === 'pending' || s.status === 'running') ?? null;

  // Build unified message list from all sessions (oldest first)
  const messages = useMemo(() => {
    const ordered = [...sessions].reverse(); // API returns newest-first
    const msgs: ChatMessage[] = [];
    for (const session of ordered) {
      const userInput = parseUserInput(session);
      msgs.push({
        id: `user-${session.id}`,
        role: 'user',
        content: userInput,
        timestamp: new Date(session.created_at),
      });

      const isActive = session.status === 'pending' || session.status === 'running';
      const override = streamOverrides.get(session.id);

      if (override) {
        msgs.push(override);
      } else if (isActive) {
        msgs.push({
          id: `assistant-${session.id}`,
          role: 'assistant',
          content: '',
          status: 'Working...',
          timestamp: new Date(),
        });
      } else {
        const output = session.output ?? '';
        const error = session.error ?? '';
        msgs.push({
          id: `assistant-${session.id}`,
          role: 'assistant',
          content: output || (error ? `Error: ${error}` : '_Session completed with no output._'),
          timestamp: new Date(session.started_at ?? session.created_at),
        });
      }
    }
    return msgs;
  }, [sessions, streamOverrides]);

  // Stream the active session
  useEffect(() => {
    if (!activeSession) {
      abortRef.current?.abort();
      setIsRunning(false);
      return;
    }

    if (streamingRef.current === activeSession.id) return;
    streamingRef.current = activeSession.id;

    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    setIsRunning(true);

    const sessionId = activeSession.id;
    const assistantId = `assistant-${sessionId}`;

    (async () => {
      try {
        let fullText = '';
        const toolCalls: ChatMessage['toolCalls'] = [];

        const setMsg = (updater: (prev: ChatMessage) => ChatMessage) => {
          setStreamOverrides((map) => {
            const prev = map.get(sessionId) ?? {
              id: assistantId, role: 'assistant' as const, content: '', status: 'Working...', timestamp: new Date(),
            };
            const next = new Map(map);
            const updated = updater(prev);
            next.set(sessionId, updated);
            // Persist for page refresh recovery
            try { localStorage.setItem(`tela:stream:${sessionId}`, JSON.stringify(updated)); } catch { /* ignore */ }
            return next;
          });
        };

        for await (const { event, data } of streamProjectSession(projectId, sessionId, abortController.signal)) {
          if (abortController.signal.aborted) break;
          const parsed = JSON.parse(data);

          switch (event) {
            case 'thinking':
              setMsg((m) => ({ ...m, status: 'Thinking...' }));
              break;
            case 'text':
              fullText += parsed.text ?? '';
              setMsg((m) => ({ ...m, content: fullText }));
              break;
            case 'tool_call':
              toolCalls!.push({ name: parsed.name, args: parsed.args });
              setMsg((m) => ({ ...m, toolCalls: [...toolCalls!], status: `Using ${parsed.name}...` }));
              break;
            case 'tool_result':
              if (parsed.content && toolCalls!.length > 0) {
                const idx = parsed.toolCallId
                  ? toolCalls!.findIndex((tc) => (tc as any).toolCallId === parsed.toolCallId)
                  : toolCalls!.length - 1;
                if (idx >= 0) {
                  toolCalls![idx] = { ...toolCalls![idx], result: parsed.content };
                  setMsg((m) => ({ ...m, toolCalls: [...toolCalls!] }));
                }
              }
              break;
            case 'status':
              setMsg((m) => ({ ...m, status: parsed.message }));
              break;
            case 'result':
              fullText = parsed.text ?? fullText;
              setMsg((m) => ({ ...m, content: fullText, toolCalls: [...toolCalls!], status: undefined }));
              break;
            case 'error':
              setMsg((m) => ({ ...m, content: `Error: ${parsed.message || parsed.error || 'Unknown error'}`, status: undefined }));
              break;
            case 'session_done':
              setIsRunning(false);
              break;
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setStreamOverrides((map) => {
            const prev = map.get(sessionId);
            if (!prev) return map;
            const next = new Map(map);
            next.set(sessionId, { ...prev, content: prev.content || `Error: ${err instanceof Error ? err.message : 'Unknown'}`, status: undefined });
            return next;
          });
        }
      } finally {
        setIsRunning(false);
      }
    })();

    return () => { abortController.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.id, projectId]);

  // When active session transitions to committed, remove stream override so DB value takes over
  useEffect(() => {
    if (!streamingRef.current) return;
    const wasStreaming = streamingRef.current;
    const session = sessions.find((s) => s.id === wasStreaming);
    if (session && session.status !== 'pending' && session.status !== 'running') {
      // Session committed — clear override so the DB output renders
      streamingRef.current = null;
      setStreamOverrides((map) => {
        if (!map.has(wasStreaming)) return map;
        const next = new Map(map);
        next.delete(wasStreaming);
        return next;
      });
      try { localStorage.removeItem(`tela:stream:${wasStreaming}`); } catch { /* ignore */ }
    }
  }, [sessions]);

  const onNew = useCallback((_message: AppendMessage) => Promise.resolve(), []);

  const runtime = useExternalStoreRuntime({
    messages,
    setMessages: (() => {}) as (msgs: readonly ChatMessage[]) => void,
    isRunning,
    convertMessage,
    onNew,
  });

  return { runtime, isRunning };
}
