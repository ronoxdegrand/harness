

import { Select as SelectPrimitive } from "@base-ui/react/select";
import {
  AlertTriangle,
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";

import { Button, Separator } from "@/components/ui";

import { GitCommits, GitFileGroup } from "@/components/GitGroups";
import { GitFlowSeparator } from "@/components/AppPrimitives";
import { DEFAULT_CONTEXT_WIDTH, DEFAULT_GIT_WIDTH, readJson } from "@/appShared";

import type { useAppController } from "@/useAppController";

type AppController = ReturnType<typeof useAppController>;

export function SidePanels({ controller }: { controller: AppController }) {
  const {
    workspacePath,
    modelName,
    branchPickerOpen,
    setBranchPickerOpen,
    activeThread,
    threadContext,
    expandedContextEntries,
    setExpandedContextEntries,
    narrowView,
    contextPreviewOpen,
    contextClosing,
    gitPreviewOpen,
    setGitPreviewOpen,
    gitClosing,
    gitStatus,
    gitStatusLoading,
    gitFetchError,
    gitMutation,
    commitMessage,
    setCommitMessage,
    commitMessageGenerating,
    setCommitMessageGenerating,
    collapsedGitGroups,
    setCollapsedGitGroups,
    contextWidth,
    setContextWidth,
    setGitWidth,
    error,
    setError,
    commitGenerationRef,
    resizeRef,
    loadGitStatus,
    switchGitBranch,
    syncGitBranch,
    createGitCommit,
    undoLastCommit,
    generateCommitMessage,
    startResize,
    resizePanel,
    holdPanelPreview,
    closePanelPreview,
    toggleContextPanel,
    runInProgress,
    contextPinnedOpen,
    contextVisible,
    gitPinnedOpen,
    gitVisible,
    gitBranchLabel,
    gitHasStagedChanges,
    gitHasChanges,
    contextUsage,
    gitFileGroupProps,
  } = controller;
  return (
    <>
      {narrowView && gitPreviewOpen ? (
        <button
          aria-label="Close Git panel"
          className="fixed inset-0 z-[35] cursor-default bg-black/10"
          type="button"
          onClick={() => setGitPreviewOpen(false)}
        />
      ) : null}

      {gitVisible ? (
        <aside
          aria-label="Git"
          className={`drawer-right fixed top-14 bottom-0 z-40 flex w-[var(--git-column-width)] max-w-[calc(100vw-3rem)] min-h-0 flex-col border-l bg-sidebar shadow-[-12px_0_30px_rgba(31,31,30,0.12)] lg:col-start-4 lg:max-w-none ${gitClosing ? "drawer-right-closing" : ""} ${
            gitPinnedOpen
              ? "lg:relative lg:inset-y-auto lg:z-auto lg:pt-14 lg:shadow-none"
              : "lg:absolute lg:top-14 lg:right-0 lg:bottom-0 lg:z-40"
          }`}
          style={narrowView && contextVisible
            ? { right: "calc((100vw - 3rem) / 2)", width: "calc((100vw - 3rem) / 2)" }
            : !gitPinnedOpen && contextPinnedOpen
              ? { right: `${contextWidth}px` }
              : { right: 0 }}
          onMouseEnter={() => holdPanelPreview("git")}
          onMouseLeave={() => {
            if (!gitPinnedOpen) closePanelPreview("git", setGitPreviewOpen);
          }}
        >
          {gitPinnedOpen ? (
            <div
              aria-label="Resize Git panel"
              className="group absolute inset-y-0 -left-1 z-30 hidden w-2 cursor-col-resize touch-none lg:block"
              role="separator"
              onDoubleClick={() => setGitWidth(DEFAULT_GIT_WIDTH)}
              onPointerCancel={() => (resizeRef.current = null)}
              onPointerDown={(event) => startResize("git", event)}
              onPointerMove={resizePanel}
              onPointerUp={() => (resizeRef.current = null)}
            >
              <span className="absolute inset-y-0 left-1/2 w-px bg-transparent group-hover:bg-border" />
            </div>
          ) : null}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {gitStatus?.is_repository && gitStatus.branches.length ? (
              <>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                <SelectPrimitive.Root
                  open={branchPickerOpen}
                  value={gitStatus.branch ?? undefined}
                  onOpenChange={setBranchPickerOpen}
                  onValueChange={(value) => value && void switchGitBranch(value as string)}
                >
                  <SelectPrimitive.Trigger
                    aria-label={`Switch branch, currently ${gitBranchLabel}`}
                    className="flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border bg-card px-2.5 font-mono text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                    disabled={Boolean(gitMutation) || runInProgress}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
                      <SelectPrimitive.Value className="truncate" />
                    </span>
                    <SelectPrimitive.Icon render={<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />} />
                  </SelectPrimitive.Trigger>
                  <SelectPrimitive.Portal>
                    <SelectPrimitive.Positioner alignItemWithTrigger sideOffset={4} className="z-50">
                      <SelectPrimitive.Popup className="min-w-[var(--anchor-width)] rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
                        <SelectPrimitive.List>
                          {gitStatus.branches.map((branch) => (
                            <SelectPrimitive.Item
                              className="relative flex cursor-default items-center rounded-md py-1.5 pr-8 pl-2 font-mono text-xs outline-none focus:bg-accent focus:text-accent-foreground"
                              key={branch}
                              value={branch}
                            >
                              <SelectPrimitive.ItemText>{branch}</SelectPrimitive.ItemText>
                              <SelectPrimitive.ItemIndicator className="absolute right-2" render={<Check className="size-3.5" />} />
                            </SelectPrimitive.Item>
                          ))}
                        </SelectPrimitive.List>
                      </SelectPrimitive.Popup>
                    </SelectPrimitive.Positioner>
                  </SelectPrimitive.Portal>
                </SelectPrimitive.Root>
                </div>
                <Button
                  aria-label={gitFetchError ? "Retry remote Git refresh" : "Refresh Git status and fetch remote"}
                  className={`size-9 shrink-0 ${gitFetchError ? "text-warning" : "text-muted-foreground"}`}
                  disabled={gitStatusLoading || Boolean(gitMutation)}
                  size="icon-sm"
                  data-tooltip={gitFetchError ? `Remote refresh failed: ${gitFetchError}. Local status is still current.` : "Fetch remote and refresh local status"}
                  type="button"
                  variant="outline"
                  onClick={() => void loadGitStatus(false, true)}
                >
                  <RefreshCw aria-hidden="true" className={`size-3.5 ${gitStatusLoading ? "animate-spin" : ""}`} />
                </Button>
              </div>
              <Separator />
              </>
              ) : null}
              {gitStatusLoading && !gitStatus ? (
                <div className="flex items-center justify-center gap-2 px-2 py-8 text-sm text-muted-foreground">
                  <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Reading Git status...
                </div>
              ) : !workspacePath.trim() ? (
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-6 text-muted-foreground">
                  <div className="mb-1 flex items-center gap-2 font-semibold text-foreground">
                    <AlertTriangle aria-hidden="true" className="size-4 text-warning" /> No path selected
                  </div>
                  Choose a workspace path to see what Git is tracking.
                </div>
              ) : gitStatus?.error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm leading-6 text-muted-foreground">
                  <div className="mb-1 flex items-center gap-2 font-semibold text-foreground">
                    <AlertTriangle aria-hidden="true" className="size-4 text-destructive" /> Git status unavailable
                  </div>
                  {gitStatus.error}
                </div>
              ) : gitStatus && !gitStatus.is_repository ? (
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm leading-6 text-muted-foreground">
                  <div className="mb-1 flex items-center gap-2 font-semibold text-foreground">
                    <AlertTriangle aria-hidden="true" className="size-4 text-warning" /> Nothing is being tracked
                  </div>
                  This path is not inside a Git repository.
                </div>
              ) : gitStatus ? (
                <>

                  <GitFileGroup
                    {...gitFileGroupProps}
                    group="changes"
                    title="Changes"
                    files={[...gitStatus.modified, ...gitStatus.untracked]}
                    action="stage"
                  />
                  {!gitHasChanges ? (
                    <section>
                      <div className="mb-1 flex h-5 items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        <span>Changes</span>
                        <span className="font-normal tabular-nums">0</span>
                      </div>
                      <div className="rounded-lg border bg-card px-3 py-2.5 text-xs text-muted-foreground">
                        Working tree clean.
                      </div>
                    </section>
                  ) : null}
                  {(gitStatus.modified.length || gitStatus.untracked.length) && gitStatus.staged.length ? <GitFlowSeparator /> : null}
                  <GitFileGroup
                    {...gitFileGroupProps}
                    group="staged"
                    title="Staged changes"
                    files={gitStatus.staged}
                    action="unstage"
                  />
                  <GitFlowSeparator />
                  <form
                    className="flex min-w-0 items-stretch overflow-hidden rounded-lg border bg-card focus-within:ring-2 focus-within:ring-ring/40"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createGitCommit();
                    }}
                  >
                    <div className="relative min-w-0 flex-1">
                    <label>
                      <span className="sr-only">Commit message</span>
                      <textarea
                        className={`block min-h-8 max-h-32 w-full resize-none overflow-y-auto border-0 bg-transparent py-[7px] pl-2.5 text-xs leading-[18px] outline-none [field-sizing:content] placeholder:text-muted-foreground ${modelName ? "pr-9" : "pr-2.5"}`}
                        rows={1}
                        maxLength={200}
                        placeholder="Commit message"
                        value={commitMessage}
                        onChange={(event) => setCommitMessage(event.target.value)}
                      />
                    </label>
                    {modelName ? (
                      <Button
                        aria-label={commitMessageGenerating ? "Cancel commit message generation" : "Generate commit message with AI"}
                        className="group/commit-ai absolute top-1 right-1 size-6 rounded-md text-muted-foreground hover:bg-muted/60"
                        disabled={!commitMessageGenerating && (!gitHasChanges || Boolean(gitMutation))}
                        size="icon-sm"
                        data-tooltip={commitMessageGenerating ? "Cancel generation" : gitHasStagedChanges ? "Generate from staged changes" : "Generate from working-tree changes"}
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          if (commitGenerationRef.current) {
                            commitGenerationRef.current.abort();
                            commitGenerationRef.current = null;
                            setCommitMessageGenerating(false);
                          } else void generateCommitMessage();
                        }}
                      >
                        {commitMessageGenerating ? (
                          <>
                            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin group-hover/commit-ai:hidden group-focus-visible/commit-ai:hidden" />
                            <X aria-hidden="true" className="hidden size-3.5 group-hover/commit-ai:block group-focus-visible/commit-ai:block" />
                          </>
                        ) : (
                          <Sparkles aria-hidden="true" className="size-3.5" />
                        )}
                      </Button>
                    ) : null}
                    </div>
                    <Button
                      className="h-auto min-h-8 rounded-none border-l px-3 text-xs"
                      disabled={!gitHasStagedChanges || !commitMessage.trim() || Boolean(gitMutation)}
                      size="sm"
                      type="submit"
                      variant="affirmative"
                    >
                      Commit
                    </Button>
                  </form>
                  <GitFlowSeparator />
                  <div className="space-y-3">
                  <GitCommits
                    gitStatus={gitStatus}
                    collapsedGitGroups={collapsedGitGroups}
                    setCollapsedGitGroups={setCollapsedGitGroups}
                    gitMutation={gitMutation}
                    runInProgress={runInProgress}
                    undoLastCommit={undoLastCommit}
                  />
                  {gitStatus.local_commits.length ? <GitFlowSeparator /> : null}
                    <Button
                      aria-label={gitMutation === "sync"
                        ? `Synchronizing with ${gitStatus.upstream}`
                        : `Synchronize ${gitBranchLabel} with ${gitStatus.upstream ?? "upstream"}: ${gitStatus.ahead} to push, ${gitStatus.behind} to pull`}
                      aria-busy={gitMutation === "sync"}
                      className="h-8 w-full min-w-0 justify-start gap-2 px-2.5 text-xs"
                      disabled={!gitStatus.upstream || (!gitStatus.ahead && !gitStatus.behind) || Boolean(gitMutation)}
                      data-tooltip={gitMutation === "sync" ? `Synchronizing with ${gitStatus.upstream}` : gitStatus.upstream ? `Synchronize with ${gitStatus.upstream}` : "This branch has no upstream"}
                      type="button"
                      variant="outline"
                      onClick={() => void syncGitBranch()}
                    >
                      {gitMutation === "sync"
                        ? <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
                        : <ArrowDownUp aria-hidden="true" className="size-3.5 shrink-0" />}
                      <span className="shrink-0">{gitStatus.upstream ? "Sync" : "No upstream"}</span>
                      {gitStatus.upstream ? (
                        <span className="min-w-0 truncate font-mono text-muted-foreground">{gitStatus.upstream}</span>
                      ) : null}
                      {gitStatus.upstream ? (
                        <span className="ml-auto flex shrink-0 items-center gap-2 font-normal text-muted-foreground">
                          <span className={gitStatus.ahead ? "text-foreground" : ""}>
                            <ChevronUp aria-hidden="true" className="inline size-3.5" />{gitStatus.ahead}
                          </span>
                          <span className={gitStatus.behind ? "text-foreground" : ""}>
                            <ChevronDown aria-hidden="true" className="inline size-3.5" />{gitStatus.behind}
                          </span>
                        </span>
                      ) : null}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          </aside>
        ) : null}

        {contextPreviewOpen && !contextPinnedOpen ? (
          <button
            aria-label="Close context panel"
            className="fixed inset-0 z-[35] cursor-default bg-black/10"
            type="button"
            onClick={toggleContextPanel}
          />
        ) : null}

        {contextVisible ? (
          <aside
            className={`drawer-right fixed top-14 right-0 bottom-0 z-40 flex w-[var(--context-column-width)] max-w-[calc(100vw-3rem)] min-h-0 flex-col border-l bg-sidebar shadow-[-12px_0_30px_rgba(31,31,30,0.12)] lg:col-start-5 lg:max-w-none ${contextClosing ? "drawer-right-closing" : ""} ${
              contextPinnedOpen
                ? "lg:relative lg:inset-y-auto lg:z-auto lg:pt-14 lg:shadow-none"
                : "lg:absolute lg:top-14 lg:right-0 lg:bottom-0 lg:z-40"
            }`}
            style={narrowView && gitVisible ? { width: "calc((100vw - 3rem) / 2)" } : undefined}
          >
            {contextPinnedOpen ? (
              <div
                aria-label="Resize context panel"
                className="group absolute inset-y-0 -left-1 z-30 hidden w-2 cursor-col-resize touch-none lg:block"
                role="separator"
                onDoubleClick={() => setContextWidth(DEFAULT_CONTEXT_WIDTH)}
                onPointerCancel={() => (resizeRef.current = null)}
                onPointerDown={(event) => startResize("context", event)}
                onPointerMove={resizePanel}
                onPointerUp={() => (resizeRef.current = null)}
              >
                <span className="absolute inset-y-0 left-1/2 w-px bg-transparent group-hover:bg-border" />
              </div>
            ) : null}
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
              {threadContext ? (
                <>
                  <section className="rounded-lg border bg-card p-3">
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          Harness message budget
                        </p>
                        <p className="mt-1 text-lg font-semibold tabular-nums">
                          ~{threadContext.estimated_tokens.toLocaleString()}
                          <span className="text-sm font-normal text-muted-foreground">
                            {" "}/ {threadContext.token_budget.toLocaleString()}
                          </span>
                        </p>
                      </div>
                      <span className="text-xs tabular-nums text-muted-foreground">{Math.round(contextUsage)}%</span>
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${contextUsage}%` }} />
                    </div>
                    <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                      {threadContext.estimate_method}. Message bodies only; this is not the model tokenizer.
                    </p>
                  </section>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border bg-card p-3 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-info-indicator" />Pinned</span>
                    <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-success-indicator" />Included</span>
                    <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-warning-indicator" />Truncated</span>
                    <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-muted-foreground" />Excluded</span>
                  </div>
                  <div className="space-y-1.5">
                    {threadContext.messages.map((message) => {
                      const expanded = message.index in expandedContextEntries;
                      const content = expandedContextEntries[message.index];
                      return (
                      <button
                        aria-expanded={message.expandable ? expanded : undefined}
                        className={`block w-full rounded-lg border bg-card p-3 text-left ${
                          message.included ? "" : "opacity-70"
                        } ${message.expandable ? "cursor-pointer hover:bg-accent/40" : "cursor-default"}`}
                        disabled={!message.expandable}
                        key={message.index}
                        type="button"
                        onClick={async () => {
                          if (expanded) {
                            setExpandedContextEntries((current) => {
                              const { [message.index]: _, ...collapsed } = current;
                              return collapsed;
                            });
                            return;
                          }
                          if (!activeThread) return;
                          setExpandedContextEntries((current) => ({ ...current, [message.index]: null }));
                          try {
                            const response = await fetch(`/threads/${activeThread.id}/context/${message.index}`);
                            if (!response.ok) throw new Error();
                            const payload = await readJson<{ content: string }>(response);
                            setExpandedContextEntries((current) =>
                              message.index in current
                                ? { ...current, [message.index]: payload.content }
                                : current,
                            );
                          } catch {
                            setExpandedContextEntries((current) => {
                              const { [message.index]: _, ...collapsed } = current;
                              return collapsed;
                            });
                            setError("Could not load this context entry.");
                          }
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`size-2 rounded-full ${
                            !message.included
                              ? "bg-muted-foreground"
                              : message.truncated
                                ? "bg-warning-indicator"
                                : message.pinned
                                  ? "bg-info-indicator"
                                  : "bg-success-indicator"
                          }`} />
                          <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">
                            {message.name || message.role}
                          </span>
                          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                            ~{message.tokens.toLocaleString()} tok
                          </span>
                          {message.expandable ? (
                            <ChevronUp
                              aria-hidden="true"
                              className={`size-3.5 text-muted-foreground transition-transform ${expanded ? "" : "rotate-180"}`}
                            />
                          ) : null}
                        </div>
                        <p className={`mt-2 text-xs leading-5 text-muted-foreground ${expanded ? "whitespace-pre-wrap break-words" : "line-clamp-3"}`}>
                          {content === null ? "Loading..." : (content ?? message.preview) || "Empty message"}
                        </p>
                        {message.pinned || message.truncated || !message.included ? (
                          <p className={`mt-2 text-[10px] font-semibold uppercase tracking-[0.1em] ${
                            !message.included
                              ? "text-muted-foreground"
                              : message.truncated
                                ? "text-warning"
                                : "text-info"
                          }`}>
                            {message.truncated
                              ? message.pinned ? "Pinned | truncated" : "Truncated to fit"
                              : message.pinned ? "Latest instruction | pinned" : "Outside window"}
                          </p>
                        ) : null}
                      </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <p className="px-2 py-8 text-center text-sm leading-6 text-muted-foreground">
                  Context will appear when a run starts.
                </p>
              )}
            </div>
          </aside>
        ) : null}
    </>
  );
}
