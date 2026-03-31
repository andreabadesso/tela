import { useState, useCallback, useRef, useEffect } from 'react';
import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import { api } from './api';
import type { WsMessage } from './ws';

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

export function useTelaRuntime(agentId?: string, threadId?: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(threadId ?? null);
  const threadIdRef = useRef<string | null>(currentThreadId);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingAssistantId = useRef<string | null>(null);

  // Keep ref in sync
  useEffect(() => { threadIdRef.current = currentThreadId; }, [currentThreadId]);

  // Load existing thread messages
  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      setCurrentThreadId(null);
      return;
    }
    // Clear immediately to prevent flash of old messages
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

  // WebSocket
  useEffect(() => {
    const token = localStorage.getItem('api_token') ?? '';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${protocol}//${window.location.host}/api/chat/stream?token=${token}`);
    } catch {
      return;
    }

    ws.onmessage = (event) => {
      let msg: WsMessage;
      try { msg = JSON.parse(event.data as string); } catch { return; }

      switch (msg.type) {
        case 'thinking':
          setIsRunning(true);
          break;
        case 'text': {
          const id = pendingAssistantId.current || generateId();
          pendingAssistantId.current = null;
          const content = msg.data as string;
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === id);
            if (existing) return prev.map((m) => m.id === id ? { ...m, content } : m);
            return [...prev, { id, role: 'assistant', content, timestamp: new Date() }];
          });
          // Persist assistant response
          if (threadIdRef.current) {
            api.addMessage(threadIdRef.current, 'assistant', content).catch(() => {});
          }
          setIsRunning(false);
          break;
        }
        case 'tool_calls': {
          const toolCalls = msg.data as ChatMessage['toolCalls'];
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              return [...prev.slice(0, -1), { ...last, toolCalls: [...(last.toolCalls ?? []), ...(toolCalls ?? [])] }];
            }
            return prev;
          });
          break;
        }
        case 'done':
          setIsRunning(false);
          break;
        case 'error':
          setIsRunning(false);
          pendingAssistantId.current = null;
          setMessages((prev) => [...prev, { id: generateId(), role: 'assistant', content: `Error: ${msg.data}`, timestamp: new Date() }]);
          break;
      }
    };

    ws.onerror = () => console.warn('[ws] WebSocket connection error');
    wsRef.current = ws;
    return () => { ws.close(); wsRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // WS connection is independent of threads — don't recreate

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
          // Update URL without full reload
          window.history.replaceState(null, '', `#/chat/${tid}`);
        } catch {
          // Continue without persistence
        }
      }

      // Add user message
      const userMsg: ChatMessage = { id: generateId(), role: 'user', content: userText, timestamp: new Date() };
      setMessages((prev) => [...prev, userMsg]);
      if (tid) api.addMessage(tid, 'user', userText).catch(() => {});

      // Placeholder for assistant
      const assistantId = generateId();
      pendingAssistantId.current = assistantId;
      setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '', timestamp: new Date() }]);
      setIsRunning(true);

      // WebSocket
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ text: userText, agentId }));
        return;
      }

      // REST fallback
      try {
        const res = await api.sendMessage(userText, agentId);
        pendingAssistantId.current = null;
        setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: res.text } : m));
        if (tid) api.addMessage(tid, 'assistant', res.text).catch(() => {});
      } catch (err) {
        pendingAssistantId.current = null;
        const errText = `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
        setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: errText } : m));
      } finally {
        setIsRunning(false);
      }
    },
    [agentId, currentThreadId],
  );

  const onCancel = useCallback(async () => { setIsRunning(false); }, []);

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
