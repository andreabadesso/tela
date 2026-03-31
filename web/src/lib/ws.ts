export type WsMessage =
  | { type: 'thinking'; data: null }
  | { type: 'text'; data: string }
  | { type: 'tool_calls'; data: unknown[] }
  | { type: 'done'; data: { durationMs: number } }
  | { type: 'error'; data: string };

export function createChatSocket(onMessage: (msg: WsMessage) => void): {
  send: (text: string, agentId?: string) => void;
  close: () => void;
} {
  const token = localStorage.getItem('api_token') ?? '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/api/chat/stream?token=${token}`);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as WsMessage;
      onMessage(msg);
    } catch {
      // ignore parse errors
    }
  };

  ws.onerror = () => {
    onMessage({ type: 'error', data: 'WebSocket connection error' });
  };

  return {
    send: (text: string, agentId?: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text, agentId }));
      }
    },
    close: () => ws.close(),
  };
}
