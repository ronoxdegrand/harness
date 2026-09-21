import { type CSSProperties, Fragment, lazy, Suspense } from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  CornerUpRight,
  FolderGit2,
  GitBranch,
  ListPlus,
  LoaderCircle,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Square,
  Trash2,
  UnfoldVertical,
  WrapText,
  X,
} from "lucide-react";

import {
  Badge,
  Button,
  Card,
  Input,
  Separator,
  Textarea,
} from "@/components/ui";
import { TooltipLayer } from "@/components/TooltipLayer";

import { ActivityIsland } from "@/components/ActivityIsland";

import { AssistantMarkdown, CopyButton, ShortcutKeys } from "@/components/AppPrimitives";
import {
  DEFAULT_DIFF_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  SHORTCUT_LABEL,
  countIterations,
  elapsedLabel,
  eventRunId,
  eventTime,
  formatTimestamp,
  gitPathParts,
  type ThreadSort,
} from "@/appShared";

import type { useAppController } from "@/useAppController";
import { SettingsDialog } from "@/SettingsDialog";
import { SidePanels } from "@/SidePanels";

const GitDiffContents = lazy(() => import("@/components/GitDiffContents"));

type AppController = ReturnType<typeof useAppController>;

export function AppView(controller: AppController) {
  const {
    desktop,
    macDesktop,
    desktopWindowControls,
    task,
    setTask,
    workspacePath,
    setWorkspacePath,
    modelName,
    setModelName,
    sendOnEnter,
    midRunEnterAction,
    uiScale,
    appearance,
    status,
    modelPickerOpen,
    setModelPickerOpen,
    shortcutsOpen,
    updateState,
    threads,
    activeThread,
    runningThreadId,
    runningRunId,
    threadToDelete,
    setThreadToDelete,
    threadTurns,
    events,
    assistantText,
    queuedTasks,
    stopping,
    activityClock,
    activityOpen,
    setActivityOpen,
    setGitOpen,
    narrowView,
    setGitPreviewOpen,
    gitStatus,
    gitStatusLoading,
    gitMutation,
    gitDiff,
    gitDiffWrap,
    setGitDiffWrap,
    gitDiffSplit,
    setGitDiffSplit,
    gitDiffShowUnchanged,
    setGitDiffShowUnchanged,
    composerHeight,
    undoCommitWarning,
    setUndoCommitWarning,
    activityRunId,
    setActivityRunId,
    setSidebarCollapsed,
    setSidebarPreviewOpen,
    sidebarWidth,
    setSidebarWidth,
    contextWidth,
    gitWidth,
    diffWidth,
    setDiffWidth,
    threadSort,
    setThreadSort,
    groupThreadsByPath,
    setGroupThreadsByPath,
    editingTitle,
    setEditingTitle,
    titleDraft,
    setTitleDraft,
    newThreadTitle,
    finalizedByIterationLimit,
    continuationRequest,
    error,
    setError,
    branchSwitchError,
    setBranchSwitchError,
    taskInputRef,
    composerRef,
    conversationBottomRef,
    conversationAreaRef,
    diffPanelRef,
    threadScrollRef,
    conversationScrollTopRef,
    resizeRef,
    modelInfo,
    availableModels,
    loadGitStatus,
    openGitDiff,
    closeGitDiff,
    switchGitBranch,
    undoLastCommit,
    openThread,
    startNewThread,
    renameActiveThread,
    deleteThread,
    startRun,
    queueTask,
    deleteQueuedTask,
    steerQueuedTask,
    steerRun,
    performMidRunAction,
    stopRun,
    answerContinuation,
    startResize,
    resizePanel,
    holdPanelPreview,
    openPanelPreview,
    closePanelPreview,
    toggleGitPanel,
    toggleContextPanel,
    openSettings,
    updateReady,
    updateTooltip,
    restartToUpdate,
    repositoryRequired,
    modelRequired,
    runInProgress,
    viewingOtherThreadDuringRun,
    contextAvailable,
    gitDiffCanSplit,
    diffRestrictsSidebarPinning,
    sidebarPinnedOpen,
    sidebarOpen,
    contextVisible,
    gitVisible,
    gitTracked,
    gitBranchLabel,
    gitChangedFileCount,
    effectiveActivityWidth,
    activityStacked,
    activityBesideThread,
    activeRunEnterAction,
    alternateRunEnterAction,
    contextUsage,
    threadGroups,
    layoutColumns,
    activityProps,
  } = controller;
  let composerPlaceholder: string;
  if (viewingOtherThreadDuringRun) {
    composerPlaceholder = "Open the running thread to send a message";
  } else if (status === "connecting") {
    composerPlaceholder = "Queue a follow-up while the run starts";
  } else if (status === "running") {
    composerPlaceholder = activeRunEnterAction === "queue"
      ? "Queue a follow-up or steer this run"
      : "Steer this run or queue a follow-up";
  } else if (activeThread) {
    composerPlaceholder = "Ask a follow-up or start a new task";
  } else {
    composerPlaceholder = workspacePath.trim()
      ? "What should I work on in this repository?"
      : "Select a repository to begin";
  }
  return (
    <main className="h-dvh overflow-hidden bg-background text-foreground">
      <TooltipLayer />
      <section
        style={{
          "--sidebar-width": `${sidebarWidth}px`,
          "--activity-width": `${effectiveActivityWidth}px`,
          "--context-column-width": `${contextWidth}px`,
          "--git-column-width": `${gitWidth}px`,
          "--diff-column-width": `min(${diffWidth}px, max(420px, calc(100vw - var(--git-column-width) - ${sidebarPinnedOpen ? "var(--sidebar-width)" : "0px"} - 96px)))`,
          "--layout-columns": layoutColumns,
        } as CSSProperties}
        className="layout-grid relative grid h-dvh w-full overflow-hidden lg:grid-cols-[var(--layout-columns)]"
      >
        {sidebarOpen ? (
          <aside
            className={`drawer-left fixed top-14 bottom-0 left-0 z-40 flex w-[var(--sidebar-width)] max-w-[calc(100vw-3rem)] min-h-0 flex-col border-r bg-sidebar shadow-[12px_0_30px_rgba(31,31,30,0.12)] lg:col-start-1 lg:max-w-none ${
              sidebarPinnedOpen
                ? "lg:relative lg:inset-y-auto lg:z-auto lg:shadow-none"
                : "sidebar-preview lg:absolute lg:top-14 lg:bottom-0 lg:left-0 lg:z-40"
            }`}
            onMouseEnter={() => holdPanelPreview("sidebar")}
            onMouseLeave={() => {
              if (!sidebarPinnedOpen) {
                closePanelPreview("sidebar", setSidebarPreviewOpen);
              }
            }}
          >
          {sidebarPinnedOpen ? (
            <header
              className={`flex h-14 shrink-0 items-center gap-1.5 border-b px-3 ${desktop ? "titlebar-drag" : ""}`}
              style={macDesktop ? { paddingLeft: `${80 / uiScale}px` } : undefined}
            >
                <Button
                  aria-label="Collapse sidebar"
                  className="size-10 shrink-0 bg-card"
                  size="icon-lg"
                  variant="outline"
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                >
                  <PanelLeft aria-hidden="true" className="size-4" />
                </Button>
                <Button
                  className="h-10 flex-1 justify-start bg-card px-3"
                  variant="outline"
                  type="button"
                  onClick={() => startNewThread()}
                >
                  <Plus aria-hidden="true" className="size-4" /> New chat
                </Button>
            </header>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col py-3 pl-3">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 pb-2 pr-3">
              <SelectPrimitive.Root
                value={threadSort}
                onValueChange={(value) => value && setThreadSort(value as ThreadSort)}
              >
                <SelectPrimitive.Trigger
                  aria-label="Sort threads"
                  className="flex h-8 min-w-0 cursor-pointer items-center justify-between gap-1.5 rounded-lg border bg-card px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span>{threadSort === "created" ? "Newest threads" : "Recent messages"}</span>
                  <SelectPrimitive.Icon render={<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />} />
                </SelectPrimitive.Trigger>
                <SelectPrimitive.Portal>
                  <SelectPrimitive.Positioner alignItemWithTrigger sideOffset={4} className="z-50">
                    <SelectPrimitive.Popup className="min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
                      <SelectPrimitive.List>
                        {([
                          ["recent-message", "Recent messages"],
                          ["created", "Newest threads"],
                        ] as const).map(([value, label]) => (
                          <SelectPrimitive.Item
                            className="relative flex cursor-default items-center rounded-md py-1.5 pr-8 pl-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
                            key={value}
                            value={value}
                          >
                            <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
                            <SelectPrimitive.ItemIndicator
                              className="absolute right-2"
                              render={<Check className="size-4" />}
                            />
                          </SelectPrimitive.Item>
                        ))}
                      </SelectPrimitive.List>
                    </SelectPrimitive.Popup>
                  </SelectPrimitive.Positioner>
                </SelectPrimitive.Portal>
              </SelectPrimitive.Root>
              <Button
                aria-label="Group threads by repository path"
                aria-pressed={groupThreadsByPath}
                className="h-8 gap-1.5 px-2 text-xs"
                data-tooltip="Group by repository path"
                type="button"
                variant={groupThreadsByPath ? "secondary" : "outline"}
                onClick={() => setGroupThreadsByPath((grouped) => !grouped)}
              >
                <FolderGit2 aria-hidden="true" className="size-3.5" /> Group
              </Button>
            </div>
            <nav className="space-y-1 overflow-y-auto pr-3">
              {threads.length ? (
                threadGroups.map(([path, groupThreads]) => (
                  <Fragment key={path ?? "all-threads"}>
                    {path ? (
                      <p
                        className="overflow-hidden whitespace-nowrap px-3 pb-1 pt-2 text-left font-mono text-[10px] font-medium text-muted-foreground [direction:rtl]"
                        data-tooltip={path}
                      >
                        {path}
                      </p>
                    ) : null}
                    {groupThreads.map((thread) => (
                      <div className="group relative" key={thread.id}>
                    <Button
                      className={`h-auto w-full justify-start rounded-lg px-3 py-2.5 text-left transition-[padding] ${
                        runInProgress && runningThreadId === thread.id
                          ? "pr-10"
                          : "pr-3 group-hover:pr-10 group-focus-within:pr-10"
                      } ${
                        activeThread?.id === thread.id
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                      }`}
                      type="button"
                      variant="ghost"
                      onClick={() => void openThread(thread.id)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm" data-tooltip={thread.title}>{thread.title}</span>
                        {!groupThreadsByPath ? (
                          <span
                            className="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap text-left font-mono text-xs text-muted-foreground [direction:rtl]"
                            data-tooltip={thread.workspace_path}
                          >
                            {thread.workspace_path}
                          </span>
                        ) : (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {formatTimestamp(
                              threadSort === "created"
                                ? thread.created_at
                                : thread.last_message_at ?? thread.created_at,
                            )}
                          </span>
                        )}
                      </span>
                    </Button>
                    {runInProgress && runningThreadId === thread.id ? (
                      <span
                        aria-label="Running"
                        className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center text-muted-foreground"
                        role="status"
                      >
                        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                      </span>
                    ) : (
                      <Button
                        aria-label={`Delete ${thread.title}`}
                        className="absolute top-1/2 right-1.5 size-7 -translate-y-1/2 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-destructive"
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setError("");
                          setThreadToDelete(thread);
                        }}
                      >
                        <Trash2 aria-hidden="true" className="size-3.5" />
                      </Button>
                    )}
                      </div>
                    ))}
                  </Fragment>
                ))
              ) : (
                <p className="px-3 py-4 text-sm text-muted-foreground">Your chats will appear here.</p>
              )}
            </nav>
          </div>
          {sidebarPinnedOpen ? (
            <div
              aria-label="Resize sidebar"
              className="group absolute inset-y-0 -right-1 z-30 hidden w-2 cursor-col-resize touch-none lg:block"
              role="separator"
              onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
              onPointerCancel={() => (resizeRef.current = null)}
              onPointerDown={(event) => startResize("sidebar", event)}
              onPointerMove={resizePanel}
              onPointerUp={() => (resizeRef.current = null)}
            >
              <span className="absolute inset-y-0 left-1/2 w-px bg-transparent group-hover:bg-border" />
            </div>
          ) : null}
          </aside>
        ) : null}

        <section className={`relative grid h-dvh min-h-0 min-w-0 grid-cols-1 bg-background lg:col-start-2 ${
          activeThread
            ? "grid-rows-[56px_minmax(0,1fr)_auto]"
            : "grid-rows-[56px_minmax(0,1fr)_auto_minmax(0,1fr)]"
        }`}>
          <header
            data-app-titlebar
            className={`fixed top-0 right-0 z-50 flex h-14 shrink-0 items-center border-b bg-background px-4 sm:px-5 ${desktop ? "titlebar-drag" : ""}`}
            style={{ left: sidebarPinnedOpen && !narrowView ? "var(--sidebar-width)" : 0 }}
          >
            {!sidebarPinnedOpen ? (
              <div
                className={`absolute z-50 flex shrink-0 items-center gap-1 ${macDesktop ? "" : "left-3"}`}
                style={macDesktop ? { left: `${80 / uiScale}px` } : undefined}
              >
                <Button
                  aria-label="Expand sidebar"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onMouseEnter={() => {
                    openPanelPreview("sidebar");
                  }}
                  onMouseLeave={() => closePanelPreview("sidebar", setSidebarPreviewOpen)}
                  onClick={() => {
                    if (diffRestrictsSidebarPinning || narrowView) openPanelPreview("sidebar");
                    else {
                      setSidebarCollapsed(false);
                      setSidebarPreviewOpen(false);
                    }
                  }}
                >
                  <PanelLeft aria-hidden="true" className="size-4" />
                </Button>
                <Button
                  aria-label="New chat"
                  className={`size-10 bg-card ${editingTitle ? "max-lg:hidden" : ""}`}
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onClick={() => startNewThread()}
                >
                  <Plus aria-hidden="true" className="size-4" />
                </Button>
              </div>
            ) : null}
            {activeThread ? (
            <div className={`min-w-0 w-full text-left lg:mx-auto lg:max-w-3xl ${!sidebarPinnedOpen ? editingTitle ? "max-lg:pl-16" : "max-lg:pl-24" : ""} ${
              editingTitle
                ? "max-lg:pr-3"
                : "pr-12"
            }`}>
              {editingTitle ? (
                <form className="flex min-w-0 items-center gap-2" onSubmit={renameActiveThread}>
                  <Input
                    autoFocus
                    className="h-8 min-w-0 flex-1 bg-card text-sm font-semibold"
                    maxLength={80}
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                  />
                  <Button className="h-7 px-2" size="sm" type="submit" variant="affirmative">
                    Save
                  </Button>
                  <Button
                    className="h-7 px-2 text-muted-foreground"
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setEditingTitle(false)}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="min-w-0 truncate text-left text-sm font-semibold">
                      {activeThread?.title || newThreadTitle || "New chat"}
                    </h2>
                    <Button
                      aria-label="Rename thread"
                      className="size-6 shrink-0 text-muted-foreground"
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setTitleDraft(activeThread?.title || newThreadTitle || "New chat");
                        setEditingTitle(true);
                      }}
                    >
                      <Pencil aria-hidden="true" className="size-3.5" />
                    </Button>
                  </div>
                  <div className={`mt-0.5 flex min-w-0 w-fit max-w-full items-center gap-0.5 overflow-hidden rounded px-1 font-mono text-[10px] text-muted-foreground ${
                    repositoryRequired ? "bg-warning-muted text-warning ring-2 ring-warning-border" : ""
                  }`}>
                    <FolderGit2 aria-hidden="true" className="mr-1 size-3 shrink-0" />
                    {activeThread ? (
                      <span className="min-w-0 truncate" data-tooltip={workspacePath}>{workspacePath}</span>
                    ) : desktop ? (
                      <button
                        className={`min-w-0 truncate rounded px-0.5 text-left hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${repositoryRequired ? "text-warning" : ""}`}
                        data-tooltip={workspacePath || "Select a repository"}
                        type="button"
                        onClick={async () => {
                          const selected = await desktop.selectRepository(workspacePath);
                          if (selected) setWorkspacePath(selected);
                        }}
                      >
                        {workspacePath || "Select a repository"}
                      </button>
                    ) : (
                      <label className="min-w-0 flex-1">
                        <span className="sr-only">Workspace path</span>
                        <input
                          className={`w-full bg-transparent outline-none ${repositoryRequired ? "text-warning" : ""}`}
                          placeholder="Workspace path"
                          value={workspacePath}
                          onChange={(event) => setWorkspacePath(event.target.value)}
                        />
                      </label>
                    )}
                  </div>
                </div>
              )}
            </div>
            ) : null}
            <div
              className={`absolute z-50 flex items-center gap-1 ${editingTitle ? "max-lg:hidden" : ""} ${desktopWindowControls ? "" : "right-3"}`}
              style={desktopWindowControls ? { right: `${144 / uiScale}px` } : undefined}
            >
              {updateReady || updateState.status === "downloading" ? (
                <Button
                  className="h-10 gap-2 disabled:opacity-100"
                  data-tooltip={updateTooltip}
                  disabled={!updateReady}
                  type="button"
                  variant={updateReady ? "affirmative" : "outline"}
                  onClick={restartToUpdate}
                >
                  {updateState.status === "downloading" && !updateReady
                    ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                    : <RefreshCw aria-hidden="true" className="size-4" />}
                  {updateReady ? "Update" : "Downloading…"}
                </Button>
              ) : null}
              <SettingsDialog controller={controller} />
            </div>
          </header>

          {!activeThread ? (
            <div className="relative z-30 col-start-1 row-start-2 self-end px-4 pb-2 sm:px-5">
              <div className="mx-auto w-full max-w-3xl px-3">
                {editingTitle ? (
                  <form className="flex min-w-0 items-center gap-2" onSubmit={renameActiveThread}>
                    <Input
                      autoFocus
                      className="h-8 min-w-0 flex-1 bg-card text-sm font-semibold"
                      maxLength={80}
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                    />
                    <Button className="h-7 px-2" size="sm" type="submit" variant="affirmative">Save</Button>
                    <Button className="h-7 px-2 text-muted-foreground" size="sm" type="button" variant="ghost" onClick={() => setEditingTitle(false)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <h2 className="min-w-0 truncate text-sm font-semibold">{newThreadTitle || "New chat"}</h2>
                      <Button
                        aria-label="Rename thread"
                        className="size-6 shrink-0 text-muted-foreground"
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setTitleDraft(newThreadTitle || "New chat");
                          setEditingTitle(true);
                        }}
                      >
                        <Pencil aria-hidden="true" className="size-3.5" />
                      </Button>
                    </div>
                    <div className={`mt-0.5 flex min-w-0 w-fit max-w-full items-center gap-0.5 overflow-hidden rounded px-1 font-mono text-[10px] text-muted-foreground ${
                      repositoryRequired ? "bg-warning-muted text-warning ring-2 ring-warning-border" : ""
                    }`}>
                      <FolderGit2 aria-hidden="true" className="mr-1 size-3 shrink-0" />
                      {desktop ? (
                        <button
                          className={`min-w-0 truncate rounded px-0.5 text-left hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${repositoryRequired ? "text-warning" : ""}`}
                          data-tooltip={workspacePath || "Select a repository"}
                          type="button"
                          onClick={async () => {
                            const selected = await desktop.selectRepository(workspacePath);
                            if (selected) setWorkspacePath(selected);
                          }}
                        >
                          {workspacePath || "Select a repository"}
                        </button>
                      ) : (
                        <label className="min-w-0 flex-1">
                          <span className="sr-only">Workspace path</span>
                          <input
                            className={`w-full bg-transparent outline-none ${repositoryRequired ? "text-warning" : ""}`}
                            placeholder="Workspace path"
                            value={workspacePath}
                            onChange={(event) => setWorkspacePath(event.target.value)}
                          />
                        </label>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <div
            className={`col-start-1 row-start-2 min-h-0 px-4 py-4 sm:px-5 ${!activeThread ? "hidden" : ""} ${
              activityBesideThread ? "" : "overflow-y-auto"
            }`}
            ref={conversationAreaRef}
            onScroll={(event) => {
              if (!activityBesideThread) conversationScrollTopRef.current = event.currentTarget.scrollTop;
            }}
          >
            <div
              className={`mx-auto grid min-h-0 w-full justify-center gap-4 ${
                activityBesideThread ? "h-full" : "min-h-full"
              }`}
              style={{
                gridTemplateColumns: activityBesideThread
                  ? "minmax(480px, 768px) var(--activity-width)"
                  : "minmax(0, 768px)",
                maxWidth: activityBesideThread
                  ? "calc(768px + var(--activity-width) + 16px)"
                  : "768px",
              }}
            >
              <div
                className={activityBesideThread ? "min-h-0 overflow-y-auto" : "min-h-0"}
                ref={threadScrollRef}
                onScroll={(event) => {
                  if (activityBesideThread) conversationScrollTopRef.current = event.currentTarget.scrollTop;
                }}
              >
                <div className="mx-auto w-full space-y-4">
              {threadTurns.length ? (
                threadTurns.map((turn, index) => {
                  const runEvents = turn.run_id
                    ? events.filter((runtimeEvent) => eventRunId(runtimeEvent) === turn.run_id)
                    : events;
                  const activityIterationCount = countIterations(runEvents);
                  const activityStart = turn.run_id ? runEvents.map(eventTime).find((time) => time !== null) : null;
                  const terminalEvent = [...runEvents].reverse().find((runtimeEvent) =>
                    runtimeEvent.type === "turn.failed" || runtimeEvent.type === "turn.stopped"
                    || (runtimeEvent.type === "turn.completed" && runtimeEvent.payload.status === "completed"),
                  );
                  const activityEnd = terminalEvent ? eventTime(terminalEvent)
                    : turn.run_id === runningRunId && status === "running" ? activityClock : null;
                  const activityDuration = activityStart !== null && activityStart !== undefined && activityEnd !== null
                    ? elapsedLabel(activityEnd - activityStart) : null;
                  const isLatestPrompt =
                    turn.role === "user" && !threadTurns.slice(index + 1).some((item) => item.role === "user");
                  const isSteered = turn.role === "user"
                    && Boolean(turn.run_id)
                    && threadTurns.slice(0, index).some(
                      (item) => item.role === "user" && item.run_id === turn.run_id,
                    );
                  const isLastUserTurnForRun = turn.role === "user"
                    && !threadTurns.slice(index + 1).some(
                      (item) => item.role === "user" && item.run_id === turn.run_id,
                    );
                  const failure = runEvents.find((runtimeEvent) => runtimeEvent.type === "turn.failed");
                  const modelFailed = failure && runEvents.some((runtimeEvent) =>
                    runtimeEvent.type === "model.started"
                    && runtimeEvent.payload.iteration === failure.payload.iteration,
                  ) && !runEvents.some((runtimeEvent) =>
                    runtimeEvent.type === "model.completed"
                    && runtimeEvent.payload.iteration === failure.payload.iteration,
                  );
                  const failureCode = String(failure?.payload.error ?? "").match(/\bHTTP (\d{3})\b/)?.[1];
                  const provider = modelInfo.get(turn.model_name ?? "")?.provider;
                  const providerLabel = provider ? provider[0].toUpperCase() + provider.slice(1) : "model";

                  return (
                    <Fragment key={turn.id}>
                      <article
                        className={
                          turn.role === "assistant"
                            ? "message-in"
                            : "message-in ml-auto max-w-[82%]"
                        }
                      >
                        {turn.role === "assistant" ? (
                          <div>
                            <AssistantMarkdown content={turn.content} />
                            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                              <time className="text-xs text-muted-foreground" dateTime={turn.created_at}>
                                {formatTimestamp(turn.created_at)}
                              </time>
                              <CopyButton className="!size-4 [&_svg]:!size-2.5" content={turn.content} />
                              {turn.model_name ? (
                                <>
                                  <span aria-hidden="true" className="size-1 rounded-full bg-border" />
                                  <span>{turn.model_name}</span>
                                </>
                              ) : null}
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="rounded-2xl rounded-br-md bg-secondary px-4 py-3.5 text-secondary-foreground">
                              <p className="whitespace-pre-wrap text-sm leading-6">{turn.content}</p>
                            </div>
                            <div className="mt-1 flex items-center justify-end gap-1.5 pr-1 text-xs text-muted-foreground">
                              {isSteered ? (
                                <span className="rounded bg-muted px-1.5 py-0.5 font-semibold text-muted-foreground">
                                  Steered
                                </span>
                              ) : null}
                              <time className="text-xs text-muted-foreground" dateTime={turn.created_at}>
                                {formatTimestamp(turn.created_at)}
                              </time>
                              <CopyButton className="!size-4 [&_svg]:!size-2.5" content={turn.content} />
                            </div>
                          </div>
                        )}
                      </article>
                      {isLastUserTurnForRun ? (
                        <>
                          <div className="flex items-center gap-3 py-1">
                            <Separator className="flex-1" />
                            <Button
                              className="h-6 gap-1.5 border border-transparent px-2 text-muted-foreground hover:border-border"
                              size="xs"
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                if (activityOpen && activityRunId === turn.run_id) {
                                  setActivityOpen(false);
                                  return;
                                }
                                setActivityRunId(turn.run_id);
                                setActivityOpen(true);
                              }}
                            >
                              <span>Activity</span>
                              <Badge className="h-4 rounded-sm px-1.5 py-px text-[10px] font-semibold">
                                {activityIterationCount}
                              </Badge>
                              <span className="text-muted-foreground/80">
                                {activityIterationCount === 1 ? "iteration" : "iterations"}
                              </span>
                              {activityDuration ? (
                                <span className="tabular-nums text-muted-foreground/80" data-tooltip="Run duration">
                                  · {activityDuration}
                                </span>
                              ) : null}
                            </Button>
                            <CopyButton
                              className="!size-6"
                              content={JSON.stringify(runEvents, null, 2)}
                              label="Copy activity"
                            />
                            {turn.finalized_by_iteration_limit || (finalizedByIterationLimit && isLatestPrompt) ? (
                              <Badge className="bg-warning-muted text-warning">
                                Limit reached
                              </Badge>
                            ) : null}
                            <Separator className="flex-1" />
                          </div>
                          {activityOpen && activityStacked && activityRunId === turn.run_id
                            ? <ActivityIsland {...activityProps} resizable={false} />
                            : null}
                          {turn.run_id && failure ? (
                            <Card className="message-in flex items-start gap-2 rounded-xl border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground shadow-none" role="alert">
                              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
                              <span>
                                {modelFailed ? `The ${providerLabel} model request failed` : "This run failed"}
                                {failureCode ? ` (HTTP ${failureCode})` : ""}. Please try again.
                              </span>
                            </Card>
                          ) : null}
                        </>
                      ) : null}
                    </Fragment>
                  );
                })
              ) : null}
              {status === "running" && assistantText ? (
                <article className="message-in">
                  <AssistantMarkdown content={assistantText} />
                </article>
              ) : null}
              {continuationRequest && activeThread?.id === runningThreadId ? (
                <Card className="message-in rounded-xl border-warning-border bg-warning-muted p-4 text-warning shadow-none" role="status">
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      answerContinuation(true);
                    }}
                  >
                    <p className="text-sm font-semibold">Continue running?</p>
                    <p className="mt-1 text-sm leading-6 text-warning/85">
                      {continuationRequest.reason === "time_limit"
                        ? `This run has been active for ${Math.round((continuationRequest.ceiling_seconds ?? 1800) / 60)} minutes. Continue for another interval, or stop and generate a final response now.`
                        : continuationRequest.reason === "repeated_failure"
                          ? `${continuationRequest.tool_name ?? "A tool"} failed ${continuationRequest.repeat_count ?? 3} times with the same arguments. Continue, or stop and generate a final response now.`
                          : `The harness completed ${continuationRequest.completed_iterations} iterations. Continue for up to ${continuationRequest.additional_iterations} more, or stop and generate a final response now.`}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button type="submit" variant="affirmative">Continue</Button>
                      <Button type="button" variant="outline" onClick={() => answerContinuation(false)}>
                        Stop and summarize
                      </Button>
                    </div>
                  </form>
                </Card>
              ) : null}
              {!viewingOtherThreadDuringRun ? queuedTasks.map((queuedTask) => (
                <article className="message-in ml-auto max-w-[82%]" key={queuedTask.id}>
                  <div>
                    <div
                      aria-disabled="true"
                      className="rounded-2xl rounded-br-md border border-dashed bg-muted/60 px-4 py-3.5 text-muted-foreground"
                    >
                      <p className="whitespace-pre-wrap text-sm leading-6">{queuedTask.content}</p>
                    </div>
                    <div className="mt-1 flex items-center justify-end gap-1.5 pr-1 text-xs text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-semibold text-muted-foreground">
                        Queued
                      </span>
                      <time className="text-xs text-muted-foreground" dateTime={queuedTask.createdAt}>
                        {formatTimestamp(queuedTask.createdAt)}
                      </time>
                      <Button
                        aria-label="Steer queued message now"
                        className="!size-4 text-muted-foreground opacity-60 hover:text-foreground hover:opacity-100 [&_svg]:!size-2.5"
                        disabled={status !== "running" || stopping}
                        size="icon-sm"
                        data-tooltip="Steer now"
                        type="button"
                        variant="ghost"
                        onClick={() => steerQueuedTask(queuedTask.id)}
                      >
                        <ChevronUp aria-hidden="true" />
                      </Button>
                      <CopyButton
                        className="!size-4 [&_svg]:!size-2.5"
                        content={queuedTask.content}
                        label="Copy queued message"
                      />
                      <Button
                        aria-label="Delete queued message"
                        className="!size-4 text-muted-foreground opacity-60 hover:text-destructive hover:opacity-100 [&_svg]:!size-2.5"
                        size="icon-sm"
                        data-tooltip="Delete queued message"
                        type="button"
                        variant="ghost"
                        onClick={() => deleteQueuedTask(queuedTask.id)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </article>
              )) : null}
              <div ref={conversationBottomRef} />
                </div>
              </div>
              {activityBesideThread ? <ActivityIsland {...activityProps} resizable /> : null}
            </div>
          </div>

          <form ref={composerRef} className={`relative z-30 col-start-1 row-start-3 bg-background px-4 py-3 sm:px-5 ${activeThread ? "border-t" : ""}`} onSubmit={startRun}>
            <Card className={`@container/composer mx-auto w-full max-w-3xl rounded-2xl p-2 shadow-sm transition-shadow focus-within:shadow-md ${
              status === "connecting" || status === "running" ? "composer-running" : ""
            }`}>
              <Textarea
                ref={taskInputRef}
                rows={1}
                className="min-h-10 max-h-60 resize-none overflow-y-auto border-0 bg-transparent px-3 py-2 text-sm leading-6 shadow-none [field-sizing:content] focus-visible:ring-0"
                disabled={viewingOtherThreadDuringRun}
                placeholder={composerPlaceholder}
                value={task}
                onChange={(event) => setTask(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  if (status === "running") {
                    if (event.shiftKey) return;
                    event.preventDefault();
                    const alternateAction = midRunEnterAction === "queue" ? "steer" : "queue";
                    performMidRunAction(event.ctrlKey || event.metaKey ? alternateAction : midRunEnterAction);
                    return;
                  }
                  if (status === "connecting") {
                    if (event.shiftKey) return;
                    event.preventDefault();
                    queueTask();
                    return;
                  }
                  const shouldSend = sendOnEnter ? !event.shiftKey : event.shiftKey;
                  if (!shouldSend) return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
              />
              <div className="mt-1 flex min-w-0 items-center gap-1.5 border-t border-border px-1 pt-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {workspacePath.trim() ? (
                <div className="flex min-w-0 items-stretch overflow-hidden rounded-lg border bg-card text-xs text-muted-foreground">
                    <Button
                      aria-label={`${gitVisible ? "Close" : "Open"} Git panel, branch ${gitBranchLabel}, ${gitChangedFileCount} changed files, ${gitStatus?.ahead ?? 0} ahead and ${gitStatus?.behind ?? 0} behind`}
                      aria-pressed={gitVisible}
                      className={`h-8 max-w-56 min-w-0 gap-1.5 rounded-none px-2 font-mono text-[10px] font-semibold @max-[640px]/composer:max-w-40 @max-[400px]/composer:px-1.5 ${
                        !gitStatusLoading && !gitTracked
                          ? "bg-warning-muted text-warning hover:bg-warning-muted/80"
                          : "text-muted-foreground"
                      }`}
                      data-tooltip={gitTracked ? `Branch: ${gitBranchLabel} · ${gitChangedFileCount} changed · ${gitStatus?.ahead ?? 0} ahead · ${gitStatus?.behind ?? 0} behind` : "This path is not tracked by Git"}
                      type="button"
                      variant="ghost"
                      onClick={toggleGitPanel}
                    >
                      <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="truncate @max-[340px]/composer:hidden">{gitBranchLabel}</span>
                      {gitChangedFileCount ? (
                        <span className="flex items-center gap-1 text-warning @max-[400px]/composer:hidden">
                          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{gitChangedFileCount}
                        </span>
                      ) : null}
                      {gitStatus?.ahead ? <span className="@max-[400px]/composer:hidden">
                        <ChevronUp aria-hidden="true" className="inline size-3" />{gitStatus?.ahead ?? 0}
                      </span> : null}
                      {gitStatus?.behind ? <span className="@max-[400px]/composer:hidden">
                        <ChevronDown aria-hidden="true" className="inline size-3" />{gitStatus?.behind ?? 0}
                      </span> : null}
                    </Button>
                </div>
                ) : null}
                {contextAvailable ? (
                  <Button
                    aria-label={`${contextVisible ? "Close" : "Open"} context, ${Math.round(contextUsage)}% of budget used`}
                    aria-pressed={contextVisible}
                    className="size-8 shrink-0 border border-border bg-card text-muted-foreground hover:bg-muted"
                    size="icon-sm"
                    data-tooltip={`Context: ${Math.round(contextUsage)}% used`}
                    type="button"
                    variant={contextVisible ? "secondary" : "outline"}
                    onClick={toggleContextPanel}
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-5 items-center justify-center rounded-full p-[2.5px]"
                      style={{ background: `conic-gradient(var(--foreground) ${contextUsage}%, var(--border) 0)` }}
                    >
                      <span className="size-full rounded-full bg-card" />
                    </span>
                  </Button>
                ) : null}
                <label className="min-w-0 text-xs text-muted-foreground">
                  <span className="sr-only">Model</span>
                  {availableModels.length ? (
                    <SelectPrimitive.Root
                    open={modelPickerOpen}
                    value={modelName}
                    onOpenChange={setModelPickerOpen}
                    onValueChange={(value) => value && setModelName(value as string)}
                  >
                    <SelectPrimitive.Trigger
                      aria-label={modelName ? `Model: ${modelName}` : "Choose model"}
                      data-tooltip={modelName || "Choose model"}
                      className={`flex h-8 w-36 max-w-full min-w-0 cursor-pointer items-center justify-start gap-1.5 rounded-lg border border-border bg-card px-2.5 text-left text-xs outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 @max-[640px]/composer:w-28 @max-[400px]/composer:w-20 @max-[400px]/composer:px-1.5 @max-[340px]/composer:w-16 ${
                        modelRequired
                          ? "bg-warning-muted text-warning ring-2 ring-warning-border"
                          : "bg-transparent"
                      }`}
                    >
                      <SelectPrimitive.Value className="min-w-0 flex-1 truncate text-left" placeholder="Choose model" />
                      <SelectPrimitive.Icon render={<ChevronUp className="size-4 shrink-0 text-muted-foreground @max-[400px]/composer:hidden" />} />
                    </SelectPrimitive.Trigger>
                    <SelectPrimitive.Portal>
                      <SelectPrimitive.Positioner alignItemWithTrigger sideOffset={4} className="z-50">
                        <SelectPrimitive.Popup className="min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
                          <SelectPrimitive.List>
                            {availableModels.map((model, index) => (
                              <Fragment key={model}>
                                {index > 0 && modelInfo.get(availableModels[index - 1])?.provider !== modelInfo.get(model)?.provider
                                  ? <Separator className="my-1" /> : null}
                                <SelectPrimitive.Item
                                  className="relative flex cursor-default items-center rounded-md py-1.5 pr-8 pl-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
                                  value={model}
                                >
                                  <SelectPrimitive.ItemText>{model}</SelectPrimitive.ItemText>
                                  <SelectPrimitive.ItemIndicator
                                    className="absolute right-2"
                                    render={<Check className="size-4" />}
                                  />
                                </SelectPrimitive.Item>
                              </Fragment>
                            ))}
                            {availableModels.length ? <Separator className="my-1" /> : null}
                            <Button
                              className="h-8 w-full justify-start gap-2 px-2 text-xs"
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                setModelPickerOpen(false);
                                openSettings();
                              }}
                            >
                              <Settings2 aria-hidden="true" className="size-3.5" /> Set API key
                            </Button>
                          </SelectPrimitive.List>
                        </SelectPrimitive.Popup>
                      </SelectPrimitive.Positioner>
                    </SelectPrimitive.Portal>
                    </SelectPrimitive.Root>
                  ) : (
                    <Button
                      className={`h-8 w-36 max-w-full min-w-0 justify-between border border-border px-2.5 text-left text-xs font-normal @max-[640px]/composer:w-28 @max-[400px]/composer:w-20 @max-[400px]/composer:px-1.5 @max-[340px]/composer:w-16 ${
                        modelRequired
                          ? "bg-warning-muted text-warning ring-2 ring-warning-border hover:bg-warning-muted/80"
                          : "text-muted-foreground"
                      }`}
                      type="button"
                      variant="ghost"
                      onClick={openSettings}
                    >
                      <span className="min-w-0 truncate">Set API key</span>
                      <Settings2 aria-hidden="true" className="size-4 @max-[400px]/composer:hidden" />
                    </Button>
                  )}
                </label>
                </div>
                {(status === "connecting" || status === "running") && queuedTasks.length > 0 ? (
                  <span className="shrink-0 text-xs font-medium text-muted-foreground @max-[640px]/composer:hidden" role="status">
                    {queuedTasks.length} queued
                  </span>
                ) : null}
                {status === "connecting" || status === "running" ? (
                  <>
                    <Button
                      aria-label={stopping ? "Stopping run" : "Stop run"}
                      data-tooltip={stopping ? "Stopping run" : "Stop run"}
                      className="size-8 bg-card"
                      disabled={stopping}
                      size="icon-sm"
                      type="button"
                      variant="outline"
                      onClick={stopRun}
                    >
                      {stopping ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : <Square aria-hidden="true" className="size-3.5 fill-current" />}
                    </Button>
                    {task.trim() ? (
                      <div className="flex shrink-0 items-center">
                        <Button
                          aria-label={activeRunEnterAction === "queue" ? "Queue message, Enter" : "Steer run, Enter"}
                          className="h-8 rounded-r-none px-3 text-xs font-semibold capitalize @max-[400px]/composer:w-8 @max-[400px]/composer:px-0"
                          disabled={stopping || viewingOtherThreadDuringRun}
                          size="sm"
                          type="button"
                          data-tooltip={`${activeRunEnterAction === "queue" ? "Queue" : "Steer"} (Enter)`}
                          variant="affirmative"
                          onClick={activeRunEnterAction === "queue" ? queueTask : steerRun}
                        >
                          {activeRunEnterAction === "queue" ? <ListPlus aria-hidden="true" className="size-3.5" /> : <CornerUpRight aria-hidden="true" className="size-3.5" />}
                          <span className="@max-[400px]/composer:hidden">{activeRunEnterAction}</span>
                        </Button>
                        <MenuPrimitive.Root>
                          <MenuPrimitive.Trigger
                            render={<Button
                              aria-label="Other run action"
                              className="h-8 w-7 rounded-l-none border-l border-affirmative-foreground/20 px-0 text-affirmative-foreground"
                              disabled={stopping || viewingOtherThreadDuringRun}
                              size="sm"
                              type="button"
                              variant="affirmative"
                            />}
                          >
                            <ChevronDown aria-hidden="true" className="size-3.5" />
                          </MenuPrimitive.Trigger>
                          <MenuPrimitive.Portal>
                            <MenuPrimitive.Positioner side="top" align="end" sideOffset={6} className="z-50">
                              <MenuPrimitive.Popup className="min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md outline-none">
                                <MenuPrimitive.Item
                                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs outline-none data-[highlighted]:bg-accent data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
                                  disabled={alternateRunEnterAction === "steer" && status !== "running"}
                                  onClick={alternateRunEnterAction === "queue" ? queueTask : steerRun}
                                >
                                  {alternateRunEnterAction === "queue" ? <ListPlus aria-hidden="true" className="size-3.5" /> : <CornerUpRight aria-hidden="true" className="size-3.5" />}
                                  <span className="capitalize">{alternateRunEnterAction}</span>
                                  <span className="ml-auto text-muted-foreground">{SHORTCUT_LABEL}+Enter</span>
                                </MenuPrimitive.Item>
                              </MenuPrimitive.Popup>
                            </MenuPrimitive.Positioner>
                          </MenuPrimitive.Portal>
                        </MenuPrimitive.Root>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <Button
                    aria-label="Send message"
                    data-tooltip="Send message"
                    className="size-8 text-xs font-semibold"
                    disabled={!task.trim() || !modelName || (!activeThread && !workspacePath.trim())}
                    size="icon-sm"
                    type="submit"
                    variant="affirmative"
                  >
                    <Send aria-hidden="true" className="size-3.5" />
                  </Button>
                )}
              </div>
            </Card>
          </form>

        </section>

        {gitDiff ? (
          <aside
            aria-label={`Diff for ${gitDiff.path}`}
            className="fixed inset-x-0 top-14 bottom-0 z-30 flex min-h-0 flex-col border-l bg-background lg:relative lg:inset-auto lg:col-start-3 lg:z-auto lg:w-[var(--diff-column-width)] lg:pt-14"
            ref={diffPanelRef}
            style={narrowView ? { bottom: composerHeight } : undefined}
          >
            <div
              aria-label="Resize diff panel"
              className="group absolute inset-y-0 -left-1 z-30 hidden w-2 cursor-col-resize touch-none lg:block"
              role="separator"
              onDoubleClick={() => setDiffWidth(DEFAULT_DIFF_WIDTH)}
              onPointerCancel={() => (resizeRef.current = null)}
              onPointerDown={(event) => startResize("diff", event)}
              onPointerMove={resizePanel}
              onPointerUp={() => (resizeRef.current = null)}
            >
              <span className="absolute inset-y-0 left-1/2 w-px bg-transparent group-hover:bg-border" />
            </div>
            <header className="flex h-14 shrink-0 items-center gap-3 border-b px-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs font-medium text-foreground" data-tooltip={gitDiff.path}>
                  {gitPathParts(gitDiff.path).fileName}
                  {gitPathParts(gitDiff.path).relativeDirectory ? (
                    <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                      {gitPathParts(gitDiff.path).relativeDirectory}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {gitDiff.staged ? "Staged changes" : "Working tree changes"}
                </p>
              </div>
              <div className="flex shrink-0 items-center rounded-lg border bg-card p-0.5">
                {gitDiffCanSplit ? (
                  <Button
                    aria-label={gitDiffSplit ? "Use unified diff" : "Use split diff"}
                    aria-pressed={gitDiffSplit}
                    className="size-7 rounded-md text-muted-foreground"
                    size="icon-sm"
                    data-tooltip={gitDiffSplit ? "Use unified view" : "Use split view"}
                    type="button"
                    variant={gitDiffSplit ? "secondary" : "ghost"}
                    onClick={() => setGitDiffSplit((split) => !split)}
                  >
                    <Columns2 aria-hidden="true" className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  aria-label={gitDiffShowUnchanged ? "Hide unchanged regions" : "Show unchanged regions"}
                  aria-pressed={gitDiffShowUnchanged}
                  className="size-7 rounded-md text-muted-foreground"
                  size="icon-sm"
                  data-tooltip={gitDiffShowUnchanged ? "Hide unchanged regions" : "Show unchanged regions"}
                  type="button"
                  variant={gitDiffShowUnchanged ? "secondary" : "ghost"}
                  onClick={() => {
                    const showUnchanged = !gitDiffShowUnchanged;
                    setGitDiffShowUnchanged(showUnchanged);
                    void openGitDiff(
                      { path: gitDiff.path, status: "" },
                      gitDiff.staged,
                      showUnchanged,
                    );
                  }}
                >
                  <UnfoldVertical aria-hidden="true" className="size-3.5" />
                </Button>
                <Button
                  aria-label={gitDiffWrap ? "Disable word wrap" : "Enable word wrap"}
                  aria-pressed={gitDiffWrap}
                  className="size-7 rounded-md text-muted-foreground"
                  size="icon-sm"
                  data-tooltip={gitDiffWrap ? "Disable word wrap" : "Enable word wrap"}
                  type="button"
                  variant={gitDiffWrap ? "secondary" : "ghost"}
                  onClick={() => setGitDiffWrap((wrap) => !wrap)}
                >
                  <WrapText aria-hidden="true" className="size-3.5" />
                </Button>
              </div>
              <Button
                aria-label="Close diff"
                className="size-8 shrink-0 text-muted-foreground"
                size="icon-sm"
                data-tooltip="Close diff"
                type="button"
                variant="ghost"
                onClick={closeGitDiff}
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </header>
            <div className="min-h-0 flex-1 overflow-auto bg-card">
              {gitDiff.patch === null ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading diff...
                </div>
              ) : (
                <Suspense fallback={(
                  <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Preparing diff...
                  </div>
                )}>
                  <GitDiffContents
                    appearance={appearance}
                    diff={{ ...gitDiff, patch: gitDiff.patch }}
                    split={gitDiffSplit && gitDiffCanSplit}
                    wrap={gitDiffWrap}
                  />
                </Suspense>
              )}
            </div>
          </aside>
        ) : null}

        <SidePanels controller={controller} />
      </section>
      {shortcutsOpen ? (
        <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-black/15 p-4 backdrop-blur-[1px]">
          <Card className="w-full max-w-sm rounded-xl p-0 shadow-xl">
            <div className="border-b px-4 py-3">
              <p className="text-sm font-semibold">Keyboard shortcuts</p>
              <p className="mt-1 text-xs text-muted-foreground">Release {SHORTCUT_LABEL} to close.</p>
            </div>
            <div className="max-h-[calc(100vh-7rem)] overflow-y-auto px-4 pb-3">
              <section>
                <p className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Threads &amp; panels
                </p>
                <div>
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>New thread in current path</span>
                <ShortcutKeys keys={[SHORTCUT_LABEL, "T"]} />
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>New thread without path</span>
                <ShortcutKeys keys={[SHORTCUT_LABEL, "N"]} />
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>Refresh current thread</span>
                <ShortcutKeys keys={[SHORTCUT_LABEL, "R"]} />
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>Close activity</span>
                <ShortcutKeys keys={["Esc"]} />
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>Toggle threads</span>
                <ShortcutKeys keys={[SHORTCUT_LABEL, "B"]} />
              </div>
                </div>
              </section>
              <section className="border-t">
                <p className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Message input
                </p>
                <div>
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>Send message</span>
                <ShortcutKeys keys={sendOnEnter ? ["Enter"] : ["Shift", "Enter"]} />
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>New line</span>
                <ShortcutKeys keys={sendOnEnter ? ["Shift", "Enter"] : ["Enter"]} />
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>{midRunEnterAction === "queue" ? "Queue during run" : "Steer during run"}</span>
                <ShortcutKeys keys={["Enter"]} />
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>{midRunEnterAction === "queue" ? "Steer during run" : "Queue during run"}</span>
                <ShortcutKeys keys={[SHORTCUT_LABEL, "Enter"]} />
              </div>
                </div>
              </section>
              {desktop ? (
                <section className="border-t">
                  <p className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    View
                  </p>
                  <div>
                  <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                    <span>Zoom in</span>
                    <ShortcutKeys keys={[SHORTCUT_LABEL, "="]} />
                  </div>
                  <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                    <span>Zoom out</span>
                    <ShortcutKeys keys={[SHORTCUT_LABEL, "-"]} />
                  </div>
                  <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                    <span>Reset zoom</span>
                    <ShortcutKeys keys={[SHORTCUT_LABEL, "0"]} />
                  </div>
                  </div>
                </section>
              ) : null}
            </div>
          </Card>
        </div>
      ) : null}
      <AlertDialogPrimitive.Root open={Boolean(undoCommitWarning)} onOpenChange={(open) => { if (!open && !gitMutation) setUndoCommitWarning(null); }}>
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/30" />
          <AlertDialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <AlertDialogPrimitive.Popup className="w-full max-w-md rounded-xl border bg-card p-5 text-card-foreground shadow-xl outline-none">
              <AlertDialogPrimitive.Title className="text-base font-semibold">Undo last unsynced commit?</AlertDialogPrimitive.Title>
              <AlertDialogPrimitive.Description className="mt-2 text-sm leading-6 text-muted-foreground">
                You already have staged changes. Continuing removes the last commit and keeps its changes staged alongside your current staged changes. Your working files stay unchanged.
              </AlertDialogPrimitive.Description>
              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={Boolean(gitMutation)} onClick={() => setUndoCommitWarning(null)}>Cancel</Button>
                <Button type="button" disabled={Boolean(gitMutation)} onClick={() => { if (undoCommitWarning) void undoLastCommit(undoCommitWarning, true); }}>Continue anyway</Button>
              </div>
            </AlertDialogPrimitive.Popup>
          </AlertDialogPrimitive.Viewport>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
      <AlertDialogPrimitive.Root
        open={Boolean(threadToDelete || branchSwitchError || error)}
        onOpenChange={(open) => {
          if (!open) {
            setThreadToDelete(null);
            setBranchSwitchError(null);
            setError("");
          }
        }}
      >
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Backdrop
            className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[1px]"
            onClick={() => {
              setThreadToDelete(null);
              setBranchSwitchError(null);
              setError("");
            }}
          />
          <AlertDialogPrimitive.Viewport
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return;
              setThreadToDelete(null);
              setBranchSwitchError(null);
              setError("");
            }}
          >
            <AlertDialogPrimitive.Popup className="w-full min-w-0 max-w-md overflow-hidden rounded-xl border bg-card p-5 text-card-foreground shadow-xl outline-none">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (threadToDelete) void deleteThread();
                  else if (branchSwitchError) setBranchSwitchError(null);
                  else setError("");
                }}
              >
                <AlertDialogPrimitive.Title className="flex items-center gap-2 text-base font-semibold">
                  {branchSwitchError ? <GitBranch aria-hidden="true" className="size-4 text-warning" /> : null}
                  {threadToDelete
                    ? "Delete thread?"
                    : branchSwitchError ? `Couldn’t switch to ${branchSwitchError.to}` : "Something went wrong"}
                </AlertDialogPrimitive.Title>
                <AlertDialogPrimitive.Description className="mt-2 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-muted-foreground">
                  {threadToDelete
                    ? `This will permanently delete "${threadToDelete.title}" and its activity.`
                    : branchSwitchError ? (
                      <>
                        <span className="block text-foreground">
                          {branchSwitchError.message}
                        </span>
                        {branchSwitchError.files.length ? (
                          <span className="mt-3 block">
                            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Blocking changes
                            </span>
                            <span className="block max-h-40 overflow-y-auto rounded-lg border bg-card">
                              {branchSwitchError.files.map((file) => {
                                const { fileName, relativeDirectory } = gitPathParts(file);
                                return (
                                  <span className="flex min-w-0 items-center px-2.5 py-1 font-mono text-xs" key={file} data-tooltip={file}>
                                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                      <span className="text-foreground">{fileName}</span>
                                      {relativeDirectory ? (
                                        <span className="ml-2 text-[10px] text-muted-foreground">{relativeDirectory}</span>
                                      ) : null}
                                    </span>
                                  </span>
                                );
                              })}
                            </span>
                          </span>
                        ) : null}
                        <span className="mt-3 block">
                          {branchSwitchError.canForce
                            ? "Force switch discards tracked changes; blocking untracked files may be removed."
                            : "Resolve these changes and try again."}
                        </span>
                      </>
                    ) : error}
                </AlertDialogPrimitive.Description>
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  {!threadToDelete && !branchSwitchError ? (
                    <CopyButton className="mr-auto" content={error} label="Copy error" />
                  ) : null}
                  {branchSwitchError ? (
                    <Button
                      className="mr-auto"
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setBranchSwitchError(null);
                        void loadGitStatus();
                        if (narrowView) openPanelPreview("git");
                        else {
                          setGitOpen(true);
                          setGitPreviewOpen(false);
                        }
                      }}
                    >
                      Open Git
                    </Button>
                  ) : null}
                  {threadToDelete ? (
                    <AlertDialogPrimitive.Close
                      render={<Button type="button" variant="outline">Cancel</Button>}
                    />
                  ) : null}
                  {branchSwitchError?.canForce ? (
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => {
                        const targetBranch = branchSwitchError.to;
                        setBranchSwitchError(null);
                        void switchGitBranch(targetBranch, true);
                      }}
                    >
                      Force switch
                    </Button>
                  ) : null}
                  <Button type="submit" variant={threadToDelete ? "destructive" : "default"}>
                    {threadToDelete ? "Delete" : branchSwitchError ? "Cancel" : "Dismiss"}
                  </Button>
                </div>
              </form>
            </AlertDialogPrimitive.Popup>
          </AlertDialogPrimitive.Viewport>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </main>
  );
}
