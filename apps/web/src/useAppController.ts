import {
  FormEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import webPackage from "../package.json";
import { useGitController } from "@/useGitController";

import {
  ACTIVITY_LAYOUT_GAP,
  CONVERSATION_HORIZONTAL_GUTTER,
  DEFAULT_ACTIVITY_WIDTH,
  DEFAULT_CONTEXT_WIDTH,
  DEFAULT_DIFF_WIDTH,
  DEFAULT_GIT_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  GIT_REFRESH_INTERVAL_MS,
  IS_MAC,
  LARGE_DIFF_SIDEBAR_BREAKPOINT,
  MAX_ACTIVITY_WIDTH,
  MAX_CONTEXT_WIDTH,
  MAX_DIFF_WIDTH,
  MAX_GIT_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_ACTIVITY_WIDTH,
  MIN_SPLIT_DIFF_WIDTH,
  MIN_THREAD_WIDTH_WITH_ACTIVITY,
  SHORTCUT_KEY,
  clampActivityWidth,
  clampDiffWidth,
  eventRunId,
  readJson,
  selectableModel,
  validAppearance,
  validMidRunEnterAction,
  validThreadSort,
  type Appearance,
  type BranchSwitchError,
  type ContextState,
  type GitCommitState,
  type GitFileState,
  type GitDiffState,
  type GitGroup,
  type GitStatusState,
  type MidRunEnterAction,
  type ModelOption,
  type PreviewPanel,
  type QueuedTask,
  type RunSocketMessage,
  type RuntimeEvent,
  type ThreadDetail,
  type ThreadSort,
  type ThreadSummary,
  type ThreadTurn,
} from "@/appShared";

export function useAppController() {
  // Persistent settings, thread data, panel state, and transient run state.
  const desktop = window.harnessDesktop;
  const macDesktop = desktop?.platform === "darwin";
  const desktopWindowControls = Boolean(desktop && !macDesktop);
  const [task, setTask] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ModelOption[]>([]);
  const [apiKey, setApiKey] = useState(() =>
    desktop ? "" : sessionStorage.getItem("gemini-api-key") || "",
  );
  const [sarvamApiKey, setSarvamApiKey] = useState(() =>
    desktop ? "" : sessionStorage.getItem("sarvam-api-key") || "",
  );
  const [maxIterations, setMaxIterations] = useState(() =>
    desktop ? 50 : Math.min(Math.max(Number(localStorage.getItem("max-iterations")) || 50, 1), 50),
  );
  const [timeoutMinutes, setTimeoutMinutes] = useState(() =>
    desktop ? 30 : Math.min(Math.max(Number(localStorage.getItem("timeout-minutes")) || 30, 1), 1440),
  );
  const [sendOnEnter, setSendOnEnter] = useState(
    () => Boolean(desktop) || localStorage.getItem("send-on-enter") !== "false",
  );
  const [midRunEnterAction, setMidRunEnterAction] = useState<MidRunEnterAction>(() =>
    desktop ? "queue" : validMidRunEnterAction(localStorage.getItem("mid-run-enter-action")),
  );
  const [uiScale, setUiScale] = useState(1);
  const [appearance, setAppearance] = useState<Appearance>(() =>
    desktop ? "light" : validAppearance(localStorage.getItem("appearance")),
  );
  const [settingsLoaded, setSettingsLoaded] = useState(!desktop);
  const [status, setStatus] = useState("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey);
  const [sarvamApiKeyDraft, setSarvamApiKeyDraft] = useState(sarvamApiKey);
  const [maxIterationsDraft, setMaxIterationsDraft] = useState(String(maxIterations));
  const [maxIterationsError, setMaxIterationsError] = useState("");
  const [timeoutMinutesDraft, setTimeoutMinutesDraft] = useState(String(timeoutMinutes));
  const [timeoutMinutesError, setTimeoutMinutesError] = useState("");
  const [sendOnEnterDraft, setSendOnEnterDraft] = useState(sendOnEnter);
  const [midRunEnterActionDraft, setMidRunEnterActionDraft] = useState(midRunEnterAction);
  const [uiScaleDraft, setUiScaleDraft] = useState(uiScale);
  const [appearanceDraft, setAppearanceDraft] = useState<Appearance>(appearance);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string>();
  const [updateState, setUpdateState] = useState<DesktopUpdateState>({ status: "idle" });
  const [updateCooldownActive, setUpdateCooldownActive] = useState(false);
  useEffect(() => {
    const remaining = (updateState.retryAfter ?? 0) - Date.now();
    setUpdateCooldownActive(remaining > 0);
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setUpdateCooldownActive(false), remaining);
    return () => window.clearTimeout(timer);
  }, [updateState.retryAfter]);
  const [appVersion, setAppVersion] = useState(webPackage.version);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<ThreadSummary | null>(null);
  const [runningThreadId, setRunningThreadId] = useState<string | null>(null);
  const [runningRunId, setRunningRunId] = useState<string | null>(null);
  const [threadToDelete, setThreadToDelete] = useState<ThreadSummary | null>(null);
  const [threadTurns, setThreadTurns] = useState<ThreadTurn[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [collapsedActivityGroups, setCollapsedActivityGroups] = useState<Record<string, boolean>>({});
  const [threadContext, setThreadContext] = useState<ContextState | null>(null);
  const [expandedContextEntries, setExpandedContextEntries] = useState<Record<number, string | null>>({});
  const [assistantText, setAssistantText] = useState("");
  const [queuedTasks, setQueuedTasks] = useState<QueuedTask[]>([]);
  const [stopping, setStopping] = useState(false);
  const [activityClock, setActivityClock] = useState(Date.now());
  const [activityOpen, setActivityOpen] = useState(false);
  const [conversationAreaWidth, setConversationAreaWidth] = useState(0);
  const [contextOpen, setContextOpen] = useState(() =>
    !desktop && localStorage.getItem("context-open") === "true",
  );
  const [gitOpen, setGitOpen] = useState(() =>
    !desktop && localStorage.getItem("git-open") === "true",
  );
  const [narrowView, setNarrowView] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  const [largeDiffViewport, setLargeDiffViewport] = useState(() =>
    window.matchMedia(`(min-width: ${LARGE_DIFF_SIDEBAR_BREAKPOINT}px)`).matches,
  );
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [contextClosing, setContextClosing] = useState(false);
  const [gitPreviewOpen, setGitPreviewOpen] = useState(false);
  const [gitClosing, setGitClosing] = useState(false);
  
  
  
  
  
  const [gitDiffWrap, setGitDiffWrap] = useState(() =>
    !desktop && localStorage.getItem("git-diff-wrap") === "true",
  );
  const [gitDiffSplit, setGitDiffSplit] = useState(() =>
    !desktop && localStorage.getItem("git-diff-split") === "true",
  );
  const [gitDiffShowUnchanged, setGitDiffShowUnchanged] = useState(() =>
    !desktop && localStorage.getItem("git-diff-show-unchanged") === "true",
  );
  const [renderedDiffWidth, setRenderedDiffWidth] = useState(0);
  const [composerHeight, setComposerHeight] = useState(0);
  
  
  
  const [collapsedGitGroups, setCollapsedGitGroups] = useState<Record<GitGroup, boolean>>({
    staged: false,
    changes: false,
    commits: false,
  });
  const [activityRunId, setActivityRunId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    !desktop && localStorage.getItem("sidebar-collapsed") === "true",
  );
  const [sidebarPreviewOpen, setSidebarPreviewOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    desktop
      ? DEFAULT_SIDEBAR_WIDTH
      : Math.min(
          Math.max(Number(localStorage.getItem("sidebar-width")) || DEFAULT_SIDEBAR_WIDTH, 220),
          MAX_SIDEBAR_WIDTH,
        ),
  );
  const [activityWidth, setActivityWidth] = useState(() =>
    desktop
      ? DEFAULT_ACTIVITY_WIDTH
      : clampActivityWidth(Number(localStorage.getItem("activity-width"))),
  );
  const [contextWidth, setContextWidth] = useState(() =>
    desktop
      ? DEFAULT_CONTEXT_WIDTH
      : Math.min(
          Math.max(Number(localStorage.getItem("context-width")) || DEFAULT_CONTEXT_WIDTH, 280),
          MAX_CONTEXT_WIDTH,
        ),
  );
  const [gitWidth, setGitWidth] = useState(() =>
    desktop
      ? DEFAULT_GIT_WIDTH
      : Math.min(
          Math.max(Number(localStorage.getItem("git-width")) || DEFAULT_GIT_WIDTH, 280),
          MAX_GIT_WIDTH,
        ),
  );
  const [diffWidth, setDiffWidth] = useState(() =>
    desktop ? DEFAULT_DIFF_WIDTH : clampDiffWidth(Number(localStorage.getItem("git-diff-width"))),
  );
  const [threadSort, setThreadSort] = useState<ThreadSort>(() =>
    desktop ? "recent-message" : validThreadSort(localStorage.getItem("thread-sort")),
  );
  const [groupThreadsByPath, setGroupThreadsByPath] = useState(
    () => !desktop && localStorage.getItem("group-threads-by-path") === "true",
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [newThreadTitle, setNewThreadTitle] = useState<string | null>(null);
  const [finalizedByIterationLimit, setFinalizedByIterationLimit] = useState(false);
  const [continuationRequest, setContinuationRequest] = useState<{
    iteration: number;
    completed_iterations: number;
    additional_iterations: number;
    reason?: "time_limit";
    ceiling_seconds?: number;
  } | null>(null);
  const [error, setError] = useState("");
  
  const socketRef = useRef<WebSocket | null>(null);
  const queuedTasksRef = useRef<QueuedTask[]>([]);
  const syntheticTurnIdRef = useRef(-1);
  const activeThreadIdRef = useRef<string | null>(null);
  const taskInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  
  const conversationBottomRef = useRef<HTMLDivElement | null>(null);
  const conversationAreaRef = useRef<HTMLDivElement | null>(null);
  const diffPanelRef = useRef<HTMLElement | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const conversationScrollTopRef = useRef(0);
  const activityScrollRef = useRef<HTMLDivElement | null>(null);
  const shortcutTimerRef = useRef<number | null>(null);
  const panelPreviewTimerRef = useRef<Record<PreviewPanel, number | null>>({
    sidebar: null,
    git: null,
    context: null,
  });
  const apiKeyPromptedRef = useRef(false);
  const continuationPendingRef = useRef(false);
  
  const gitCloseTimerRef = useRef<number | null>(null);
  const contextCloseTimerRef = useRef<number | null>(null);
  
  
  const resizeRef = useRef<{
    panel: "sidebar" | "activity" | "context" | "git" | "diff";
    startX: number;
    startWidth: number;
  } | null>(null);
  const modelInfo = new Map(modelCatalog.map((model) => [model.id, model]));
  const {
    gitStatus,
    setGitStatus,
    gitStatusLoading,
    setGitStatusLoading,
    gitFetchError,
    setGitFetchError,
    gitMutation,
    setGitMutation,
    gitDiff,
    setGitDiff,
    commitMessage,
    setCommitMessage,
    commitMessageGenerating,
    setCommitMessageGenerating,
    undoCommitWarning,
    setUndoCommitWarning,
    branchSwitchError,
    setBranchSwitchError,
    commitGenerationRef,
    gitStatusRequestRef,
    gitDiffRequestRef,
    gitDiffSelectionRef,
    loadGitStatus,
    openGitDiff,
    closeGitDiff,
    updateGitIndex,
    switchGitBranch,
    syncGitBranch,
    createGitCommit,
    undoLastCommit,
    generateCommitMessage,
    discardGitChanges,
  } = useGitController({
    workspacePath, narrowView, gitDiffShowUnchanged, runInProgress: Boolean(runningThreadId),
    modelName, modelInfo, apiKey, sarvamApiKey, setError, setGitOpen,
    setGitPreviewOpen, setSidebarPreviewOpen, setContextPreviewOpen, setBranchPickerOpen,
  });
  const availableModels = modelCatalog
    .filter((model) => model.selectable && (model.provider === "gemini" ? apiKey.trim() : sarvamApiKey.trim()))
    .map((model) => model.id);
  useEffect(() => {
    if (status !== "running" && status !== "connecting") return;
    const timer = window.setInterval(() => setActivityClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    conversationBottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [events, assistantText, continuationRequest, queuedTasks, status]);

  useEffect(() => {
    const activityScroller = activityScrollRef.current;
    if (!activityOpen || !activityScroller) return;
    if (activityScroller.scrollHeight > activityScroller.clientHeight) {
      activityScroller.scrollTop = activityScroller.scrollHeight;
    }
  }, [activityOpen, events]);

  useEffect(() => {
    const conversationArea = conversationAreaRef.current;
    if (!conversationArea) return;
    const updateWidth = () => setConversationAreaWidth(conversationArea.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(conversationArea);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const input = taskInputRef.current;
    if (!input) {
      return;
    }
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [task]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    const updateHeight = () => setComposerHeight(composer.getBoundingClientRect().height);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!settingsOpen) taskInputRef.current?.focus();
  }, [activeThread, settingsOpen]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/models")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load models.");
        return readJson<{ models: ModelOption[] }>(response);
      })
      .then((payload) => {
        if (cancelled) return;
        setModelCatalog(payload.models);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load models. Is the API running?");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setModelName((current) => {
      if (current && availableModels.includes(current)) return current;
      return selectableModel(activeThread?.model_name ?? "", availableModels);
    });
  }, [apiKey, sarvamApiKey, modelCatalog, activeThread?.model_name]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      Object.values(panelPreviewTimerRef.current).forEach((timer) => {
        if (timer !== null) window.clearTimeout(timer);
      });
    };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    void desktop.getVersion().then(setAppVersion);
    void desktop.getUpdateReady().then(setUpdateVersion);
    const stopReady = desktop.onUpdateReady(setUpdateVersion);
    const stopState = desktop.onUpdateState(setUpdateState);
    void desktop.getUpdateState().then(setUpdateState);
    return () => { stopReady(); stopState(); };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    void desktop.getSettings().then(
      (settings) => {
        setApiKey(settings.apiKey ?? sessionStorage.getItem("gemini-api-key") ?? "");
        setSarvamApiKey(
          settings.sarvamApiKey ?? sessionStorage.getItem("sarvam-api-key") ?? "",
        );
        setMaxIterations(
          settings.maxIterations ??
            Math.min(Math.max(Number(localStorage.getItem("max-iterations")) || 50, 1), 50),
        );
        setTimeoutMinutes(settings.timeoutMinutes ??
          Math.min(Math.max(Number(localStorage.getItem("timeout-minutes")) || 30, 1), 1440));
        setSendOnEnter(settings.sendOnEnter ?? localStorage.getItem("send-on-enter") !== "false");
        setMidRunEnterAction(validMidRunEnterAction(
          settings.midRunEnterAction ?? localStorage.getItem("mid-run-enter-action"),
        ));
        setUiScale(settings.scale ?? 1);
        setAppearance(validAppearance(settings.appearance));
        setSidebarCollapsed(
          settings.sidebarCollapsed ?? localStorage.getItem("sidebar-collapsed") === "true",
        );
        setSidebarWidth(
          settings.sidebarWidth ??
            Math.min(
              Math.max(Number(localStorage.getItem("sidebar-width")) || DEFAULT_SIDEBAR_WIDTH, 220),
              MAX_SIDEBAR_WIDTH,
            ),
        );
        setActivityWidth(clampActivityWidth(
          settings.activityWidth ?? Number(localStorage.getItem("activity-width")),
        ));
        setContextWidth(
          settings.contextWidth ??
            Math.min(
              Math.max(Number(localStorage.getItem("context-width")) || DEFAULT_CONTEXT_WIDTH, 280),
              MAX_CONTEXT_WIDTH,
            ),
        );
        setContextOpen(
          settings.contextOpen ?? localStorage.getItem("context-open") === "true",
        );
        setGitWidth(
          settings.gitWidth ??
            Math.min(
              Math.max(Number(localStorage.getItem("git-width")) || DEFAULT_GIT_WIDTH, 280),
              MAX_GIT_WIDTH,
            ),
        );
        setGitOpen(settings.gitOpen ?? localStorage.getItem("git-open") === "true");
        setGitDiffWrap(settings.gitDiffWrap ?? localStorage.getItem("git-diff-wrap") === "true");
        setGitDiffSplit(settings.gitDiffSplit ?? localStorage.getItem("git-diff-split") === "true");
        setGitDiffShowUnchanged(
          settings.gitDiffShowUnchanged ?? localStorage.getItem("git-diff-show-unchanged") === "true",
        );
        setDiffWidth(clampDiffWidth(settings.gitDiffWidth ?? Number(localStorage.getItem("git-diff-width"))));
        setThreadSort(validThreadSort(settings.threadSort));
        setGroupThreadsByPath(settings.groupThreadsByPath ?? false);
        setSettingsLoaded(true);
      },
      (reason) => setError(`Could not load settings: ${String(reason)}`),
    );
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (desktop) {
      void desktop
        .setSettings({
          apiKey,
          sarvamApiKey,
          maxIterations,
          timeoutMinutes,
          sendOnEnter,
          midRunEnterAction,
          sidebarCollapsed,
          sidebarWidth,
          activityWidth,
          activityPlacement: "inline",
          contextWidth,
          contextOpen,
          gitWidth,
          gitOpen,
          gitDiffWrap,
          gitDiffSplit,
          gitDiffShowUnchanged,
          gitDiffWidth: diffWidth,
          threadSort,
          groupThreadsByPath,
          scale: uiScale,
          appearance,
        })
        .then(() => {
          sessionStorage.removeItem("gemini-api-key");
          sessionStorage.removeItem("sarvam-api-key");
          localStorage.removeItem("max-iterations");
          localStorage.removeItem("timeout-minutes");
          localStorage.removeItem("send-on-enter");
          localStorage.removeItem("mid-run-enter-action");
          localStorage.removeItem("sidebar-collapsed");
          localStorage.removeItem("sidebar-width");
          localStorage.removeItem("activity-width");
          localStorage.removeItem("activity-placement");
          localStorage.removeItem("context-width");
          localStorage.removeItem("context-open");
          localStorage.removeItem("git-width");
          localStorage.removeItem("git-open");
          localStorage.removeItem("git-diff-wrap");
          localStorage.removeItem("git-diff-split");
          localStorage.removeItem("git-diff-show-unchanged");
          localStorage.removeItem("git-diff-width");
          localStorage.removeItem("thread-sort");
          localStorage.removeItem("group-threads-by-path");
        })
        .catch((reason) => setError(`Could not save settings: ${String(reason)}`));
      return;
    }
    sessionStorage.setItem("gemini-api-key", apiKey);
    sessionStorage.setItem("sarvam-api-key", sarvamApiKey);
    localStorage.setItem("max-iterations", String(maxIterations));
    localStorage.setItem("timeout-minutes", String(timeoutMinutes));
    localStorage.setItem("send-on-enter", String(sendOnEnter));
    localStorage.setItem("mid-run-enter-action", midRunEnterAction);
    localStorage.setItem("sidebar-collapsed", String(sidebarCollapsed));
    localStorage.setItem("sidebar-width", String(sidebarWidth));
    localStorage.setItem("activity-width", String(activityWidth));
    localStorage.setItem("activity-placement", "inline");
    localStorage.setItem("context-width", String(contextWidth));
    localStorage.setItem("context-open", String(contextOpen));
    localStorage.setItem("git-width", String(gitWidth));
    localStorage.setItem("git-open", String(gitOpen));
    localStorage.setItem("git-diff-wrap", String(gitDiffWrap));
    localStorage.setItem("git-diff-split", String(gitDiffSplit));
    localStorage.setItem("git-diff-show-unchanged", String(gitDiffShowUnchanged));
    localStorage.setItem("git-diff-width", String(diffWidth));
    localStorage.setItem("thread-sort", threadSort);
    localStorage.setItem("group-threads-by-path", String(groupThreadsByPath));
    localStorage.setItem("appearance", appearance);
  }, [activityWidth, apiKey, appearance, contextOpen, contextWidth, desktop, diffWidth, gitDiffShowUnchanged, gitDiffSplit, gitDiffWrap, gitOpen, gitWidth, groupThreadsByPath, maxIterations, midRunEnterAction, sarvamApiKey, sendOnEnter, settingsLoaded, sidebarCollapsed, sidebarWidth, threadSort, timeoutMinutes, uiScale]);

  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      document.documentElement.dataset.theme =
        appearance === "system" ? (systemTheme.matches ? "dark" : "light") : appearance;
    };
    applyTheme();
    if (appearance !== "system") return;
    systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [appearance]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => {
      setNarrowView(media.matches);
      setSidebarPreviewOpen(false);
      setContextPreviewOpen(false);
      setGitPreviewOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(`(min-width: ${LARGE_DIFF_SIDEBAR_BREAKPOINT}px)`);
    const update = () => setLargeDiffViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!settingsLoaded || apiKey.trim() || sarvamApiKey.trim() || apiKeyPromptedRef.current) return;
    apiKeyPromptedRef.current = true;
    setApiKeyDraft(apiKey);
    setSarvamApiKeyDraft(sarvamApiKey);
    setMaxIterationsDraft(String(maxIterations));
    setSendOnEnterDraft(sendOnEnter);
    setMidRunEnterActionDraft(midRunEnterAction);
    setUiScaleDraft(uiScale);
    setAppearanceDraft(appearance);
    setSettingsOpen(true);
  }, [apiKey, appearance, maxIterations, midRunEnterAction, sarvamApiKey, sendOnEnter, settingsLoaded, uiScale]);

  useEffect(() => {
    if (!desktop) return;
    return desktop.onScaleChanged((scale) => {
      setUiScale(scale);
      setUiScaleDraft(scale);
    });
  }, []);

  useEffect(() => {
    function closeShortcuts() {
      if (shortcutTimerRef.current !== null) window.clearTimeout(shortcutTimerRef.current);
      shortcutTimerRef.current = null;
      setShortcutsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === SHORTCUT_KEY) {
        if (!event.repeat && shortcutTimerRef.current === null) {
          shortcutTimerRef.current = window.setTimeout(() => {
            shortcutTimerRef.current = null;
            setShortcutsOpen(true);
          }, 1500);
        }
        return;
      }

      const modifierHeld = IS_MAC ? event.metaKey : event.ctrlKey;
      if (modifierHeld && shortcutTimerRef.current !== null) {
        window.clearTimeout(shortcutTimerRef.current);
        shortcutTimerRef.current = null;
      }
      if (event.key === "Escape") {
        setActivityOpen(false);
        setSettingsOpen(false);
        setShortcutsOpen(false);
        setSidebarPreviewOpen(false);
        setGitPreviewOpen(false);
        setContextPreviewOpen(false);
        setThreadToDelete(null);
        setBranchSwitchError(null);
        setGitDiff(null);
        gitDiffRequestRef.current?.abort();
        setError("");
      }
      if (desktop && modifierHeld && ["-", "=", "+", "0"].includes(event.key)) {
        event.preventDefault();
        setUiScale((scale) => {
          const nextScale = event.key === "0"
            ? 1
            : Math.min(Math.max(Math.round((scale + (event.key === "-" ? -0.1 : 0.1)) * 10) / 10, 0.5), 2);
          void desktop.setScale(nextScale);
          return nextScale;
        });
        return;
      }
      if (modifierHeld && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        startNewThread("current");
        return;
      }
      if (modifierHeld && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        startNewThread("unselected");
        return;
      }
      if (modifierHeld && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        if (activeThread) void openThread(activeThread.id, true);
        return;
      }
      if (!modifierHeld || event.altKey || event.shiftKey || event.key.toLowerCase() !== "b") return;

      event.preventDefault();
      if (gitDiff && !largeDiffViewport) {
        setSidebarPreviewOpen((open) => !open);
      } else {
        setSidebarCollapsed((collapsed) => !collapsed);
        setSidebarPreviewOpen(false);
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.key === SHORTCUT_KEY) closeShortcuts();
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", closeShortcuts);
    return () => {
      if (shortcutTimerRef.current !== null) window.clearTimeout(shortcutTimerRef.current);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", closeShortcuts);
    };
  }, [activeThread, gitDiff, largeDiffViewport, narrowView, threads, workspacePath]);

  useEffect(() => {
    void refreshThreads(true);
  }, []);

  useLayoutEffect(() => {
    const panel = diffPanelRef.current;
    if (!gitDiff || !panel) {
      setRenderedDiffWidth(0);
      return;
    }
    const updateWidth = () => setRenderedDiffWidth(panel.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [gitDiff]);

  useEffect(() => {
    setGitFetchError(null);
    setCommitMessage("");
    gitDiffRequestRef.current?.abort();
    gitDiffSelectionRef.current = null;
    setGitDiff(null);
  }, [workspacePath]);

  useEffect(() => {
    let interval: number | null = null;
    let attentionTimer: number | null = null;

    function stopPolling() {
      if (interval !== null) window.clearInterval(interval);
      interval = null;
    }

    function refreshIfActive() {
      if (
        document.visibilityState === "visible"
        && document.hasFocus()
        && !gitStatusRequestRef.current
        && !gitMutation
      ) {
        void loadGitStatus(true);
      }
    }

    function syncPolling() {
      stopPolling();
      if (attentionTimer !== null) window.clearTimeout(attentionTimer);
      attentionTimer = null;
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      attentionTimer = window.setTimeout(() => {
        attentionTimer = null;
        refreshIfActive();
        interval = window.setInterval(refreshIfActive, GIT_REFRESH_INTERVAL_MS);
      }, 0);
    }

    syncPolling();
    window.addEventListener("focus", syncPolling);
    window.addEventListener("blur", stopPolling);
    document.addEventListener("visibilitychange", syncPolling);
    return () => {
      stopPolling();
      if (attentionTimer !== null) window.clearTimeout(attentionTimer);
      window.removeEventListener("focus", syncPolling);
      window.removeEventListener("blur", stopPolling);
      document.removeEventListener("visibilitychange", syncPolling);
      gitStatusRequestRef.current?.abort();
    };
  }, [workspacePath, status, gitMutation]);

  // API-backed thread and Git actions.
  async function refreshThreads(initializePath = false) {
    try {
      const response = await fetch("/threads");
      if (!response.ok) throw new Error();
      const payload = await readJson<{ threads: ThreadSummary[] }>(response);
      setThreads(payload.threads);
      if (initializePath && payload.threads[0]) {
        setWorkspacePath(payload.threads[0].workspace_path);
      }
    } catch {
      setError("Could not load threads. Is the API running?");
    }
  }

  

  

  

  

  

  

  

  

  

  

  async function openThread(threadId: string, preserveIterationLimit = false) {
    try {
      const response = await fetch(`/threads/${threadId}`);
      if (!response.ok) {
        setError("Could not open this thread.");
        return;
      }
      const payload = await readJson<ThreadDetail>(response);
      activeThreadIdRef.current = payload.thread.id;
      setActiveThread(payload.thread);
      setWorkspacePath(payload.thread.workspace_path);
      setModelName(selectableModel(payload.thread.model_name ?? "", availableModels));
      setThreadTurns(payload.turns);
      setEvents(payload.events);
      setThreadContext(payload.context);
      setExpandedContextEntries({});
      setAssistantText("");
      setEditingTitle(false);
      if (!preserveIterationLimit) {
        setActivityOpen(false);
        setActivityRunId(null);
        setFinalizedByIterationLimit(false);
      }
    } catch {
      setError("Could not open this thread.");
    }
  }

  function startNewThread(pathMode: "current" | "unselected" = "current") {
    const nextWorkspacePath = pathMode === "unselected"
      ? ""
      : activeThread?.workspace_path ?? workspacePath;
    socketRef.current?.close();
    activeThreadIdRef.current = null;
    setActiveThread(null);
    setThreadTurns([]);
    setEvents([]);
    setThreadContext(null);
    setExpandedContextEntries({});
    setAssistantText("");
    queuedTasksRef.current = [];
    setQueuedTasks([]);
    setStopping(false);
    setEditingTitle(false);
    setActivityOpen(false);
    setActivityRunId(null);
    setFinalizedByIterationLimit(false);
    continuationPendingRef.current = false;
    setContinuationRequest(null);
    setError("");
    setStatus("idle");
    setTask("");
    setNewThreadTitle(null);
    setModelName("");
    setWorkspacePath(nextWorkspacePath);
    setContextPreviewOpen(false);
    if (!nextWorkspacePath.trim()) {
      setGitPreviewOpen(false);
      closeGitDiff();
    }
  }

  async function renameActiveThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = titleDraft.trim();
    if (!title) return;
    if (!activeThread) {
      setNewThreadTitle(title);
      setEditingTitle(false);
      return;
    }
    try {
      const response = await fetch(`/threads/${activeThread.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error();
      const thread = await readJson<ThreadSummary>(response);
      setActiveThread(thread);
      setThreads((current) => current.map((item) => (item.id === thread.id ? thread : item)));
      setEditingTitle(false);
      setError("");
    } catch {
      setError("Could not rename this thread.");
    }
  }

  async function deleteThread() {
    if (!threadToDelete) return;
    try {
      const response = await fetch(`/threads/${threadToDelete.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      setThreads((current) => current.filter((item) => item.id !== threadToDelete.id));
      if (activeThread?.id === threadToDelete.id) startNewThread();
      setThreadToDelete(null);
      setError("");
    } catch {
      setThreadToDelete(null);
      setError("Could not delete this thread.");
    }
  }

  // Run lifecycle and queued input.
  function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "connecting" || status === "running") {
      performMidRunAction(status === "running" ? midRunEnterAction : "queue");
      return;
    }
    beginRun(task);
  }

  function beginRun(submittedTaskValue: string, threadOverride?: ThreadSummary | null) {
    if (!submittedTaskValue.trim() || !modelName || (!activeThread && !threadOverride && !workspacePath.trim())) return;
    socketRef.current?.close();

    const thread = threadOverride === undefined ? activeThread : threadOverride;
    let runThread = thread;
    let runThreadId = thread?.id ?? null;
    let activeRunId: string | null = null;
    let completionRefresh: Promise<void> | null = null;
    const submittedTask = submittedTaskValue.trim();

    setStatus("connecting");
    setRunningThreadId(runThreadId);
    setTask("");
    setAssistantText("");
    setActivityOpen(false);
    setActivityRunId(null);
    setFinalizedByIterationLimit(false);
    setStopping(false);
    continuationPendingRef.current = false;
    setContinuationRequest(null);
    setError("");
    setThreadTurns((current) => [
      ...current,
      {
        id: syntheticTurnIdRef.current--,
        run_id: null,
        model_name: modelName,
        finalized_by_iteration_limit: false,
        role: "user",
        content: submittedTask,
        created_at: new Date().toISOString(),
      },
    ]);

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws/run`);
    socketRef.current = socket;

    socket.onmessage = (message) => {
      const payload = JSON.parse(message.data) as RunSocketMessage;

      if (payload.kind === "session.ready") {
        setStatus("running");
        socket.send(
          JSON.stringify({
            task: submittedTask,
            workspace_path: workspacePath,
            model_name: modelName,
            max_iterations: maxIterations,
            timeout_minutes: timeoutMinutes,
            ...(modelInfo.get(modelName)?.provider === "sarvam"
              ? sarvamApiKey.trim() ? { sarvam_api_key: sarvamApiKey.trim() } : {}
              : apiKey.trim() ? { api_key: apiKey.trim() } : {}),
            ...(thread ? { thread_id: thread.id } : {}),
            ...(!thread && newThreadTitle ? { title: newThreadTitle } : {}),
          }),
        );
        return;
      }

      if (payload.kind === "thread.opened") {
        runThread = payload.payload.thread;
        activeRunId = payload.payload.run_id;
        runThreadId = payload.payload.thread.id;
        activeThreadIdRef.current = runThreadId;
        setRunningThreadId(runThreadId);
        setRunningRunId(activeRunId);
        setActiveThread(payload.payload.thread);
        setWorkspacePath(payload.payload.thread.workspace_path);
        setThreadTurns((current) => {
          const pending = current.at(-1);
          if (pending?.role !== "user" || pending.run_id !== null) return current;
          return [...current.slice(0, -1), { ...pending, run_id: payload.payload.run_id }];
        });
        void refreshThreads();
        return;
      }

      if (payload.kind === "runtime.event") {
        if (runThreadId && activeThreadIdRef.current !== runThreadId) return;
        setEvents((current) => [...current, payload.event]);

        if (payload.event.type === "context.updated") {
          const context = payload.event.payload.context;
          if (context && typeof context === "object") {
            setThreadContext(context as ContextState);
          }
        }

        if (payload.event.type === "model.delta") {
          const delta = String(payload.event.payload.delta ?? "");
          setAssistantText((current) => (current ? `${current}\n${delta}` : delta));
        }

        if (payload.event.type === "tool.started") {
          const toolCall = payload.event.payload.tool_call as Record<string, unknown> | undefined;
          const toolName = typeof toolCall?.name === "string" ? toolCall.name : "tool";
          setAssistantText((current) => current || `Running tool: ${toolName}...`);
        }

        if (payload.event.type === "turn.failed") {
          setStatus("failed");
          setAssistantText("");
        }

        if (payload.event.type === "model.completed") {
          const outputText = String(payload.event.payload.output_text ?? "").trim();
          const toolCalls = Array.isArray(payload.event.payload.tool_calls)
            ? payload.event.payload.tool_calls
            : [];

          if (outputText) {
            setAssistantText(outputText);
          } else if (toolCalls.length > 0) {
            const toolNames = toolCalls
              .map((tool) => String((tool as Record<string, unknown>).name ?? "tool"))
              .join(", ");
            setAssistantText(`Tool call received: ${toolNames}. Working on results...`);
          }
        }

        return;
      }

      if (payload.kind === "run.continuation_required") {
        continuationPendingRef.current = true;
        setContinuationRequest(payload.payload);
        return;
      }

      if (payload.kind === "run.stop_requested") {
        setStopping(true);
        return;
      }

      if (payload.kind === "run.steering_accepted") {
        setThreadTurns((current) => [
          ...current,
          {
            id: syntheticTurnIdRef.current--,
            run_id: activeRunId,
            model_name: modelName,
            finalized_by_iteration_limit: false,
            role: "user",
            content: payload.payload.content,
            created_at: new Date().toISOString(),
          },
        ]);
        return;
      }

      if (payload.kind === "run.completed") {
        setStatus(payload.payload.status);
        if (activeThreadIdRef.current === payload.payload.thread_id) {
          setFinalizedByIterationLimit(payload.payload.finalized_by_iteration_limit);
          if (payload.payload.output_text.trim()) {
            setAssistantText(payload.payload.output_text);
          }
          completionRefresh = openThread(payload.payload.thread_id, true);
        }
        void refreshThreads();
        return;
      }

      if (payload.kind === "run.failed") {
        setStatus("failed");
        if (runThreadId && activeThreadIdRef.current === runThreadId) setAssistantText("");
        else setError(payload.error);
        return;
      }

      if (payload.kind === "run.finished") {
        continuationPendingRef.current = false;
        setContinuationRequest(null);
        setRunningRunId(null);
        socket.close();
        const nextTask = queuedTasksRef.current.shift();
        setQueuedTasks([...queuedTasksRef.current]);
        if (nextTask && !stopping) {
          setStatus("connecting");
          void (completionRefresh ?? Promise.resolve()).then(() => {
            beginRun(nextTask.content, runThread);
          });
        } else {
          setRunningThreadId(null);
          setStatus((current) => (current === "running" ? "completed" : current));
          setStopping(false);
        }
      }
    };

    socket.onerror = () => {
      continuationPendingRef.current = false;
      setContinuationRequest(null);
      setRunningThreadId(null);
      setRunningRunId(null);
      setStatus("failed");
      setError("WebSocket connection failed.");
    };
  }

  function queueTask() {
    const content = task.trim();
    if (!content || viewingOtherThreadDuringRun) return;
    queuedTasksRef.current = [
      ...queuedTasksRef.current,
      {
        id: crypto.randomUUID(),
        content,
        createdAt: new Date().toISOString(),
      },
    ];
    setQueuedTasks([...queuedTasksRef.current]);
    setTask("");
  }

  function deleteQueuedTask(id: string) {
    queuedTasksRef.current = queuedTasksRef.current.filter((queuedTask) => queuedTask.id !== id);
    setQueuedTasks([...queuedTasksRef.current]);
  }

  function steerQueuedTask(id: string) {
    const queuedTask = queuedTasksRef.current.find((candidate) => candidate.id === id);
    const socket = socketRef.current;
    if (
      !queuedTask
      || status !== "running"
      || stopping
      || viewingOtherThreadDuringRun
      || socket?.readyState !== WebSocket.OPEN
    ) return;
    try {
      socket.send(JSON.stringify({ kind: "run.steer", content: queuedTask.content }));
      deleteQueuedTask(id);
      setError("");
    } catch {
      setError("Could not steer this queued message.");
    }
  }

  function steerRun() {
    const content = task.trim();
    if (!content || viewingOtherThreadDuringRun || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ kind: "run.steer", content }));
    setTask("");
  }

  function performMidRunAction(action: MidRunEnterAction) {
    if (action === "steer") steerRun();
    else queueTask();
  }

  function stopRun() {
    queuedTasksRef.current = [];
    setQueuedTasks([]);
    if (status === "connecting") {
      socketRef.current?.close();
      setRunningThreadId(null);
      setStatus("stopped");
      setStopping(false);
      return;
    }
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    setStopping(true);
    socketRef.current.send(JSON.stringify({ kind: "run.stop" }));
  }

  function answerContinuation(continueRun: boolean) {
    if (!continuationPendingRef.current) return;
    continuationPendingRef.current = false;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({ kind: "run.continuation_decision", continue: continueRun }),
      );
    }
    setContinuationRequest(null);
  }

  // Panel sizing and preview behavior.
  function startResize(panel: "sidebar" | "activity" | "context" | "git" | "diff", event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      panel,
      startX: event.clientX,
      startWidth: panel === "sidebar"
        ? sidebarWidth
        : panel === "activity"
          ? activityWidth
          : panel === "context" ? contextWidth : panel === "diff" ? diffWidth : gitWidth,
    };
  }

  function resizePanel(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize) return;
    const delta = event.clientX - resize.startX;
    const activityLeft = event.currentTarget.parentElement?.getBoundingClientRect().left;
    const width = resize.panel === "activity" && typeof activityLeft === "number"
      ? event.clientX - activityLeft
      : resize.startWidth + (resize.panel === "sidebar" ? delta : -delta);
    const activityMaximum = Math.min(
      MAX_ACTIVITY_WIDTH,
      Math.max(
        MIN_ACTIVITY_WIDTH,
        conversationAreaWidth
          - MIN_THREAD_WIDTH_WITH_ACTIVITY
          - ACTIVITY_LAYOUT_GAP
          - CONVERSATION_HORIZONTAL_GUTTER,
      ),
    );
    (resize.panel === "sidebar"
      ? setSidebarWidth
      : resize.panel === "activity"
        ? setActivityWidth
        : resize.panel === "context" ? setContextWidth : resize.panel === "diff" ? setDiffWidth : setGitWidth)(
      Math.min(
        Math.max(
          width,
          resize.panel === "sidebar"
            ? 220
            : resize.panel === "activity" ? MIN_ACTIVITY_WIDTH : resize.panel === "diff" ? 420 : 280,
        ),
        resize.panel === "sidebar"
          ? MAX_SIDEBAR_WIDTH
          : resize.panel === "activity"
            ? activityMaximum
            : resize.panel === "context"
              ? MAX_CONTEXT_WIDTH
              : resize.panel === "diff" ? MAX_DIFF_WIDTH : MAX_GIT_WIDTH,
      ),
    );
  }

  function holdPanelPreview(panel: PreviewPanel) {
    const timer = panelPreviewTimerRef.current[panel];
    if (timer !== null) window.clearTimeout(timer);
    panelPreviewTimerRef.current[panel] = null;
  }

  function openPanelPreview(panel: PreviewPanel) {
    (["sidebar", "git", "context"] as const).forEach(holdPanelPreview);
    setSidebarPreviewOpen(panel === "sidebar");
    setGitPreviewOpen(panel === "git");
    setContextPreviewOpen(panel === "context");
  }

  function closePanelPreview(panel: PreviewPanel, setOpen: (open: boolean) => void) {
    holdPanelPreview(panel);
    panelPreviewTimerRef.current[panel] = window.setTimeout(() => {
      panelPreviewTimerRef.current[panel] = null;
      setOpen(false);
    }, 100);
  }

  function toggleGitPanel() {
    if (!activeThread && !workspacePath.trim()) return;
    void loadGitStatus();
    if (gitClosing) {
      if (gitCloseTimerRef.current !== null) window.clearTimeout(gitCloseTimerRef.current);
      gitCloseTimerRef.current = null;
      setGitClosing(false);
      return;
    }
    if (gitPinnedOpen) {
      setGitPreviewOpen(false);
      setGitClosing(true);
      closeGitDiff();
      gitCloseTimerRef.current = window.setTimeout(() => {
        gitCloseTimerRef.current = null;
        setGitOpen(false);
        setGitClosing(false);
      }, 180);
    } else if (narrowView && gitPreviewOpen) {
      setGitClosing(true);
      closeGitDiff();
      gitCloseTimerRef.current = window.setTimeout(() => {
        gitCloseTimerRef.current = null;
        setGitPreviewOpen(false);
        setGitClosing(false);
      }, 180);
    } else if (narrowView) {
      openPanelPreview("git");
    } else {
      if (gitCloseTimerRef.current !== null) window.clearTimeout(gitCloseTimerRef.current);
      gitCloseTimerRef.current = null;
      setGitClosing(false);
      setGitOpen(true);
      setGitPreviewOpen(false);
    }
  }

  function toggleContextPanel() {
    if (!activeThread) return;
    if (contextClosing) {
      if (contextCloseTimerRef.current !== null) window.clearTimeout(contextCloseTimerRef.current);
      contextCloseTimerRef.current = null;
      setContextClosing(false);
      return;
    }
    if (contextPinnedOpen) {
      setContextPreviewOpen(false);
      setContextClosing(true);
      contextCloseTimerRef.current = window.setTimeout(() => {
        contextCloseTimerRef.current = null;
        setContextOpen(false);
        setContextClosing(false);
      }, 180);
    } else if ((narrowView || diffOpen) && contextPreviewOpen) {
      setContextClosing(true);
      contextCloseTimerRef.current = window.setTimeout(() => {
        contextCloseTimerRef.current = null;
        setContextPreviewOpen(false);
        setContextClosing(false);
      }, 180);
    } else if (narrowView || diffOpen) {
      openPanelPreview("context");
    } else {
      if (contextCloseTimerRef.current !== null) window.clearTimeout(contextCloseTimerRef.current);
      contextCloseTimerRef.current = null;
      setContextClosing(false);
      setContextOpen(true);
      setContextPreviewOpen(false);
    }
  }

  function openSettings() {
    setApiKeyDraft(apiKey);
    setSarvamApiKeyDraft(sarvamApiKey);
    setMaxIterationsDraft(String(maxIterations));
    setMaxIterationsError("");
    setTimeoutMinutesDraft(String(timeoutMinutes));
    setTimeoutMinutesError("");
    setSendOnEnterDraft(sendOnEnter);
    setMidRunEnterActionDraft(midRunEnterAction);
    setUiScaleDraft(uiScale);
    setAppearanceDraft(appearance);
    setSettingsOpen(true);
  }

  // Values consumed by the page and panel components.
  const visibleEvents = activityRunId
    ? events.filter((runtimeEvent) => eventRunId(runtimeEvent) === activityRunId)
    : events;
  const updateReady = updateState.status === "ready" || Boolean(updateVersion);
  const updateBusy = updateState.status === "checking" || updateState.status === "downloading";
  const updateButtonLabel = updateReady ? "Update"
    : updateState.status === "checking" ? "Checking…"
    : updateState.status === "downloading" ? "Downloading…"
    : updateState.status === "unavailable" ? "Unavailable"
    : updateCooldownActive && updateState.status === "up-to-date" ? "You're up to date"
    : updateCooldownActive && updateState.status === "error" ? "Update failed"
    : "Check for updates";
  const updateTooltip = updateReady ? `Restart and install v${updateState.version ?? updateVersion}`
    : updateState.status === "downloading" ? `Downloading v${updateState.version}`
    : updateState.status === "error" ? `Update failed: ${updateState.message}`
    : updateState.status === "unavailable" ? "Updates are available in installed releases only."
    : undefined;
  function restartToUpdate() {
    void desktop?.restartToUpdate().catch((reason) => setUpdateState({ status: "error", message: String(reason) }));
  }
  const repositoryRequired = !activeThread && Boolean(task.trim()) && !workspacePath.trim();
  const modelRequired = Boolean(task.trim()) && !modelName;
  const runInProgress = Boolean(runningThreadId);
  const viewingOtherThreadDuringRun = Boolean(
    runInProgress && runningThreadId && activeThread?.id !== runningThreadId,
  );
  const diffOpen = Boolean(gitDiff);
  const gitAvailable = Boolean(activeThread || workspacePath.trim());
  const contextAvailable = Boolean(activeThread);
  const gitDiffCanSplit = renderedDiffWidth >= MIN_SPLIT_DIFF_WIDTH;
  const diffRestrictsSidebarPinning = diffOpen && !largeDiffViewport;
  const sidebarPinnedOpen = !diffRestrictsSidebarPinning && !narrowView && !sidebarCollapsed;
  const sidebarOpen = sidebarPinnedOpen || sidebarPreviewOpen;
  const contextPinnedOpen = contextAvailable && !diffOpen && !narrowView && contextOpen;
  const contextVisible = contextAvailable && (contextPinnedOpen || contextPreviewOpen);
  const gitPinnedOpen = gitAvailable && !narrowView && gitOpen;
  const gitVisible = gitAvailable && (gitPinnedOpen || gitPreviewOpen);
  const gitTracked = gitStatus?.is_repository === true;
  const gitBranchLabel = gitTracked
    ? gitStatus.branch || "Detached HEAD"
    : gitStatusLoading ? "Checking Git..." : "No Git";
  const gitHasStagedChanges = Boolean(gitStatus?.staged.length);
  const gitHasChanges = Boolean(
    gitStatus?.staged.length || gitStatus?.modified.length || gitStatus?.untracked.length,
  );
  const gitChangedFileCount = new Set([
    ...(gitStatus?.staged ?? []),
    ...(gitStatus?.modified ?? []),
    ...(gitStatus?.untracked ?? []),
  ].map((file) => file.path)).size;
  const eventGroups: Array<{
    iteration: number | null;
    createdAt?: string;
    events: RuntimeEvent[];
  }> = [];
  for (const runtimeEvent of visibleEvents) {
    const iteration = runtimeEvent.payload.iteration;
    const lastGroup = eventGroups.at(-1);
    const groupIteration = typeof iteration === "number" ? iteration : (lastGroup?.iteration ?? null);
    if (lastGroup?.iteration === groupIteration) {
      lastGroup.events.push(runtimeEvent);
    } else {
      eventGroups.push({
        iteration: groupIteration,
        createdAt: runtimeEvent.created_at,
        events: [runtimeEvent],
      });
    }
  }
  const effectiveActivityWidth = clampActivityWidth(activityWidth);
  const activityStacked = true;
  const activityBesideThread = false;
  const activeRunEnterAction: MidRunEnterAction = status === "running"
    ? midRunEnterAction
    : "queue";
  const alternateRunEnterAction: MidRunEnterAction = activeRunEnterAction === "queue"
    ? "steer"
    : "queue";

  useLayoutEffect(() => {
    const conversationScroller = activityBesideThread
      ? threadScrollRef.current
      : conversationAreaRef.current;
    if (conversationScroller) {
      conversationScroller.scrollTop = conversationScrollTopRef.current;
    }
  }, [activityBesideThread]);
  const contextUsage = threadContext
    ? Math.min((threadContext.estimated_tokens / threadContext.token_budget) * 100, 100)
    : 0;
  const settingsDirty = apiKeyDraft !== apiKey
    || sarvamApiKeyDraft !== sarvamApiKey
    || maxIterationsDraft !== String(maxIterations)
    || timeoutMinutesDraft !== String(timeoutMinutes)
    || sendOnEnterDraft !== sendOnEnter
    || midRunEnterActionDraft !== midRunEnterAction
    || appearanceDraft !== appearance
    || Boolean(desktop && uiScaleDraft !== uiScale);
  const sortedThreads = [...threads].sort((left, right) => {
    const leftDate = threadSort === "created" ? left.created_at : left.last_message_at ?? left.created_at;
    const rightDate = threadSort === "created" ? right.created_at : right.last_message_at ?? right.created_at;
    return rightDate.localeCompare(leftDate);
  });
  const threadGroups = groupThreadsByPath
    ? Array.from(
        sortedThreads.reduce((groups, thread) => {
          const group = groups.get(thread.workspace_path) ?? [];
          group.push(thread);
          groups.set(thread.workspace_path, group);
          return groups;
        }, new Map<string, ThreadSummary[]>()),
      )
    : [[null, sortedThreads] as const];
  const layoutColumns = [
    sidebarPinnedOpen ? "var(--sidebar-width)" : "0px",
    "minmax(0,1fr)",
    diffOpen ? "minmax(360px,var(--diff-column-width))" : "0px",
    gitPinnedOpen && !gitClosing ? "var(--git-column-width)" : "0px",
    contextPinnedOpen && !contextClosing ? "var(--context-column-width)" : "0px",
  ].join(" ");

  const activityProps = {
    eventGroups, activityRunId, collapsedActivityGroups, setCollapsedActivityGroups,
    activityScrollRef, setActivityWidth, startResize, resizePanel,
    onResizeCancel: () => { resizeRef.current = null; },
  };
  const gitFileGroupProps = {
    collapsedGitGroups, setCollapsedGitGroups, gitMutation, gitDiff,
    updateGitIndex, discardGitChanges, openGitDiff, closeGitDiff,
  };

  return {
    desktop,
    macDesktop,
    desktopWindowControls,
    task,
    setTask,
    workspacePath,
    setWorkspacePath,
    modelName,
    setModelName,
    setApiKey,
    setSarvamApiKey,
    setMaxIterations,
    setTimeoutMinutes,
    sendOnEnter,
    setSendOnEnter,
    midRunEnterAction,
    setMidRunEnterAction,
    uiScale,
    setUiScale,
    appearance,
    setAppearance,
    status,
    settingsOpen,
    setSettingsOpen,
    modelPickerOpen,
    setModelPickerOpen,
    branchPickerOpen,
    setBranchPickerOpen,
    apiKeyDraft,
    setApiKeyDraft,
    sarvamApiKeyDraft,
    setSarvamApiKeyDraft,
    maxIterationsDraft,
    setMaxIterationsDraft,
    maxIterationsError,
    setMaxIterationsError,
    timeoutMinutesDraft,
    setTimeoutMinutesDraft,
    timeoutMinutesError,
    setTimeoutMinutesError,
    sendOnEnterDraft,
    setSendOnEnterDraft,
    midRunEnterActionDraft,
    setMidRunEnterActionDraft,
    uiScaleDraft,
    setUiScaleDraft,
    appearanceDraft,
    setAppearanceDraft,
    shortcutsOpen,
    updateState,
    setUpdateState,
    updateCooldownActive,
    appVersion,
    threads,
    activeThread,
    runningThreadId,
    runningRunId,
    threadToDelete,
    setThreadToDelete,
    threadTurns,
    events,
    threadContext,
    expandedContextEntries,
    setExpandedContextEntries,
    assistantText,
    queuedTasks,
    stopping,
    activityClock,
    activityOpen,
    setActivityOpen,
    setGitOpen,
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
    gitDiff,
    gitDiffWrap,
    setGitDiffWrap,
    gitDiffSplit,
    setGitDiffSplit,
    gitDiffShowUnchanged,
    setGitDiffShowUnchanged,
    composerHeight,
    commitMessage,
    setCommitMessage,
    commitMessageGenerating,
    setCommitMessageGenerating,
    undoCommitWarning,
    setUndoCommitWarning,
    collapsedGitGroups,
    setCollapsedGitGroups,
    activityRunId,
    setActivityRunId,
    setSidebarCollapsed,
    setSidebarPreviewOpen,
    sidebarWidth,
    setSidebarWidth,
    contextWidth,
    setContextWidth,
    gitWidth,
    setGitWidth,
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
    commitGenerationRef,
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
    syncGitBranch,
    createGitCommit,
    undoLastCommit,
    generateCommitMessage,
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
    updateBusy,
    updateButtonLabel,
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
    contextPinnedOpen,
    contextVisible,
    gitPinnedOpen,
    gitVisible,
    gitTracked,
    gitBranchLabel,
    gitHasStagedChanges,
    gitHasChanges,
    gitChangedFileCount,
    effectiveActivityWidth,
    activityStacked,
    activityBesideThread,
    activeRunEnterAction,
    alternateRunEnterAction,
    contextUsage,
    settingsDirty,
    threadGroups,
    layoutColumns,
    activityProps,
    gitFileGroupProps,
  };
}
