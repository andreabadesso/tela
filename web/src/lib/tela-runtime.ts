import { useState, useCallback, useRef, useEffect } from 'react';
import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import { api } from './api';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{
    name: string;
    args?: unknown;
    result?: unknown;
  }>;
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
      role: 'assistant', id: msg.id, content: [...toolParts, ...textParts], createdAt: msg.timestamp,
      status: msg.content || msg.toolCalls?.length ? { type: 'complete' } : { type: 'running' },
    };
  }
  return {
    role: 'assistant', id: msg.id,
    content: msg.content || 'Thinking...',
    createdAt: msg.timestamp,
    status: msg.content ? { type: 'complete' } : { type: 'running' },
  };
}

/**
 * Send a chat message via SSE (POST with streaming response).
 * Returns an async iterable of SSE events.
 */
async function* streamChat(text: string, agentId?: string): AsyncGenerator<{ event: string; data: string }> {
  const token = localStorage.getItem('api_token') ?? '';
  const response = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text, agentId }),
  });

  if (!response.ok) {
    const err = await response.text();
    yield { event: 'error', data: JSON.stringify({ error: err }) };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { event: 'error', data: JSON.stringify({ error: 'No response body' }) };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // keep incomplete line in buffer

    let currentEvent = 'message';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        yield { event: currentEvent, data: line.slice(6) };
        currentEvent = 'message';
      }
      // Skip empty lines and comments
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    const lines = buffer.split('\n');
    let currentEvent = 'message';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        yield { event: currentEvent, data: line.slice(6) };
      }
    }
  }
}

export function useTelaRuntime(agentId?: string, threadId?: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(threadId ?? null);
  const threadIdRef = useRef<string | null>(currentThreadId);
  const abortRef = useRef<AbortController | null>(null);

  // Keep ref in sync
  useEffect(() => { threadIdRef.current = currentThreadId; }, [currentThreadId]);

  // Load existing thread messages
  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      setCurrentThreadId(null);
      return;
    }
    setMessages([]);
    setCurrentThreadId(threadId);
    api.getThread(threadId).then((thread) => {
      const loaded: ChatMessage[] = thread.messages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
        timestamp: new Date(m.created_at),
      }));
      setMessages(loaded);
    }).catch(() => {
      setMessages([]);
    });
  }, [threadId]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const textPart = message.content.find((p) => p.type === 'text');
      if (!textPart || textPart.type !== 'text') return;
      const userText = textPart.text;

      // Auto-create thread if none exists
      let tid = currentThreadId;
      if (!tid) {
        const effectiveAgentId = agentId || 'default';
        const title = userText.slice(0, 50) + (userText.length > 50 ? '...' : '');
        try {
          const thread = await api.createThread(effectiveAgentId, title);
          tid = thread.id;
          setCurrentThreadId(tid);
          threadIdRef.current = tid;
          window.history.replaceState(null, '', `#/chat/${tid}`);
        } catch {
          // Continue without persistence
        }
      }

      // Add user message
      const userMsg: ChatMessage = { id: generateId(), role: 'user', content: userText, timestamp: new Date() };
      setMessages((prev) => [...prev, userMsg]);
      if (tid) api.addMessage(tid, 'user', userText).catch(() => {});

      // Placeholder assistant message (shows "Thinking...")
      const assistantId = generateId();
      setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '', timestamp: new Date() }]);
      setIsRunning(true);

      // Stream via SSE
      try {
        let fullText = '';

        for await (const { event, data } of streamChat(userText, agentId)) {
          switch (event) {
            case 'thinking':
              // Already showing placeholder
              break;

            case 'text': {
              const parsed = JSON.parse(data);
              fullText = parsed.text ?? '';
              setMessages((prev) =>
                prev.map((m) => m.id === assistantId ? { ...m, content: fullText } : m)
              );
              break;
            }

            case 'tool_calls': {
              const parsed = JSON.parse(data);
              setMessages((prev) =>
                prev.map((m) => m.id === assistantId ? { ...m, toolCalls: parsed.toolCalls } : m)
              );
              break;
            }

            case 'done':
              // Persist assistant response
              if (tid && fullText) {
                api.addMessage(tid, 'assistant', fullText).catch(() => {});
              }
              break;

            case 'error': {
              const parsed = JSON.parse(data);
              fullText = `Error: ${parsed.error}`;
              setMessages((prev) =>
                prev.map((m) => m.id === assistantId ? { ...m, content: fullText } : m)
              );
              break;
            }
          }
        }
      } catch (err) {
        const errText = `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
        setMessages((prev) =>
          prev.map((m) => m.id === assistantId ? { ...m, content: errText } : m)
        );
      } finally {
        setIsRunning(false);
      }
    },
    [agentId, currentThreadId],
  );

  const onCancel = useCallback(async () => {
    abortRef.current?.abort();
    setIsRunning(false);
  }, []);

  const runtime = useExternalStoreRuntime({
    messages,
    setMessages: setMessages as (msgs: readonly ChatMessage[]) => void,
    isRunning,
    convertMessage,
    onNew,
    onCancel,
  });

  return { runtime, currentThreadId };
}
