import { memo, useState } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  CodeIcon,
  FileEditIcon,
  FileSearchIcon,
  FileTextIcon,
  GlobeIcon,
  LoaderIcon,
  SearchIcon,
  TerminalIcon,
  XCircleIcon,
  ZapIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent, ToolCallMessagePartStatus } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toTitleCase(s: string) {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatToolName(toolName: string): { primary: string; secondary?: string } {
  const mcpMatch = toolName.match(/^mcp__([a-zA-Z0-9-]+)__(.+)$/);
  if (mcpMatch) {
    return { primary: toTitleCase(mcpMatch[2]), secondary: toTitleCase(mcpMatch[1]) };
  }
  return { primary: toolName };
}

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function shortenPath(p: string) {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

function getArgSummary(toolName: string, argsText?: string): string | null {
  if (!argsText?.trim()) return null;
  try {
    const args = JSON.parse(argsText);
    switch (toolName) {
      case "Read":
      case "Write":
      case "Edit":
        return args.file_path ? shortenPath(args.file_path) : null;
      case "Glob":
        return args.pattern ? truncate(args.pattern, 50) : null;
      case "Grep":
        return args.pattern ? `"${truncate(args.pattern, 40)}"` : null;
      case "Bash":
        return args.command ? truncate(args.command, 60) : null;
      case "WebFetch":
        return args.url ? truncate(args.url, 60) : null;
      case "WebSearch":
        return args.query ? truncate(args.query, 60) : null;
      case "Agent":
        return args.description ? truncate(args.description, 60) : null;
      default: {
        const first = Object.values(args).find((v) => typeof v === "string" && (v as string).length > 0);
        return first ? truncate(String(first), 60) : null;
      }
    }
  } catch {
    return null;
  }
}

function ToolIcon({ toolName, className }: { toolName: string; className?: string }) {
  const lower = toolName.toLowerCase();
  let Icon = ZapIcon;
  if (lower === "read") Icon = FileTextIcon;
  else if (lower === "write" || lower === "edit") Icon = FileEditIcon;
  else if (lower === "glob") Icon = FileSearchIcon;
  else if (lower === "grep") Icon = SearchIcon;
  else if (lower === "bash") Icon = TerminalIcon;
  else if (lower === "webfetch" || lower === "websearch") Icon = GlobeIcon;
  else if (lower.includes("code") || lower.includes("sql")) Icon = CodeIcon;
  return <Icon className={className} />;
}

// ─── Main component ───────────────────────────────────────────────────────────

const ToolFallbackImpl: ToolCallMessagePartComponent = ({ toolName, argsText, result, status }) => {
  const [open, setOpen] = useState(false);

  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const isError = status?.type === "incomplete" && status.reason !== "cancelled";

  const { primary, secondary } = formatToolName(toolName);
  const summary = getArgSummary(toolName, argsText);

  let pretty: string | undefined;
  try { pretty = argsText ? JSON.stringify(JSON.parse(argsText), null, 2) : undefined; } catch { pretty = argsText; }
  const resultText = result === undefined ? undefined : typeof result === "string" ? result : JSON.stringify(result, null, 2);

  return (
    <div className={cn("group/tool my-0.5 text-xs", isCancelled && "opacity-50")}>
      {/* Pill trigger */}
      <button
        onClick={() => !isRunning && setOpen((o) => !o)}
        disabled={isRunning}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors",
          "text-muted-foreground hover:text-foreground hover:bg-muted/60",
          isRunning && "cursor-default",
          open && "bg-muted/60 text-foreground",
        )}
      >
        {/* Status icon */}
        {isRunning ? (
          <LoaderIcon className="size-3 shrink-0 animate-spin" />
        ) : isError ? (
          <XCircleIcon className="size-3 shrink-0 text-destructive" />
        ) : isCancelled ? (
          <XCircleIcon className="size-3 shrink-0" />
        ) : (
          <CheckIcon className="size-3 shrink-0 text-emerald-500" />
        )}

        {/* Tool icon */}
        <ToolIcon toolName={toolName} className="size-3 shrink-0" />

        {/* Label */}
        <span className="flex items-baseline gap-1">
          {secondary && <span className="text-muted-foreground/60">{secondary}:</span>}
          <span className={cn("font-medium", isCancelled && "line-through")}>{primary}</span>
          {summary && <span className="font-mono text-muted-foreground/60 truncate max-w-64">{summary}</span>}
        </span>

        {/* Expand chevron — only when not running and there's content to show */}
        {!isRunning && (pretty || resultText) && (
          <ChevronRightIcon
            className={cn("size-3 shrink-0 ml-auto transition-transform", open && "rotate-90")}
          />
        )}
      </button>

      {/* Expanded detail */}
      {open && (pretty || resultText || isError) && (
        <div className="ml-6 mt-1 flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
          {isError && status?.type === "incomplete" && status.error && (
            <p className="text-destructive text-xs">{String(status.error)}</p>
          )}
          {pretty && (
            <div>
              <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Input</p>
              <pre className="max-h-40 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap">{pretty}</pre>
            </div>
          )}
          {resultText && (
            <div className="border-t pt-2">
              <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Result</p>
              <pre className="max-h-48 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap">
                {resultText.length > 2000 ? resultText.slice(0, 2000) + "\n…" : resultText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const ToolFallback = memo(ToolFallbackImpl) as unknown as ToolCallMessagePartComponent & {
  Root: never; Trigger: never; Content: never; Args: never; Result: never; Error: never;
};
ToolFallback.displayName = "ToolFallback";
