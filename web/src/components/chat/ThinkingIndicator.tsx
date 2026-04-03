interface ThinkingIndicatorProps {
  status?: string;
}

export function ThinkingIndicator({ status = 'Thinking...' }: ThinkingIndicatorProps) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2">
      <div className="relative h-1 w-12 overflow-hidden rounded-full bg-muted">
        <div className="absolute inset-y-0 left-0 w-1/2 animate-[pulse-slide_1.5s_ease-in-out_infinite] rounded-full bg-muted-foreground/50" />
      </div>
      <span className="text-xs text-muted-foreground">{status}</span>
    </div>
  );
}
