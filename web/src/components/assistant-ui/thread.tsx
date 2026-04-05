import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import { type FC, useEffect, useRef } from "react";

// ─── Scroll helper ────────────────────────────────────────────────────────────

/** Scrolls a container to the bottom. Used on initial thread load. */
export function useScrollToBottomOnMount(dep?: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Tiny delay so @assistant-ui finishes rendering messages first
    const id = setTimeout(() => { el.scrollTop = el.scrollHeight; }, 50);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
  return ref;
}

// ─── Thread ──────────────────────────────────────────────────────────────────

export const Thread: FC<{ hasMore?: boolean; loadMore?: () => void; loadingMore?: boolean; threadId?: string | null; readOnly?: boolean }> = ({
  hasMore,
  loadMore,
  loadingMore,
  threadId,
  readOnly,
}) => {
  const viewportRef = useScrollToBottomOnMount(threadId);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-background"
      style={{
        ["--thread-max-width" as string]: "48rem",
        ["--composer-radius" as string]: "1.25rem",
        ["--composer-padding" as string]: "10px",
      }}
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        className="relative flex flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pt-6"
      >
        {hasMore && (
          <div className="mx-auto w-full max-w-(--thread-max-width) flex justify-center py-3">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            >
              {loadingMore ? "Loading…" : "↑ Load earlier messages"}
            </button>
          </div>
        )}

        <AuiIf condition={(s) => s.thread.isEmpty}>
          <ThreadWelcome />
        </AuiIf>

        <ThreadPrimitive.Messages>
          {() => <ThreadMessage />}
        </ThreadPrimitive.Messages>

        {!readOnly && (
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto w-full max-w-(--thread-max-width) flex flex-col gap-2 bg-background pb-4 pt-2">
            <ThreadPrimitive.ScrollToBottom asChild>
              <TooltipIconButton
                tooltip="Scroll to bottom"
                variant="outline"
                className="absolute -top-10 right-0 size-8 rounded-full shadow-sm disabled:invisible"
              >
                <ArrowDownIcon className="size-4" />
              </TooltipIconButton>
            </ThreadPrimitive.ScrollToBottom>
            <Composer />
          </ThreadPrimitive.ViewportFooter>
        )}
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
};

// ─── Welcome ─────────────────────────────────────────────────────────────────

const ThreadWelcome: FC = () => (
  <div className="mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center py-16">
    <h1 className="text-2xl font-semibold mb-1">Hello there!</h1>
    <p className="text-muted-foreground mb-8">How can I help you today?</p>
    <ThreadSuggestions />
  </div>
);

const ThreadSuggestions: FC = () => (
  <div className="grid w-full @md:grid-cols-2 gap-2">
    <ThreadPrimitive.Suggestions>
      {() => (
        <SuggestionPrimitive.Trigger send asChild>
          <Button
            variant="ghost"
            className="h-auto w-full flex-col items-start gap-0.5 rounded-2xl border bg-background px-4 py-3 text-left text-sm hover:bg-muted"
          >
            <SuggestionPrimitive.Title className="font-medium" />
            <SuggestionPrimitive.Description className="text-muted-foreground text-xs empty:hidden" />
          </Button>
        </SuggestionPrimitive.Trigger>
      )}
    </ThreadPrimitive.Suggestions>
  </div>
);

// ─── Messages ────────────────────────────────────────────────────────────────

const AssistantMessage: FC = () => {
  const isRunning = useAuiState((s) => s.message.status?.type === "running");
  const rawContent = useAuiState((s) => {
    const parts = s.message.content;
    if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
    return null;
  });
  const isStatusOnly =
    isRunning && rawContent && !rawContent.includes("\n") && rawContent.length < 80 && !rawContent.includes("#");

  return (
    <MessagePrimitive.Root
      className="group/msg mx-auto w-full max-w-(--thread-max-width) py-2"
      data-role="assistant"
    >
      <div className="wrap-break-word text-foreground leading-relaxed">
        {isStatusOnly ? (
          <ThinkingIndicator status={rawContent} />
        ) : (
          <MessagePrimitive.Parts>
            {({ part }) => {
              if (part.type === "text") return <MarkdownText />;
              if (part.type === "tool-call")
                return (
                  <div className="my-0.5">
                    {part.toolUI ?? <ToolFallback {...part} />}
                  </div>
                );
              return null;
            }}
          </MessagePrimitive.Parts>
        )}
        {isRunning && !isStatusOnly && <ThinkingIndicator />}
        <MessageError />
      </div>

      {/* Action bar — only visible when hovered/last, sits below content */}
      <div className="mt-1 flex h-6 items-center opacity-0 group-hover/msg:opacity-100 transition-opacity">
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const MessageError: FC = () => (
  <MessagePrimitive.Error>
    <ErrorPrimitive.Root className="mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive text-sm">
      <ErrorPrimitive.Message className="line-clamp-2" />
    </ErrorPrimitive.Root>
  </MessagePrimitive.Error>
);

const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root
    hideWhenRunning
    autohide="not-last"
    className="-ml-1 flex gap-0.5 text-muted-foreground"
  >
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton tooltip="Copy" className="size-6">
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon className="size-3" />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon className="size-3" />
        </AuiIf>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload asChild>
      <TooltipIconButton tooltip="Retry" className="size-6">
        <RefreshCwIcon className="size-3" />
      </TooltipIconButton>
    </ActionBarPrimitive.Reload>
    <ActionBarMorePrimitive.Root>
      <ActionBarMorePrimitive.Trigger asChild>
        <TooltipIconButton tooltip="More" className="size-6 data-[state=open]:bg-accent">
          <MoreHorizontalIcon className="size-3" />
        </TooltipIconButton>
      </ActionBarMorePrimitive.Trigger>
      <ActionBarMorePrimitive.Content
        side="bottom"
        align="start"
        className="z-50 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      >
        <ActionBarPrimitive.ExportMarkdown asChild>
          <ActionBarMorePrimitive.Item className="flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground">
            <DownloadIcon className="size-4" />
            Export as Markdown
          </ActionBarMorePrimitive.Item>
        </ActionBarPrimitive.ExportMarkdown>
      </ActionBarMorePrimitive.Content>
    </ActionBarMorePrimitive.Root>
  </ActionBarPrimitive.Root>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root
    className="group/msg mx-auto flex w-full max-w-(--thread-max-width) justify-end py-2"
    data-role="user"
  >
    <div className="relative max-w-[80%]">
      <div className="wrap-break-word rounded-2xl bg-muted px-4 py-2.5 text-foreground text-sm">
        <MessagePrimitive.Parts />
      </div>
      <div className="absolute top-1/2 left-0 -translate-x-full -translate-y-1/2 pr-2 opacity-0 group-hover/msg:opacity-100 transition-opacity">
        <UserActionBar />
      </div>
    </div>
  </MessagePrimitive.Root>
);

const UserActionBar: FC = () => (
  <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex flex-col items-end">
    <ActionBarPrimitive.Edit asChild>
      <TooltipIconButton tooltip="Edit" className="size-7">
        <PencilIcon className="size-3" />
      </TooltipIconButton>
    </ActionBarPrimitive.Edit>
  </ActionBarPrimitive.Root>
);

const EditComposer: FC = () => (
  <MessagePrimitive.Root className="mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 py-3">
    <ComposerPrimitive.Root className="ml-auto flex w-full max-w-[85%] flex-col rounded-2xl bg-muted">
      <ComposerPrimitive.Input
        className="min-h-14 w-full resize-none bg-transparent p-4 text-foreground text-sm outline-none"
        autoFocus
      />
      <div className="mx-3 mb-3 flex items-center gap-2 self-end">
        <ComposerPrimitive.Cancel asChild>
          <Button variant="ghost" size="sm">Cancel</Button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <Button size="sm">Update</Button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  </MessagePrimitive.Root>
);

// ─── Composer ────────────────────────────────────────────────────────────────

const Composer: FC = () => (
  <ComposerPrimitive.Root className="relative flex w-full flex-col">
    <div className="flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-background p-(--composer-padding) transition-shadow focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/20">
      <ComposerPrimitive.Input
        placeholder="Send a message…"
        className="max-h-32 min-h-10 w-full resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground/60"
        rows={1}
        autoFocus
        aria-label="Message input"
      />
      <ComposerAction />
    </div>
  </ComposerPrimitive.Root>
);

const ComposerAction: FC = () => (
  <div className="flex items-center justify-end">
    <AuiIf condition={(s) => !s.thread.isRunning}>
      <ComposerPrimitive.Send asChild>
        <TooltipIconButton
          tooltip="Send"
          side="bottom"
          type="button"
          variant="default"
          size="icon"
          className="size-8 rounded-full"
        >
          <ArrowUpIcon className="size-4" />
        </TooltipIconButton>
      </ComposerPrimitive.Send>
    </AuiIf>
    <AuiIf condition={(s) => s.thread.isRunning}>
      <ComposerPrimitive.Cancel asChild>
        <Button type="button" variant="default" size="icon" className="size-8 rounded-full">
          <SquareIcon className="size-3 fill-current" />
        </Button>
      </ComposerPrimitive.Cancel>
    </AuiIf>
  </div>
);

// Unused but kept for @assistant-ui type compat
const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = () => null;
