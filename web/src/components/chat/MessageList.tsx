import { useEffect, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Bot, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolCallCard } from './ToolCallCard';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  toolCalls?: { name: string; args?: unknown; result?: unknown }[];
}

interface MessageListProps {
  messages: ChatMessage[];
  isThinking: boolean;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MessageList({ messages, isThinking }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  if (messages.length === 0 && !isThinking) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
          <Bot className="h-8 w-8 text-primary" />
        </div>
        <div className="text-center">
          <h2 className="text-lg font-semibold">Welcome to Tela</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your AI-powered CTO assistant. Send a message to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl space-y-1 px-4 py-6">
        {messages.map((msg) => (
          <div key={msg.id} className={cn('flex gap-3 py-3', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
            {msg.role === 'assistant' && (
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 mt-0.5">
                <Bot className="h-4 w-4 text-primary" />
              </div>
            )}
            <div className={cn('max-w-[80%] space-y-1', msg.role === 'user' ? 'text-right' : 'text-left')}>
              <div
                className={cn(
                  'inline-block rounded-xl px-4 py-2.5 text-sm leading-relaxed',
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/60 text-foreground'
                )}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="mt-1">
                  {msg.toolCalls.map((tc, i) => (
                    <ToolCallCard key={i} name={tc.name} args={tc.args} result={tc.result} />
                  ))}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground/60">{formatTime(msg.timestamp)}</p>
            </div>
            {msg.role === 'user' && (
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary mt-0.5">
                <User className="h-4 w-4 text-secondary-foreground" />
              </div>
            )}
          </div>
        ))}
        {isThinking && <ThinkingIndicator />}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
