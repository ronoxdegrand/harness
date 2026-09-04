import { type CSSProperties, FormEvent, Fragment, lazy, type PointerEvent as ReactPointerEvent, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { AlertTriangle, ArrowDownUp, Check, ChevronDown, ChevronUp, Columns2, Copy, FolderGit2, GitBranch, Layers3, LoaderCircle, Minus, Minimize2, PanelLeft, PanelRight, Pencil, Plus, RefreshCw, Rows2, Send, Settings2, Sparkles, Square, Trash2, Undo2, WrapText, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge, Button, Card, Input, Separator, Textarea } from "@/components/ui";
import webPackage from "../package.json";

const GEMINI_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
];
const SARVAM_MODELS = ["sarvam-105b"];
const DEFAULT_SIDEBAR_WIDTH = 272;
const DEFAULT_ACTIVITY_WIDTH = 420;
const MIN_ACTIVITY_WIDTH = 400;
const DEFAULT_CONTEXT_WIDTH = 340;
const DEFAULT_GIT_WIDTH = 340;
const DEFAULT_DIFF_WIDTH = 760;
const MIN_SPLIT_DIFF_WIDTH = 720;
const LARGE_DIFF_SIDEBAR_BREAKPOINT = 1800;
const MIN_THREAD_WIDTH_WITH_ACTIVITY = 480;
const ACTIVITY_LAYOUT_GAP = 16;
const CONVERSATION_HORIZONTAL_GUTTER = 48;
const MAX_SIDEBAR_WIDTH = 600;
const MAX_ACTIVITY_WIDTH = 720;
const MAX_CONTEXT_WIDTH = 720;
const MAX_GIT_WIDTH = 720;
const MAX_DIFF_WIDTH = 1800;
const GIT_REFRESH_INTERVAL_MS = 5000;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT_KEY = IS_MAC ? "Meta" : "Control";
const SHORTCUT_LABEL = IS_MAC ? "Cmd" : "Ctrl";
const ALT_LABEL = IS_MAC ? "Option" : "Alt";
const GitDiffContents = lazy(() => import("@/components/GitDiffContents"));
type Appearance = "light" | "dark" | "system";
type ThreadSort = "recent-message" | "created";
type ActivityPlacement = "side" | "inline";
type MidRunEnterAction = "queue" | "steer";
type PreviewPanel = "sidebar" | "git" | "context";
type GitGroup = "staged" | "changes" | "commits";

type BranchSwitchError = {
  to: string;
  message: string;
  files: string[];
  canForce: boolean;
};

function gitPathParts(filePath: string) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const separator = normalizedPath.lastIndexOf("/");
  return {
    fileName: separator >= 0 ? normalizedPath.slice(separator + 1) : normalizedPath,
    relativeDirectory: separator >= 0 ? normalizedPath.slice(0, separator) : "",
  };
}

function validAppearance(value: unknown): Appearance {
  return value === "dark" || value === "system" ? value : "light";
}

function validThreadSort(value: unknown): ThreadSort {
  return value === "created" ? value : "recent-message";
}

function validActivityPlacement(value: unknown): ActivityPlacement {
  return value === "inline" ? value : "side";
}

function validMidRunEnterAction(value: unknown): MidRunEnterAction {
  return value === "steer" ? "steer" : "queue";
}

function clampActivityWidth(value: number) {
  return Math.min(Math.max(value || DEFAULT_ACTIVITY_WIDTH, MIN_ACTIVITY_WIDTH), MAX_ACTIVITY_WIDTH);
}

function selectableModel(model: string, options: string[]) {
  return options.includes(model) ? model : options[0] ?? "";
}

type RunSocketMessage =
  | { kind: "session.ready"; payload: { workspace_root: string } }
  | { kind: "thread.opened"; payload: { thread: ThreadSummary; run_id: string } }
  | { kind: "runtime.event"; event: RuntimeEvent }
  | {
      kind: "run.completed";
      payload: {
        thread_id: string;
        output_text: string;
        status: string;
        finalized_by_iteration_limit: boolean;
      };
    }
  | { kind: "run.failed"; error: string }
  | { kind: "run.stop_requested" }
  | { kind: "run.steering_accepted"; payload: { content: string } }
  | {
      kind: "run.continuation_required";
      payload: { iteration: number; completed_iterations: number; additional_iterations: number };
    }
  | { kind: "run.finished" };

type RuntimeEvent = {
  run_id?: string;
  type: string;
  payload: Record<string, unknown>;
  created_at?: string;
};

type ThreadSummary = {
  id: string;
  title: string;
  workspace_path: string;
  model_name: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
};

type ThreadTurn = {
  id: number;
  run_id: string | null;
  model_name: string | null;
  finalized_by_iteration_limit: boolean;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type QueuedTask = {
  id: string;
  content: string;
  createdAt: string;
};

type ContextState = {
  token_budget: number;
  estimated_tokens: number;
  estimate_method: string;
  messages: Array<{
    index: number;
    role: string;
    name: string | null;
    tokens: number;
    included: boolean;
    pinned: boolean;
    truncated: boolean;
    preview: string;
    expandable: boolean;
  }>;
};

type GitFileState = {
  path: string;
  status: string;
};

type GitDiffState = {
  path: string;
  staged: boolean;
  patch: string | null;
  binary: boolean;
  error: string | null;
};

type GitCommitState = {
  hash: string;
  short_hash: string;
  subject: string;
  author: string;
  authored_at: string;
};

type GitStatusState = {
  is_repository: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  branches: string[];
  staged: GitFileState[];
  modified: GitFileState[];
  untracked: GitFileState[];
  local_commits: GitCommitState[];
  local_commits_truncated: boolean;
  base_commit: GitCommitState | null;
  error: string | null;
  fetch_error: string | null;
};

type ThreadDetail = {
  thread: ThreadSummary;
  turns: ThreadTurn[];
  events: RuntimeEvent[];
  context: ContextState | null;
};

async function readJson<T>(response: Response): Promise<T> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The API returned an unexpected response.");
  }
  return (await response.json()) as T;
}

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function CopyButton({ content, className, label = "Copy message" }: { content: string; className: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <Button
      aria-label={copied ? "Copied" : label}
      className={`size-7 text-muted-foreground opacity-60 hover:opacity-100 ${className}`}
      size="icon-sm"
      title={copied ? "Copied" : label}
      type="button"
      variant="ghost"
      onClick={() => navigator.clipboard.writeText(content).then(() => setCopied(true)).catch(() => undefined)}
    >
      {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
    </Button>
  );
}

function ShortcutKeys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((key) => (
        <kbd className="min-w-7 rounded border bg-muted px-2 py-1 text-center font-mono text-xs" key={key}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

function formatTimestamp(timestamp: string) {
  const isoTimestamp = timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoTimestamp));
}

function eventRunId(event: RuntimeEvent) {
  const runId = event.run_id ?? event.payload.run_id;
  return typeof runId === "string" ? runId : null;
}

function countIterations(events: RuntimeEvent[]) {
  return new Set(
    events
      .map((event) => event.payload.iteration)
      .filter((iteration): iteration is number => typeof iteration === "number"),
  ).size;
}

function showInActivity(event: RuntimeEvent) {
  return !event.type.endsWith(".started")
    && event.type !== "model.delta"
    && event.type !== "turn.completed";
}

export default function App() {
  const desktop = window.harnessDesktop;
  const macDesktop = desktop?.platform === "darwin";
  const desktopWindowControls = Boolean(desktop && !macDesktop);
  const [task, setTask] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState(() =>
    desktop ? "" : sessionStorage.getItem("gemini-api-key") || "",
  );
  const [sarvamApiKey, setSarvamApiKey] = useState(() =>
    desktop ? "" : sessionStorage.getItem("sarvam-api-key") || "",
  );
  const [maxIterations, setMaxIterations] = useState(() =>
    desktop ? 8 : Math.min(Math.max(Number(localStorage.getItem("max-iterations")) || 8, 1), 50),
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
  const [lastUsedModel, setLastUsedModel] = useState("");
  const [status, setStatus] = useState("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey);
  const [sarvamApiKeyDraft, setSarvamApiKeyDraft] = useState(sarvamApiKey);
  const [maxIterationsDraft, setMaxIterationsDraft] = useState(String(maxIterations));
  const [maxIterationsError, setMaxIterationsError] = useState("");
  const [sendOnEnterDraft, setSendOnEnterDraft] = useState(sendOnEnter);
  const [midRunEnterActionDraft, setMidRunEnterActionDraft] = useState(midRunEnterAction);
  const [uiScaleDraft, setUiScaleDraft] = useState(uiScale);
  const [appearanceDraft, setAppearanceDraft] = useState<Appearance>(appearance);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string>();
  const [appVersion, setAppVersion] = useState(webPackage.version);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<ThreadSummary | null>(null);
  const [runningThreadId, setRunningThreadId] = useState<string | null>(null);
  const [threadToDelete, setThreadToDelete] = useState<ThreadSummary | null>(null);
  const [threadTurns, setThreadTurns] = useState<ThreadTurn[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [collapsedActivityGroups, setCollapsedActivityGroups] = useState<Record<string, boolean>>({});
  const [threadContext, setThreadContext] = useState<ContextState | null>(null);
  const [expandedContextEntries, setExpandedContextEntries] = useState<Record<number, string | null>>({});
  const [assistantText, setAssistantText] = useState("");
  const [queuedTasks, setQueuedTasks] = useState<QueuedTask[]>([]);
  const [stopping, setStopping] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityPlacement, setActivityPlacement] = useState<ActivityPlacement>(() =>
    desktop ? "side" : validActivityPlacement(localStorage.getItem("activity-placement")),
  );
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
  const [gitPreviewOpen, setGitPreviewOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatusState | null>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [gitFetchError, setGitFetchError] = useState<string | null>(null);
  const [gitMutation, setGitMutation] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffState | null>(null);
  const [gitDiffWrap, setGitDiffWrap] = useState(false);
  const [gitDiffSplit, setGitDiffSplit] = useState(false);
  const [renderedDiffWidth, setRenderedDiffWidth] = useState(0);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitMessageGenerating, setCommitMessageGenerating] = useState(false);
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
  const [diffWidth, setDiffWidth] = useState(DEFAULT_DIFF_WIDTH);
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
  } | null>(null);
  const [error, setError] = useState("");
  const [branchSwitchError, setBranchSwitchError] = useState<BranchSwitchError | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const queuedTasksRef = useRef<QueuedTask[]>([]);
  const syntheticTurnIdRef = useRef(-1);
  const activeThreadIdRef = useRef<string | null>(null);
  const taskInputRef = useRef<HTMLTextAreaElement | null>(null);
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
  const gitStatusRequestRef = useRef<AbortController | null>(null);
  const gitDiffRequestRef = useRef<AbortController | null>(null);
  const resizeRef = useRef<{
    panel: "sidebar" | "activity" | "context" | "git" | "diff";
    startX: number;
    startWidth: number;
  } | null>(null);
  const availableModels = [
    ...(apiKey.trim() ? GEMINI_MODELS : []),
    ...(sarvamApiKey.trim() ? SARVAM_MODELS : []),
  ];

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
    if (!settingsOpen) taskInputRef.current?.focus();
  }, [activeThread, settingsOpen]);

  useEffect(() => {
    const latestModel = threads[0]?.model_name ?? "";
    setModelName((current) => selectableModel(current || latestModel, availableModels));
    setLastUsedModel((current) => selectableModel(current || latestModel, availableModels));
  }, [apiKey, sarvamApiKey, threads]);

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
    return desktop.onUpdateReady(setUpdateVersion);
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
            Math.min(Math.max(Number(localStorage.getItem("max-iterations")) || 8, 1), 50),
        );
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
        setActivityPlacement(validActivityPlacement(
          settings.activityPlacement ?? localStorage.getItem("activity-placement"),
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
          sendOnEnter,
          midRunEnterAction,
          sidebarCollapsed,
          sidebarWidth,
          activityWidth,
          activityPlacement,
          contextWidth,
          contextOpen,
          gitWidth,
          gitOpen,
          threadSort,
          groupThreadsByPath,
          scale: uiScale,
          appearance,
        })
        .then(() => {
          sessionStorage.removeItem("gemini-api-key");
          sessionStorage.removeItem("sarvam-api-key");
          localStorage.removeItem("max-iterations");
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
          localStorage.removeItem("thread-sort");
          localStorage.removeItem("group-threads-by-path");
        })
        .catch((reason) => setError(`Could not save settings: ${String(reason)}`));
      return;
    }
    sessionStorage.setItem("gemini-api-key", apiKey);
    sessionStorage.setItem("sarvam-api-key", sarvamApiKey);
    localStorage.setItem("max-iterations", String(maxIterations));
    localStorage.setItem("send-on-enter", String(sendOnEnter));
    localStorage.setItem("mid-run-enter-action", midRunEnterAction);
    localStorage.setItem("sidebar-collapsed", String(sidebarCollapsed));
    localStorage.setItem("sidebar-width", String(sidebarWidth));
    localStorage.setItem("activity-width", String(activityWidth));
    localStorage.setItem("activity-placement", activityPlacement);
    localStorage.setItem("context-width", String(contextWidth));
    localStorage.setItem("context-open", String(contextOpen));
    localStorage.setItem("git-width", String(gitWidth));
    localStorage.setItem("git-open", String(gitOpen));
    localStorage.setItem("thread-sort", threadSort);
    localStorage.setItem("group-threads-by-path", String(groupThreadsByPath));
    localStorage.setItem("appearance", appearance);
  }, [activityPlacement, activityWidth, apiKey, appearance, contextOpen, contextWidth, desktop, gitOpen, gitWidth, groupThreadsByPath, maxIterations, midRunEnterAction, sarvamApiKey, sendOnEnter, settingsLoaded, sidebarCollapsed, sidebarWidth, threadSort, uiScale]);

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
      if (!modifierHeld || event.key.toLowerCase() !== "b") return;

      event.preventDefault();
      if (event.altKey) {
        if (narrowView || gitDiff) {
          setGitPreviewOpen(false);
          setContextPreviewOpen((open) => !open);
        } else {
          setContextOpen((open) => !open);
          setContextPreviewOpen(false);
        }
      } else {
        if (gitDiff && !largeDiffViewport) {
          setSidebarPreviewOpen((open) => !open);
        } else {
          setSidebarCollapsed((collapsed) => !collapsed);
          setSidebarPreviewOpen(false);
        }
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
  }, [activeThread, gitDiff, largeDiffViewport, lastUsedModel, narrowView, threads, workspacePath]);

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

  async function refreshThreads(initializeModel = false) {
    try {
      const response = await fetch("/threads");
      if (!response.ok) throw new Error();
      const payload = await readJson<{ threads: ThreadSummary[] }>(response);
      setThreads(payload.threads);
      if (initializeModel && payload.threads[0]) {
        const latestModel = selectableModel(payload.threads[0].model_name, availableModels);
        setModelName(latestModel);
        setLastUsedModel(latestModel);
        setWorkspacePath(payload.threads[0].workspace_path);
      }
    } catch {
      setError("Could not load threads. Is the API running?");
    }
  }

  async function loadGitStatus(silent = false, fetchRemote = false) {
    gitStatusRequestRef.current?.abort();
    if (!workspacePath.trim()) {
      setGitStatus(null);
      setGitFetchError(null);
      setGitStatusLoading(false);
      return;
    }
    const controller = new AbortController();
    gitStatusRequestRef.current = controller;
    if (!silent) setGitStatusLoading(true);
    try {
      const response = await fetch("/git/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_path: workspacePath, fetch_remote: fetchRemote }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error();
      const nextStatus = await readJson<GitStatusState>(response);
      setGitStatus(nextStatus);
      if (fetchRemote) setGitFetchError(nextStatus.fetch_error);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setGitStatus({
        is_repository: false,
        root: null,
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        branches: [],
        staged: [],
        modified: [],
        untracked: [],
        local_commits: [],
        local_commits_truncated: false,
        base_commit: null,
        error: "Could not read Git status.",
        fetch_error: null,
      });
      if (fetchRemote) setGitFetchError("Could not contact the Git service.");
    } finally {
      if (gitStatusRequestRef.current === controller) {
        gitStatusRequestRef.current = null;
        if (!silent) setGitStatusLoading(false);
      }
    }
  }

  async function openGitDiff(file: GitFileState, staged: boolean) {
    if (!workspacePath.trim()) return;
    gitDiffRequestRef.current?.abort();
    const controller = new AbortController();
    gitDiffRequestRef.current = controller;
    setGitDiff({ path: file.path, staged, patch: null, binary: false, error: null });
    if (!narrowView) {
      setGitOpen(true);
      setGitPreviewOpen(false);
    }
    setSidebarPreviewOpen(false);
    setContextPreviewOpen(false);
    try {
      const response = await fetch("/git/diff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_path: workspacePath, path: file.path, staged }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await readJson<{ detail?: string }>(response);
        throw new Error(payload.detail || "Could not load the file diff.");
      }
      const payload = await readJson<{ path: string; staged: boolean; patch: string; binary: boolean }>(response);
      setGitDiff({ ...payload, error: null });
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setGitDiff((current) => current && current.path === file.path && current.staged === staged
        ? { ...current, patch: "", error: reason instanceof Error ? reason.message : "Could not load the file diff." }
        : current);
    } finally {
      if (gitDiffRequestRef.current === controller) gitDiffRequestRef.current = null;
    }
  }

  function closeGitDiff() {
    gitDiffRequestRef.current?.abort();
    gitDiffRequestRef.current = null;
    setGitDiff(null);
    setSidebarPreviewOpen(false);
    setContextPreviewOpen(false);
  }

  async function updateGitIndex(action: "stage" | "unstage", paths: string[]) {
    if (!workspacePath.trim() || gitMutation) return;
    gitStatusRequestRef.current?.abort();
    const mutation = `${action}:${paths.join("\0") || "all"}`;
    setGitMutation(mutation);
    try {
      const response = await fetch(`/git/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_path: workspacePath, paths }),
      });
      if (!response.ok) {
        const payload = await readJson<{ detail?: string }>(response);
        throw new Error(payload.detail || `Could not ${action} files.`);
      }
      setGitStatus(await readJson<GitStatusState>(response));
      if (gitDiff && (!paths.length || paths.includes(gitDiff.path))) closeGitDiff();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not ${action} files.`);
    } finally {
      setGitMutation(null);
    }
  }

  async function switchGitBranch(branch: string, force = false) {
    if (!workspacePath.trim() || gitMutation || branch === gitStatus?.branch) return;
    gitStatusRequestRef.current?.abort();
    setGitMutation(`${force ? "force-switch" : "switch"}:${branch}`);
    try {
      const response = await fetch("/git/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_path: workspacePath, branch, force }),
      });
      if (!response.ok) {
        const payload = await readJson<{
          detail?: string | { message?: string; files?: string[]; can_force?: boolean };
        }>(response);
        const detail = payload.detail;
        setBranchSwitchError({
          to: branch,
          message: typeof detail === "object" && detail?.message
            ? detail.message
            : typeof detail === "string" ? detail : `Git could not switch to ${branch}.`,
          files: typeof detail === "object" && Array.isArray(detail?.files) ? detail.files : [],
          canForce: typeof detail === "object" && detail?.can_force === true,
        });
        setBranchPickerOpen(false);
        return;
      }
      const nextStatus = await readJson<GitStatusState>(response);
      setGitStatus(nextStatus);
      setGitFetchError(null);
      setCommitMessage("");
      setBranchPickerOpen(false);
      closeGitDiff();
    } catch (reason) {
      setBranchSwitchError({
        to: branch,
        message: reason instanceof Error ? reason.message : `Git could not switch to ${branch}.`,
        files: [],
        canForce: false,
      });
    } finally {
      setGitMutation(null);
    }
  }

  async function syncGitBranch() {
    if (!workspacePath.trim() || gitMutation || !gitStatus?.upstream) return;
    gitStatusRequestRef.current?.abort();
    setGitMutation("sync");
    try {
      const response = await fetch("/git/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_path: workspacePath }),
      });
      if (!response.ok) {
        const payload = await readJson<{ detail?: string }>(response);
        throw new Error(payload.detail || "Could not synchronize this branch.");
      }
      setGitStatus(await readJson<GitStatusState>(response));
      closeGitDiff();
      setGitFetchError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not synchronize this branch.");
      void loadGitStatus(true);
    } finally {
      setGitMutation(null);
    }
  }

  async function createGitCommit() {
    if (!workspacePath.trim() || gitMutation || !gitStatus?.staged.length || !commitMessage.trim()) return;
    gitStatusRequestRef.current?.abort();
    setGitMutation("commit");
    try {
      const response = await fetch("/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_path: workspacePath, message: commitMessage.trim() }),
      });
      if (!response.ok) {
        const payload = await readJson<{ detail?: string }>(response);
        throw new Error(payload.detail || "Could not create the commit.");
      }
      setGitStatus(await readJson<GitStatusState>(response));
      setCommitMessage("");
      closeGitDiff();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the commit.");
    } finally {
      setGitMutation(null);
    }
  }

  async function generateCommitMessage() {
    const hasChanges = Boolean(
      gitStatus?.staged.length || gitStatus?.modified.length || gitStatus?.untracked.length,
    );
    if (!workspacePath.trim() || !modelName || !hasChanges || commitMessageGenerating || gitMutation) return;
    setCommitMessageGenerating(true);
    try {
      const response = await fetch("/git/commit-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_path: workspacePath,
          model_name: modelName,
          ...(modelName === "sarvam-105b"
            ? sarvamApiKey.trim() ? { sarvam_api_key: sarvamApiKey.trim() } : {}
            : apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const payload = await readJson<{ detail?: string }>(response);
        throw new Error(payload.detail || "Could not generate a commit message.");
      }
      const payload = await readJson<{ message: string }>(response);
      setCommitMessage(payload.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not generate a commit message.");
    } finally {
      setCommitMessageGenerating(false);
    }
  }

  async function discardGitChanges(paths: string[]) {
    if (!workspacePath.trim() || gitMutation) return;
    gitStatusRequestRef.current?.abort();
    setGitMutation(`discard:${paths.join("\0") || "all"}`);
    try {
      const response = await fetch("/git/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_path: workspacePath, paths }),
      });
      if (!response.ok) {
        const payload = await readJson<{ detail?: string }>(response);
        throw new Error(payload.detail || "Could not discard changes.");
      }
      setGitStatus(await readJson<GitStatusState>(response));
      if (gitDiff && (!paths.length || paths.includes(gitDiff.path))) closeGitDiff();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not discard changes.");
    } finally {
      setGitMutation(null);
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
      setModelName(selectableModel(payload.thread.model_name, availableModels));
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
    setModelName(selectableModel(lastUsedModel, availableModels));
    setWorkspacePath(nextWorkspacePath);
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
    setLastUsedModel(modelName);

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
            ...(modelName === "sarvam-105b"
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
          const errorMessage = String(payload.event.payload.error ?? "The model request failed.");
          setStatus("failed");
          setError(errorMessage);
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
        if (activeThreadIdRef.current === runThreadId) {
          setError(payload.error);
          setAssistantText((current) => current || "The run failed.");
        }
        return;
      }

      if (payload.kind === "run.finished") {
        continuationPendingRef.current = false;
        setContinuationRequest(null);
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

  function openSettings() {
    setApiKeyDraft(apiKey);
    setSarvamApiKeyDraft(sarvamApiKey);
    setMaxIterationsDraft(String(maxIterations));
    setMaxIterationsError("");
    setSendOnEnterDraft(sendOnEnter);
    setMidRunEnterActionDraft(midRunEnterAction);
    setUiScaleDraft(uiScale);
    setAppearanceDraft(appearance);
    setSettingsOpen(true);
  }

  const visibleEvents = activityRunId
    ? events.filter((runtimeEvent) => eventRunId(runtimeEvent) === activityRunId)
    : events;
  const repositoryRequired = !activeThread && Boolean(task.trim()) && !workspacePath.trim();
  const modelRequired = Boolean(task.trim()) && !modelName;
  const runInProgress = Boolean(runningThreadId);
  const viewingOtherThreadDuringRun = Boolean(
    runInProgress && runningThreadId && activeThread?.id !== runningThreadId,
  );
  const diffOpen = Boolean(gitDiff);
  const gitDiffCanSplit = renderedDiffWidth >= MIN_SPLIT_DIFF_WIDTH;
  const diffRestrictsSidebarPinning = diffOpen && !largeDiffViewport;
  const sidebarPinnedOpen = !diffRestrictsSidebarPinning && !narrowView && !sidebarCollapsed;
  const sidebarOpen = sidebarPinnedOpen || sidebarPreviewOpen;
  const contextPinnedOpen = !diffOpen && !narrowView && contextOpen;
  const contextVisible = contextPinnedOpen || contextPreviewOpen;
  const gitPinnedOpen = !narrowView && gitOpen;
  const gitVisible = gitPinnedOpen || gitPreviewOpen;
  const gitTracked = gitStatus?.is_repository === true;
  const gitBranchLabel = gitTracked
    ? gitStatus.branch || "Detached HEAD"
    : gitStatusLoading ? "Checking Git..." : "No Git";
  const gitHasStagedChanges = Boolean(gitStatus?.staged.length);
  const gitHasChanges = Boolean(
    gitStatus?.staged.length || gitStatus?.modified.length || gitStatus?.untracked.length,
  );
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
  const iterationCount = countIterations(visibleEvents);
  const effectiveActivityWidth = clampActivityWidth(activityWidth);
  const activitySideAvailable = conversationAreaWidth > 0
    && conversationAreaWidth >= (
      effectiveActivityWidth
      + MIN_THREAD_WIDTH_WITH_ACTIVITY
      + ACTIVITY_LAYOUT_GAP
      + CONVERSATION_HORIZONTAL_GUTTER
    );
  const latestUserRunId = [...threadTurns].reverse().find((turn) => turn.role === "user")?.run_id ?? null;
  const activityForcedInline = activityOpen
    && status === "running"
    && activeThread?.id === runningThreadId
    && activityRunId === latestUserRunId;
  const activityStacked = activityForcedInline
    || activityPlacement === "inline"
    || !activitySideAvailable;
  const activityBesideThread = activityOpen && !activityStacked;
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
    sidebarPinnedOpen ? "var(--sidebar-width)" : null,
    "minmax(0,1fr)",
    diffOpen ? "minmax(360px,var(--diff-column-width))" : null,
    gitPinnedOpen ? "var(--git-column-width)" : null,
    contextPinnedOpen ? "var(--context-column-width)" : null,
  ].filter(Boolean).join(" ");

  function gitStatusClass(status: string) {
    if (status.includes("D")) return "text-destructive";
    if (status === "??" || status.includes("A")) return "text-success";
    if (status.includes("M")) return "text-warning";
    return "text-muted-foreground";
  }

  function renderGitFileGroup(
    group: GitGroup,
    title: string,
    files: GitFileState[],
    action: "stage" | "unstage",
  ) {
    if (!files.length) return null;
    const ActionIcon = action === "stage" ? Plus : Minus;
    const actionLabel = action === "stage" ? "Stage" : "Unstage";
    const staged = action === "unstage";
    const collapsed = collapsedGitGroups[group];
    return (
      <section>
        <div className="group/git-section mb-1 flex h-5 items-center justify-between px-1">
          <button
            aria-expanded={!collapsed}
            className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
            type="button"
            onClick={() => setCollapsedGitGroups((current) => ({ ...current, [group]: !current[group] }))}
          >
            <ChevronDown
              aria-hidden="true"
              className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
            />
            <span className="truncate">{title}</span>
            <span className="font-normal tabular-nums">{files.length}</span>
          </button>
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/git-section:opacity-100 group-focus-within/git-section:opacity-100">
            <Button
              aria-label={`${actionLabel} all ${title.toLowerCase()}`}
              className="size-5 text-muted-foreground"
              disabled={Boolean(gitMutation)}
              size="icon-sm"
              title={`${actionLabel} all`}
              type="button"
              variant="ghost"
              onClick={() => void updateGitIndex(action, [])}
            >
              <ActionIcon aria-hidden="true" className="size-3" />
            </Button>
            {action === "stage" ? (
              <Button
                aria-label={`Discard all ${title.toLowerCase()}`}
                className="size-5 text-muted-foreground hover:text-destructive"
                disabled={Boolean(gitMutation)}
                size="icon-sm"
                title="Discard all"
                type="button"
                variant="ghost"
                onClick={() => void discardGitChanges([])}
              >
                <Undo2 aria-hidden="true" className="size-3" />
              </Button>
            ) : null}
          </div>
        </div>
        {!collapsed ? (
        <div className="overflow-hidden rounded-lg border bg-card">
          {files.map((file) => {
            const { fileName, relativeDirectory } = gitPathParts(file.path);
            return (
            <div className="group relative" key={`${title}-${file.status}-${file.path}`}>
              <button
                aria-label={`${gitDiff?.path === file.path && gitDiff.staged === staged ? "Close" : "Open"} ${staged ? "staged" : "working tree"} diff for ${file.path}`}
                className={`flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-[padding] group-hover:bg-accent/50 group-focus-within:bg-accent/50 ${
                  gitDiff?.path === file.path && gitDiff.staged === staged ? "bg-accent/70 " : ""
                }${
                  action === "stage"
                    ? "group-hover:pr-14 group-focus-within:pr-14"
                    : "group-hover:pr-10 group-focus-within:pr-10"
                }`}
                type="button"
                onClick={() => {
                  if (gitDiff?.path === file.path && gitDiff.staged === staged) closeGitDiff();
                  else void openGitDiff(file, staged);
                }}
              >
                <span className={`w-5 shrink-0 font-mono text-[10px] font-semibold ${gitStatusClass(file.status)}`}>
                  {file.status.trim() || file.status}
                </span>
                <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={file.path}>
                  <span className={`text-foreground ${file.status.includes("D") ? "line-through opacity-70" : ""}`}>
                    {fileName}
                  </span>
                  {relativeDirectory ? (
                    <span className="ml-2 text-[10px] text-muted-foreground">{relativeDirectory}</span>
                  ) : null}
                </div>
              </button>
              <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <Button
                  aria-label={`${actionLabel} ${file.path}`}
                  className="size-5 shrink-0 text-muted-foreground"
                  disabled={Boolean(gitMutation)}
                  size="icon-sm"
                  title={actionLabel}
                  type="button"
                  variant="ghost"
                  onClick={() => void updateGitIndex(action, [file.path])}
                >
                  <ActionIcon aria-hidden="true" className="size-3" />
                </Button>
                {action === "stage" ? (
                  <Button
                    aria-label={`Discard changes to ${file.path}`}
                    className="size-5 shrink-0 text-muted-foreground hover:text-destructive"
                    disabled={Boolean(gitMutation)}
                    size="icon-sm"
                    title="Discard changes"
                    type="button"
                    variant="ghost"
                    onClick={() => void discardGitChanges([file.path])}
                  >
                    <Undo2 aria-hidden="true" className="size-3" />
                  </Button>
                ) : null}
              </div>
            </div>
            );
          })}
        </div>
        ) : null}
      </section>
    );
  }

  function renderGitCommits() {
    const commits = gitStatus?.local_commits ?? [];
    if (!commits.length) return null;
    const collapsed = collapsedGitGroups.commits;
    return (
      <section>
        <div className="mb-1 flex h-5 items-center px-1">
          <button
            aria-expanded={!collapsed}
            className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
            type="button"
            onClick={() => setCollapsedGitGroups((current) => ({ ...current, commits: !current.commits }))}
          >
            <ChevronDown
              aria-hidden="true"
              className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
            />
            <span className="truncate">Unsynced commits</span>
            <span className="font-normal tabular-nums">
              {commits.length}{gitStatus?.local_commits_truncated ? "+" : ""}
            </span>
          </button>
        </div>
        {!collapsed ? (
          <div className="overflow-hidden rounded-lg border bg-card">
            {commits.map((commit) => (
              <div className="group/commit relative min-w-0" key={commit.hash}>
                <div className="min-w-0 px-2.5 py-1.5 transition-[padding] group-hover/commit:pr-[5.25rem] group-focus-within/commit:pr-[5.25rem]" title={commit.subject}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">{commit.subject}</span>
                </div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {commit.author} · {formatTimestamp(commit.authored_at)}
                </div>
                </div>
                <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover/commit:opacity-100 group-focus-within/commit:opacity-100">
                  <code className="font-mono text-[10px] text-muted-foreground">{commit.short_hash}</code>
                  <CopyButton className="size-5" content={commit.hash} label={`Copy commit ${commit.short_hash}`} />
                </div>
              </div>
            ))}
            {gitStatus?.base_commit ? (
              <div className="group/commit relative min-w-0 bg-muted/45">
                <div className="flex min-w-0 items-start gap-2 px-2.5 py-1.5 pr-2.5 transition-[padding] group-hover/commit:pr-[5.25rem] group-focus-within/commit:pr-[5.25rem]" title={gitStatus.base_commit.subject}>
                  <Check aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-success" />
                  <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {gitStatus.base_commit.subject}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] font-medium text-muted-foreground">
                    {gitStatus.upstream ? "Last synced commit" : "Last shared commit"}
                  </div>
                  </div>
                </div>
                <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover/commit:opacity-100 group-focus-within/commit:opacity-100">
                  <code className="font-mono text-[10px] text-muted-foreground">{gitStatus.base_commit.short_hash}</code>
                  <CopyButton className="size-5" content={gitStatus.base_commit.hash} label={`Copy commit ${gitStatus.base_commit.short_hash}`} />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  function renderActivityIsland(resizable: boolean) {
    return (
      <aside
        aria-label="Activity"
        className={`activity-island relative flex min-h-0 w-full flex-col rounded-xl border bg-sidebar shadow-sm ${
          resizable ? "h-full" : "my-3"
        }`}
        style={resizable ? { minWidth: `${MIN_ACTIVITY_WIDTH}px` } : undefined}
      >
        {resizable ? (
          <div
            aria-label="Resize activity"
            className="group absolute inset-y-0 -right-1 z-30 hidden w-2 cursor-col-resize touch-none lg:block"
            role="separator"
            onDoubleClick={() => setActivityWidth(DEFAULT_ACTIVITY_WIDTH)}
            onPointerCancel={() => (resizeRef.current = null)}
            onPointerDown={(event) => startResize("activity", event)}
            onPointerMove={resizePanel}
            onPointerUp={() => (resizeRef.current = null)}
          >
            <span className="absolute inset-y-0 left-1/2 w-px bg-transparent group-hover:bg-border" />
          </div>
        ) : null}
        <header className="flex h-12 shrink-0 items-center justify-between rounded-t-xl border-b px-3">
          <div className="flex items-center gap-2">
            <Button
              aria-label="Close activity"
              className="size-8 bg-card"
              size="icon-sm"
              type="button"
              variant="outline"
              onClick={() => setActivityOpen(false)}
            >
              <Minimize2 aria-hidden="true" className="size-3.5" />
            </Button>
            <p className="text-sm font-semibold">Activity</p>
            <span className="text-xs text-muted-foreground">
              {iterationCount} {iterationCount === 1 ? "iteration" : "iterations"}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <CopyButton
              className=""
              content={JSON.stringify(visibleEvents, null, 2)}
              label="Copy activity"
            />
            {activitySideAvailable && !activityForcedInline ? (
              <Button
                aria-label={`Move activity ${activityPlacement === "side" ? "inline" : "beside the thread"}`}
                className="size-7 bg-card text-muted-foreground"
                size="icon-sm"
                title={`Move activity ${activityPlacement === "side" ? "inline" : "beside the thread"}`}
                type="button"
                variant="outline"
                onClick={() => setActivityPlacement((current) => current === "side" ? "inline" : "side")}
              >
                {activityPlacement === "side" ? (
                  <PanelRight aria-hidden="true" className="size-3.5" />
                ) : (
                  <Rows2 aria-hidden="true" className="size-3.5" />
                )}
              </Button>
            ) : null}
          </div>
        </header>
        <div
          className={`space-y-4 rounded-b-xl p-3 ${
            resizable ? "min-h-0 flex-1 overflow-y-auto" : "overflow-visible"
          }`}
          ref={activityScrollRef}
        >
          {eventGroups.length ? (
            eventGroups.map((group, groupIndex) => {
              const displayedEvents = group.events.filter(showInActivity);
              const groupKey = `${activityRunId ?? "all"}-${group.iteration ?? "initialization"}-${groupIndex}`;
              const groupCollapsed = collapsedActivityGroups[groupKey] === true;
              const iterationModel = group.events.find(
                (runtimeEvent) => runtimeEvent.type === "model.started",
              )?.payload.model_name;
              const iterationFinished = group.events.some(
                (runtimeEvent) =>
                  runtimeEvent.type === "turn.completed" || runtimeEvent.type === "turn.failed",
              );

              return (
                <section
                  className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0"
                  key={`${group.iteration}-${groupIndex}`}
                >
                  <div className="flex items-center justify-between gap-2 px-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="shrink-0 text-xs font-semibold">
                        {group.iteration === null ? "Initialization" : `Iteration ${group.iteration}`}
                      </p>
                      {typeof iterationModel === "string" && iterationModel ? (
                        <Badge className="h-5 min-w-0 max-w-40 truncate rounded-sm px-1.5 text-xs" title={iterationModel}>
                          {iterationModel}
                        </Badge>
                      ) : null}
                      <Button
                        aria-expanded={!groupCollapsed}
                        aria-controls={`activity-events-${groupIndex}`}
                        className="h-5 shrink-0 gap-1 rounded-sm bg-secondary px-1.5 text-xs text-secondary-foreground hover:bg-secondary/80"
                        size="xs"
                        type="button"
                        variant="ghost"
                        onClick={() => setCollapsedActivityGroups((current) => ({
                          ...current,
                          [groupKey]: !groupCollapsed,
                        }))}
                      >
                        {displayedEvents.length
                          ? `${displayedEvents.length} ${displayedEvents.length === 1 ? "event" : "events"}`
                          : iterationFinished ? "Finished" : "In progress"}
                        {groupCollapsed ? (
                          <ChevronDown aria-hidden="true" className="size-3" />
                        ) : (
                          <ChevronUp aria-hidden="true" className="size-3" />
                        )}
                      </Button>
                    </div>
                    {group.createdAt ? (
                      <time className="shrink-0 text-xs text-muted-foreground" dateTime={group.createdAt}>
                        {formatTimestamp(group.createdAt)}
                      </time>
                    ) : null}
                  </div>
                  {!groupCollapsed ? (
                    <div className="space-y-2" id={`activity-events-${groupIndex}`}>
                  {displayedEvents.map((runtimeEvent, eventIndex) => {
                    const isToolEvent = runtimeEvent.type.startsWith("tool.");
                    const isFailedEvent = runtimeEvent.type.endsWith(".failed");
                    const toolCall = runtimeEvent.payload.tool_call as
                      | { name?: string; arguments?: Record<string, unknown> }
                      | undefined;
                    const result = runtimeEvent.payload.result as
                      | { output?: string; error?: string }
                      | undefined;
                    const { iteration: _, run_id: __, ...eventPayload } = runtimeEvent.payload;

                    if (runtimeEvent.type === "context.updated") {
                      return (
                        <Card className="rounded-lg p-3 text-sm shadow-none" key={`${runtimeEvent.type}-${eventIndex}`}>
                          <details>
                            <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                              Context updated
                            </summary>
                            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
                              {JSON.stringify(eventPayload, null, 2)}
                            </pre>
                          </details>
                        </Card>
                      );
                    }

                    return (
                      <Card
                        key={`${runtimeEvent.type}-${eventIndex}`}
                        className={`rounded-lg p-3 text-sm shadow-none ${
                          isFailedEvent
                            ? "border-destructive/30 bg-destructive/5"
                            : runtimeEvent.type === "tool.completed"
                              ? "border-success-border bg-success-muted"
                              : "bg-card"
                        }`}
                      >
                        <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${
                          isFailedEvent
                            ? "text-destructive"
                            : runtimeEvent.type === "tool.completed"
                              ? "text-success"
                              : "text-muted-foreground"
                        }`}>
                          {runtimeEvent.type.replaceAll(".", " ")}
                        </p>

                        {isToolEvent ? (
                          <div className="mt-2 space-y-2">
                            <p className="font-medium">{toolCall?.name || "tool"}</p>
                            <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
                              {JSON.stringify(toolCall?.arguments ?? {}, null, 2)}
                            </pre>
                            {result?.output ? (
                              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                                {String(result.output).slice(0, 1200)}
                              </pre>
                            ) : null}
                            {result?.error ? (
                              <p className="text-xs text-destructive">{String(result.error)}</p>
                            ) : null}
                          </div>
                        ) : (
                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
                            {JSON.stringify(eventPayload, null, 2)}
                          </pre>
                        )}
                      </Card>
                    );
                  })}
                    </div>
                  ) : null}
                </section>
              );
            })
          ) : (
            <p className="px-2 py-8 text-center text-sm leading-6 text-muted-foreground">
              Tool calls, model events, and run details will appear here.
            </p>
          )}
        </div>
      </aside>
    );
  }

  return (
    <main className="h-dvh overflow-hidden bg-background text-foreground">
      <section
        style={{
          "--sidebar-width": `${sidebarWidth}px`,
          "--activity-width": `${effectiveActivityWidth}px`,
          "--context-column-width": `${contextWidth}px`,
          "--git-column-width": `${gitWidth}px`,
          "--diff-column-width": `min(${diffWidth}px, max(420px, calc(100vw - var(--git-column-width) - ${sidebarPinnedOpen ? "var(--sidebar-width)" : "0px"} - 96px)))`,
          "--layout-columns": layoutColumns,
        } as CSSProperties}
        className="relative grid h-dvh w-full overflow-hidden lg:grid-cols-[var(--layout-columns)]"
      >
        {sidebarOpen ? (
          <aside
            className={`drawer-left fixed top-14 bottom-0 left-0 z-40 flex w-[var(--sidebar-width)] max-w-[calc(100vw-3rem)] min-h-0 flex-col border-r bg-sidebar shadow-[12px_0_30px_rgba(31,31,30,0.12)] lg:max-w-none ${
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
                title="Group by repository path"
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
                        title={path}
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
                        <span className="block truncate text-sm" title={thread.title}>{thread.title}</span>
                        {!groupThreadsByPath ? (
                          <span
                            className="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap text-left font-mono text-xs text-muted-foreground [direction:rtl]"
                            title={thread.workspace_path}
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

        <section className="relative grid h-dvh min-h-0 min-w-0 grid-cols-1 grid-rows-[56px_minmax(0,1fr)_auto] bg-background">
          <header
            className={`fixed inset-x-0 top-0 z-50 col-start-1 row-start-1 flex h-14 shrink-0 items-center border-b bg-background px-4 sm:px-5 lg:relative lg:inset-auto ${desktop ? "titlebar-drag" : ""}`}
          >
            {!sidebarPinnedOpen ? (
              <div
                className={`absolute z-50 flex shrink-0 items-center gap-1 ${macDesktop && !sidebarOpen ? "" : "left-3"}`}
                style={macDesktop && !sidebarOpen ? { left: `${80 / uiScale}px` } : undefined}
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
            <div className={`min-w-0 w-full text-left lg:mx-auto lg:max-w-3xl ${!sidebarPinnedOpen ? editingTitle ? "max-lg:pl-16" : "max-lg:pl-24" : ""} ${
              editingTitle
                ? "max-lg:pr-3"
                : !gitPinnedOpen && !contextPinnedOpen
                  ? "pr-36"
                  : !gitPinnedOpen ? "pr-24" : "pr-12"
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
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="min-w-0 truncate text-left text-sm font-semibold">
                    {activeThread?.title || newThreadTitle || "New chat"}
                  </h2>
                  <Button
                    aria-label="Rename thread"
                    className="size-7 shrink-0 text-muted-foreground"
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
              )}
            </div>
            <div
              className={`absolute z-50 flex items-center gap-1 ${editingTitle ? "max-lg:hidden" : ""} ${desktopWindowControls && !contextPinnedOpen && !gitPinnedOpen ? "" : "right-3"}`}
              style={desktopWindowControls && !contextPinnedOpen && !gitPinnedOpen ? { right: `${144 / uiScale}px` } : undefined}
            >
              {updateVersion ? (
                <Button
                  className="h-10 gap-2"
                  type="button"
                  variant="affirmative"
                  onClick={() => void window.harnessDesktop?.restartToUpdate()}
                >
                  <RefreshCw aria-hidden="true" className="size-4" />
                  Restart to update
                </Button>
              ) : null}
              <DialogPrimitive.Root
                open={settingsOpen}
                onOpenChange={(open) => {
                  if (open) openSettings();
                  else setSettingsOpen(false);
                }}
              >
                <DialogPrimitive.Trigger
                  render={
                    <Button
                      aria-label="Settings"
                      className="size-10 bg-card"
                      size="icon-lg"
                      type="button"
                      variant="outline"
                    >
                      <Settings2 aria-hidden="true" className="size-4" />
                    </Button>
                  }
                />
                <DialogPrimitive.Portal>
                  <DialogPrimitive.Backdrop
                    className="fixed inset-0 z-[60] bg-black/25 backdrop-blur-[1px]"
                    onClick={() => setSettingsOpen(false)}
                  />
                  <DialogPrimitive.Viewport className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center p-4">
                    <DialogPrimitive.Popup className="pointer-events-auto max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xl outline-none">
                      <form
                        className="flex max-h-[calc(100vh-2rem)] flex-col"
                        noValidate
                        onSubmit={(event) => {
                          event.preventDefault();
                          const iterationWarning = Number(maxIterationsDraft);
                          if (
                            !maxIterationsDraft.trim()
                            || !Number.isInteger(iterationWarning)
                            || iterationWarning < 1
                            || iterationWarning > 50
                          ) {
                            setMaxIterationsError("Enter a whole number from 1 to 50.");
                            return;
                          }
                          setApiKey(apiKeyDraft);
                          setSarvamApiKey(sarvamApiKeyDraft);
                          setMaxIterations(iterationWarning);
                          setSendOnEnter(sendOnEnterDraft);
                          setMidRunEnterAction(midRunEnterActionDraft);
                          setUiScale(uiScaleDraft);
                          setAppearance(appearanceDraft);
                          void desktop?.setScale(uiScaleDraft);
                          void desktop?.setAppearance(appearanceDraft);
                          setSettingsOpen(false);
                        }}
                      >
                        <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-muted/30 px-5 py-4">
                          <DialogPrimitive.Title className="text-base font-semibold">Settings</DialogPrimitive.Title>
                          <DialogPrimitive.Description className="sr-only">Configure Harness settings.</DialogPrimitive.Description>
                          <span className="rounded-full border border-brand-border bg-brand-muted px-2 py-0.5 text-xs font-semibold text-brand">
                            v{appVersion}
                          </span>
                        </div>
                        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
                          <section className="rounded-xl border bg-muted/20 p-4">
                            <div className="mb-3">
                              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Providers</h3>
                              <p className="mt-1 text-xs text-muted-foreground">Keys stay on this device.</p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <label className="block space-y-1.5 text-xs font-medium">
                                <span>Gemini API key</span>
                                <Input
                                  autoFocus
                                  autoComplete="off"
                                  placeholder="Enter Gemini key"
                                  type="password"
                                  value={apiKeyDraft}
                                  onChange={(event) => setApiKeyDraft(event.target.value)}
                                />
                              </label>
                              <label className="block space-y-1.5 text-xs font-medium">
                                <span>Sarvam API key</span>
                                <Input
                                  autoComplete="off"
                                  placeholder="Enter Sarvam key"
                                  type="password"
                                  value={sarvamApiKeyDraft}
                                  onChange={(event) => setSarvamApiKeyDraft(event.target.value)}
                                />
                              </label>
                            </div>
                          </section>

                          <section className="rounded-xl border bg-muted/20 p-4">
                            <div className="mb-3">
                              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Runs</h3>
                              <p className="mt-1 text-xs text-muted-foreground">Choose when Harness pauses to ask whether it should continue.</p>
                            </div>
                            <label className="flex items-center justify-between gap-4 text-xs font-medium">
                              <span>Iteration warning</span>
                              <Input
                                aria-describedby={maxIterationsError ? "iteration-warning-error" : undefined}
                                aria-invalid={Boolean(maxIterationsError)}
                                className="w-20"
                                max={50}
                                min={1}
                                required
                                type="number"
                                value={maxIterationsDraft}
                                onChange={(event) => {
                                  setMaxIterationsDraft(event.target.value);
                                  setMaxIterationsError("");
                                }}
                              />
                            </label>
                            {maxIterationsError ? (
                              <p className="mt-1.5 text-right text-xs text-destructive" id="iteration-warning-error">
                                {maxIterationsError}
                              </p>
                            ) : null}
                          </section>

                          <section className="rounded-xl border bg-muted/20 p-4">
                            <div className="mb-3">
                              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Appearance</h3>
                              <p className="mt-1 text-xs text-muted-foreground">Adjust the interface for this device.</p>
                            </div>
                            <div className={`grid gap-4 ${desktop ? "sm:grid-cols-[minmax(0,1fr)_11rem]" : ""}`}>
                              <div className="space-y-2 text-xs font-medium">
                                <span>Theme</span>
                                <div className="grid grid-cols-3 gap-2">
                                  {(["light", "dark", "system"] as const).map((option) => (
                                    <Button
                                      aria-pressed={appearanceDraft === option}
                                      className="capitalize"
                                      key={option}
                                      type="button"
                                      variant={appearanceDraft === option ? "default" : "outline"}
                                      onClick={() => setAppearanceDraft(option)}
                                    >
                                      {option}
                                    </Button>
                                  ))}
                                </div>
                              </div>
                              {desktop ? (
                                <div className="space-y-2 text-xs font-medium">
                                  <span>Interface scale</span>
                                  <div className="grid grid-cols-[36px_minmax(0,1fr)_36px] gap-1.5">
                                <Button
                                  aria-label="Zoom out"
                                      className="size-9"
                                  disabled={uiScaleDraft <= 0.5}
                                      size="icon-sm"
                                  type="button"
                                  variant="outline"
                                  onClick={() => setUiScaleDraft((scale) => Math.max(scale - 0.1, 0.5))}
                                >
                                  <Minus aria-hidden="true" className="size-4" />
                                </Button>
                                    <div className="flex h-9 items-center justify-center rounded-md border bg-card font-mono text-xs">
                                  {Math.round(uiScaleDraft * 100)}%
                                </div>
                                <Button
                                  aria-label="Zoom in"
                                      className="size-9"
                                  disabled={uiScaleDraft >= 2}
                                      size="icon-sm"
                                  type="button"
                                  variant="outline"
                                  onClick={() => setUiScaleDraft((scale) => Math.min(scale + 0.1, 2))}
                                >
                                  <Plus aria-hidden="true" className="size-4" />
                                </Button>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </section>

                          <section className="rounded-xl border bg-muted/20 p-4">
                            <div className="mb-4">
                              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Composer</h3>
                              <p className="mt-1 text-xs text-muted-foreground">Set the primary keyboard action before and during a run.</p>
                            </div>
                            <div className="grid gap-4 sm:grid-cols-2">
                              <div className="space-y-2 text-xs font-medium">
                                <span>Send message</span>
                                <div className="grid grid-cols-2 gap-2" role="group" aria-label="Message input shortcut">
                              <Button
                                aria-pressed={sendOnEnterDraft}
                                      className="h-auto flex-col gap-1 px-2 py-2.5"
                                type="button"
                                variant={sendOnEnterDraft ? "default" : "outline"}
                                onClick={() => setSendOnEnterDraft(true)}
                              >
                                      <span className="flex items-center gap-1">
                                        {!sendOnEnterDraft && (
                                          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">Shift</kbd>
                                        )}
                                        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">Enter</kbd>
                                      </span>
                                      <span>Send</span>
                              </Button>
                              <Button
                                aria-pressed={!sendOnEnterDraft}
                                      className="h-auto flex-col gap-1 px-2 py-2.5"
                                type="button"
                                variant={sendOnEnterDraft ? "outline" : "default"}
                                onClick={() => setSendOnEnterDraft(false)}
                              >
                                      <span className="flex items-center gap-1">
                                        {sendOnEnterDraft && (
                                          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">Shift</kbd>
                                        )}
                                        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">Enter</kbd>
                                      </span>
                                      <span>New line</span>
                              </Button>
                                </div>
                                <p className="font-normal leading-5 text-muted-foreground">The other shortcut inserts a new line.</p>
                            </div>
                              <div className="space-y-2 text-xs font-medium">
                                <span>Enter during a run</span>
                                <div className="grid grid-cols-2 gap-2" role="group" aria-label="Mid-run Enter action">
                              {(["queue", "steer"] as const).map((action) => (
                                <Button
                                  aria-pressed={midRunEnterActionDraft === action}
                                  className="h-auto flex-col gap-1 px-2 py-2.5 capitalize"
                                  key={action}
                                  type="button"
                                  variant={midRunEnterActionDraft === action ? "default" : "outline"}
                                  onClick={() => setMidRunEnterActionDraft(action)}
                                >
                                  <span className="flex items-center gap-1">
                                    {midRunEnterActionDraft === action ? (
                                      <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] normal-case text-foreground">Enter</kbd>
                                    ) : (
                                      <>
                                        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] normal-case text-foreground">{SHORTCUT_LABEL}</kbd>
                                        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] normal-case text-foreground">Enter</kbd>
                                      </>
                                    )}
                                  </span>
                                  <span>{action}</span>
                                </Button>
                              ))}
                            </div>
                              </div>
                            </div>
                          </section>
                          </div>
                        <div className="flex min-h-16 shrink-0 items-center gap-3 border-t bg-muted/20 px-5 py-3">
                          {settingsDirty ? (
                            <span className="text-xs font-medium text-warning" role="status">
                              Changes not saved yet
                            </span>
                          ) : null}
                          <Button className="ml-auto" type="button" variant="ghost" onClick={() => setSettingsOpen(false)}>Cancel</Button>
                          <Button type="submit" variant="affirmative">Save changes</Button>
                        </div>
                      </form>
                    </DialogPrimitive.Popup>
                  </DialogPrimitive.Viewport>
                </DialogPrimitive.Portal>
              </DialogPrimitive.Root>
              {!gitPinnedOpen ? (
                <Button
                  aria-label="Open Git"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onMouseEnter={() => {
                    openPanelPreview("git");
                    void loadGitStatus();
                  }}
                  onMouseLeave={() => closePanelPreview("git", setGitPreviewOpen)}
                  onClick={() => {
                    void loadGitStatus();
                    if (narrowView) openPanelPreview("git");
                    else {
                      setGitOpen(true);
                      setGitPreviewOpen(false);
                    }
                  }}
                >
                  <GitBranch aria-hidden="true" className="size-4" />
                </Button>
              ) : null}
              {!contextPinnedOpen && !gitPinnedOpen ? (
                <Button
                  aria-label="Open context"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onMouseEnter={() => {
                    openPanelPreview("context");
                  }}
                  onMouseLeave={() => closePanelPreview("context", setContextPreviewOpen)}
                  onClick={() => {
                    if (diffOpen || narrowView) openPanelPreview("context");
                    else {
                      setContextOpen(true);
                      setContextPreviewOpen(false);
                    }
                  }}
                >
                  <Layers3 aria-hidden="true" className="size-4" />
                </Button>
              ) : null}
            </div>
          </header>

          <div
            className={`col-start-1 row-start-2 min-h-0 px-4 py-4 sm:px-5 ${
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
                            </Button>
                            {turn.finalized_by_iteration_limit || (finalizedByIterationLimit && isLatestPrompt) ? (
                              <Badge className="bg-warning-muted text-warning">
                                Limit reached
                              </Badge>
                            ) : null}
                            <Separator className="flex-1" />
                          </div>
                          {activityOpen && activityStacked && activityRunId === turn.run_id
                            ? renderActivityIsland(false)
                            : null}
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
                      The harness completed {continuationRequest.completed_iterations} iterations. Continue for up to{" "}
                      {continuationRequest.additional_iterations} more, or stop and generate a final response now.
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
                        title="Steer now"
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
                        title="Delete queued message"
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
              {activityBesideThread ? renderActivityIsland(true) : null}
            </div>
          </div>

          <form className="relative z-30 col-start-1 row-start-3 border-t bg-background px-4 py-3 sm:px-5" onSubmit={startRun}>
            <Card className={`mx-auto w-full max-w-3xl rounded-2xl p-2 shadow-sm transition-shadow focus-within:shadow-md ${
              status === "connecting" || status === "running" ? "composer-running" : ""
            }`}>
              <Textarea
                ref={taskInputRef}
                className="min-h-16 max-h-60 resize-none overflow-y-auto border-0 bg-transparent px-3 py-2 text-sm leading-6 shadow-none focus-visible:ring-0"
                disabled={viewingOtherThreadDuringRun}
                placeholder={status === "connecting" || status === "running"
                  ? "Add a follow-up to queue or steer the current run"
                  : 'Inspect the repo, search for "AgentRuntime", run tests, and show git diff'}
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
              <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
                <div className={`mr-auto flex min-w-0 items-stretch overflow-hidden rounded-lg border bg-card text-xs text-muted-foreground ${
                  repositoryRequired ? "border-warning-border ring-2 ring-warning-border" : "border-border"
                }`}>
                  {activeThread ? (
                    <span
                      className="flex h-8 min-w-0 max-w-52 items-center gap-2 px-2 font-mono"
                      title={activeThread.workspace_path}
                    >
                      <FolderGit2 aria-hidden="true" className="size-4 shrink-0" />
                      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left [direction:rtl]">
                        {activeThread.workspace_path}
                      </span>
                    </span>
                  ) : desktop ? (
                    <Button
                      className={`h-8 max-w-52 justify-start gap-2 rounded-none px-2 font-mono text-xs font-normal ${
                        repositoryRequired
                          ? "bg-warning-muted text-warning hover:bg-warning-muted/80"
                          : "text-muted-foreground"
                      }`}
                      title={workspacePath || "Select repository"}
                      type="button"
                      variant="ghost"
                      onClick={async () => {
                        const selected = await desktop.selectRepository(workspacePath);
                        if (selected) setWorkspacePath(selected);
                      }}
                    >
                      <FolderGit2 aria-hidden="true" className="size-4 shrink-0" />
                      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left [direction:rtl]">
                        {workspacePath || "Select repository"}
                      </span>
                    </Button>
                  ) : (
                    <label>
                      <span className="sr-only">Workspace path</span>
                      <Input
                        className={`h-8 w-36 rounded-none border-0 bg-transparent px-2 font-mono text-xs shadow-none sm:w-52 ${
                          repositoryRequired
                            ? "bg-warning-muted text-warning"
                            : "focus-visible:ring-0"
                        }`}
                        value={workspacePath}
                        onChange={(event) => setWorkspacePath(event.target.value)}
                        placeholder="Workspace path"
                      />
                    </label>
                  )}
                  {workspacePath.trim() && gitTracked && gitStatus.branches.length ? (
                    <SelectPrimitive.Root
                      open={branchPickerOpen}
                      value={gitStatus.branch ?? undefined}
                      onOpenChange={setBranchPickerOpen}
                      onValueChange={(value) => value && void switchGitBranch(value as string)}
                    >
                      <SelectPrimitive.Trigger
                        aria-label={`Switch branch, currently ${gitBranchLabel}`}
                        className="flex h-8 max-w-40 cursor-pointer items-center gap-1.5 border-l px-2 font-mono text-[10px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                        disabled={Boolean(gitMutation) || runInProgress}
                        title={`Branch: ${gitBranchLabel}`}
                      >
                        <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
                        <span className="truncate">{gitBranchLabel}</span>
                        <SelectPrimitive.Icon render={<ChevronUp className="size-3.5 shrink-0" />} />
                      </SelectPrimitive.Trigger>
                      <SelectPrimitive.Portal>
                        <SelectPrimitive.Positioner alignItemWithTrigger sideOffset={4} className="z-50">
                          <SelectPrimitive.Popup className="min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
                            <SelectPrimitive.List>
                              {gitStatus.branches.map((branch) => (
                                <SelectPrimitive.Item
                                  className="relative flex cursor-default items-center rounded-md py-1.5 pr-8 pl-2 font-mono text-xs outline-none focus:bg-accent focus:text-accent-foreground"
                                  key={branch}
                                  value={branch}
                                >
                                  <SelectPrimitive.ItemText>{branch}</SelectPrimitive.ItemText>
                                  <SelectPrimitive.ItemIndicator
                                    className="absolute right-2"
                                    render={<Check className="size-3.5" />}
                                  />
                                </SelectPrimitive.Item>
                              ))}
                            </SelectPrimitive.List>
                          </SelectPrimitive.Popup>
                        </SelectPrimitive.Positioner>
                      </SelectPrimitive.Portal>
                    </SelectPrimitive.Root>
                  ) : workspacePath.trim() ? (
                    <Button
                      aria-label="Open Git panel"
                      className={`h-8 max-w-36 shrink-0 gap-1.5 rounded-none border-l px-2 font-mono text-[10px] font-semibold ${
                        !gitStatusLoading && !gitTracked
                          ? "bg-warning-muted text-warning hover:bg-warning-muted/80"
                          : "text-muted-foreground"
                      }`}
                      title={gitTracked ? gitBranchLabel : "This path is not tracked by Git"}
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        void loadGitStatus();
                        if (narrowView) openPanelPreview("git");
                        else {
                          setGitOpen(true);
                          setGitPreviewOpen(false);
                        }
                      }}
                    >
                      <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="truncate">{gitBranchLabel}</span>
                    </Button>
                  ) : null}
                </div>
                <label className="text-xs text-muted-foreground">
                  <span className="sr-only">Model</span>
                  {availableModels.length ? (
                    <SelectPrimitive.Root
                    open={modelPickerOpen}
                    value={modelName}
                    onOpenChange={setModelPickerOpen}
                    onValueChange={(value) => value && setModelName(value as string)}
                  >
                    <SelectPrimitive.Trigger
                      className={`flex h-8 w-48 cursor-pointer items-center justify-between gap-1.5 rounded-lg px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                        modelRequired
                          ? "bg-warning-muted text-warning ring-2 ring-warning-border"
                          : "bg-transparent"
                      }`}
                    >
                      <SelectPrimitive.Value />
                      <SelectPrimitive.Icon render={<ChevronUp className="size-4 text-muted-foreground" />} />
                    </SelectPrimitive.Trigger>
                    <SelectPrimitive.Portal>
                      <SelectPrimitive.Positioner alignItemWithTrigger sideOffset={4} className="z-50">
                        <SelectPrimitive.Popup className="min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
                          <SelectPrimitive.List>
                            {apiKey.trim() ? GEMINI_MODELS.map((model) => (
                              <SelectPrimitive.Item
                                className="relative flex cursor-default items-center rounded-md py-1.5 pr-8 pl-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
                                key={model}
                                value={model}
                              >
                                <SelectPrimitive.ItemText>{model}</SelectPrimitive.ItemText>
                                <SelectPrimitive.ItemIndicator
                                  className="absolute right-2"
                                  render={<Check className="size-4" />}
                                />
                              </SelectPrimitive.Item>
                            )) : null}
                            {apiKey.trim() && sarvamApiKey.trim() ? <Separator className="my-1" /> : null}
                            {sarvamApiKey.trim() ? SARVAM_MODELS.map((model) => (
                              <SelectPrimitive.Item
                                className="relative flex cursor-default items-center rounded-md py-1.5 pr-8 pl-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
                                key={model}
                                value={model}
                              >
                                <SelectPrimitive.ItemText>{model}</SelectPrimitive.ItemText>
                                <SelectPrimitive.ItemIndicator
                                  className="absolute right-2"
                                  render={<Check className="size-4" />}
                                />
                              </SelectPrimitive.Item>
                            )) : null}
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
                      className={`h-8 w-48 justify-between px-2.5 text-xs font-normal ${
                        modelRequired
                          ? "bg-warning-muted text-warning ring-2 ring-warning-border hover:bg-warning-muted/80"
                          : "text-muted-foreground"
                      }`}
                      type="button"
                      variant="ghost"
                      onClick={openSettings}
                    >
                      <span>Set API key</span>
                      <Settings2 aria-hidden="true" className="size-4" />
                    </Button>
                  )}
                </label>
                {status === "connecting" || status === "running" ? (
                  <span className="text-xs font-medium text-muted-foreground">
                    {stopping ? "Stopping" : "Working"}
                    {queuedTasks.length ? ` · ${queuedTasks.length} queued` : ""}
                  </span>
                ) : null}
                {status === "connecting" || status === "running" ? (
                  <>
                    <Button
                      aria-label="Stop run"
                      className="size-8"
                      disabled={stopping}
                      size="icon-sm"
                      type="button"
                      variant="destructive"
                      onClick={stopRun}
                    >
                      <Square aria-hidden="true" className="size-3.5 fill-current" />
                    </Button>
                    {task.trim() ? ([alternateRunEnterAction, activeRunEnterAction] as const).map((action) => {
                      const primary = action === activeRunEnterAction;
                      return (
                        <Button
                          className="h-8 px-3 text-xs font-semibold capitalize"
                          disabled={stopping || viewingOtherThreadDuringRun || (action === "steer" && status !== "running")}
                          key={action}
                          size="sm"
                          type="button"
                          title={`${action === "queue" ? "Queue" : "Steer"} (${primary ? "Enter" : `${SHORTCUT_LABEL}+Enter`})`}
                          variant={primary ? "affirmative" : "outline"}
                          onClick={action === "queue" ? queueTask : steerRun}
                        >
                          {action}
                        </Button>
                      );
                    }) : null}
                  </>
                ) : (
                  <Button
                    className="h-8 px-3 text-xs font-semibold"
                    disabled={!task.trim() || !modelName || (!activeThread && !workspacePath.trim())}
                    size="sm"
                    type="submit"
                    variant="affirmative"
                  >
                    <Send aria-hidden="true" className="size-3.5" /> Send
                  </Button>
                )}
              </div>
            </Card>
          </form>

        </section>

        {gitDiff ? (
          <aside
            aria-label={`Diff for ${gitDiff.path}`}
            className="fixed inset-x-0 top-14 bottom-0 z-30 flex min-h-0 flex-col border-l bg-background lg:relative lg:inset-auto lg:z-auto lg:w-[var(--diff-column-width)]"
            ref={diffPanelRef}
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
            <header className={`flex h-14 shrink-0 items-center gap-3 border-b px-3 ${desktop ? "titlebar-drag" : ""}`}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs font-medium text-foreground" title={gitDiff.path}>
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
                    title={gitDiffSplit ? "Use unified view" : "Use split view"}
                    type="button"
                    variant={gitDiffSplit ? "secondary" : "ghost"}
                    onClick={() => setGitDiffSplit((split) => !split)}
                  >
                    <Columns2 aria-hidden="true" className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  aria-label={gitDiffWrap ? "Disable word wrap" : "Enable word wrap"}
                  aria-pressed={gitDiffWrap}
                  className="size-7 rounded-md text-muted-foreground"
                  size="icon-sm"
                  title={gitDiffWrap ? "Disable word wrap" : "Enable word wrap"}
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
                title="Close diff"
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
            className={`drawer-right fixed top-14 bottom-0 z-40 flex w-[var(--git-column-width)] max-w-[calc(100vw-3rem)] min-h-0 flex-col border-l bg-sidebar shadow-[-12px_0_30px_rgba(31,31,30,0.12)] lg:max-w-none ${
              gitPinnedOpen
                ? "lg:relative lg:inset-y-auto lg:z-auto lg:shadow-none"
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
            {gitPinnedOpen ? (
              <header
                className={`flex h-14 shrink-0 items-center justify-start gap-1 border-b px-3 ${desktop ? "titlebar-drag" : ""}`}
                style={desktopWindowControls && !contextPinnedOpen ? { paddingRight: `${144 / uiScale}px` } : undefined}
              >
                <Button
                  aria-label="Collapse Git"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setGitOpen(false);
                    closeGitDiff();
                  }}
                >
                  <GitBranch aria-hidden="true" className="size-4" />
                </Button>
                {!contextPinnedOpen ? (
                  <Button
                    aria-label="Open context"
                    className="size-10 bg-card"
                    size="icon-lg"
                    type="button"
                    variant="outline"
                    onMouseEnter={() => openPanelPreview("context")}
                    onMouseLeave={() => closePanelPreview("context", setContextPreviewOpen)}
                    onClick={() => {
                      if (diffOpen || narrowView) openPanelPreview("context");
                      else {
                        setContextOpen(true);
                        setContextPreviewOpen(false);
                      }
                    }}
                  >
                    <Layers3 aria-hidden="true" className="size-4" />
                  </Button>
                ) : null}
              </header>
            ) : null}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
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
                  <form
                    className="flex min-w-0 items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createGitCommit();
                    }}
                  >
                    <label className="min-w-0 flex-1">
                      <span className="sr-only">Commit message</span>
                      <Input
                        className="h-8 bg-card px-2.5 text-xs"
                        maxLength={200}
                        placeholder="Commit message"
                        value={commitMessage}
                        onChange={(event) => setCommitMessage(event.target.value)}
                      />
                    </label>
                    {modelName ? (
                      <Button
                        aria-label="Generate commit message with AI"
                        className="size-8 text-muted-foreground"
                        disabled={!gitHasChanges || commitMessageGenerating || Boolean(gitMutation)}
                        size="icon-sm"
                        title={gitHasStagedChanges ? "Generate from staged changes" : "Generate from working-tree changes"}
                        type="button"
                        variant="outline"
                        onClick={() => void generateCommitMessage()}
                      >
                        {commitMessageGenerating ? (
                          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                        ) : (
                          <Sparkles aria-hidden="true" className="size-3.5" />
                        )}
                      </Button>
                    ) : null}
                    <Button
                      className="h-8 px-2.5 text-xs"
                      disabled={!gitHasStagedChanges || !commitMessage.trim() || Boolean(gitMutation)}
                      size="sm"
                      type="submit"
                      variant="affirmative"
                    >
                      Commit
                    </Button>
                  </form>
                  {renderGitFileGroup("staged", "Staged changes", gitStatus.staged, "unstage")}
                  {renderGitFileGroup("changes", "Changes", [...gitStatus.modified, ...gitStatus.untracked], "stage")}
                  {!gitStatus.staged.length && !gitStatus.modified.length && !gitStatus.untracked.length ? (
                    <p className="px-2 py-2 text-center text-sm leading-6 text-muted-foreground">
                      Working tree clean.
                    </p>
                  ) : null}
                  <div className="space-y-3 border-t pt-3">
                  <div className="flex items-center gap-2">
                    <Button
                      aria-label={`Synchronize ${gitBranchLabel}: ${gitStatus.ahead} to push, ${gitStatus.behind} to pull`}
                      className="h-8 min-w-0 flex-1 justify-start gap-2 px-2.5 text-xs"
                      disabled={!gitStatus.upstream || (!gitStatus.ahead && !gitStatus.behind) || Boolean(gitMutation)}
                      title={gitStatus.upstream ? `Synchronize with ${gitStatus.upstream}` : "This branch has no upstream"}
                      type="button"
                      variant="outline"
                      onClick={() => void syncGitBranch()}
                    >
                      <ArrowDownUp aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="shrink-0">{gitStatus.upstream ? "Sync" : "No upstream"}</span>
                      <span className="min-w-0 truncate font-mono text-[10px] font-normal text-muted-foreground">
                        {gitBranchLabel}
                      </span>
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
                    <Button
                      aria-label={gitFetchError ? "Retry remote Git refresh" : "Refresh Git status and fetch remote"}
                      className={`h-8 gap-1 px-2 text-[11px] ${gitFetchError ? "text-warning" : "text-muted-foreground"}`}
                      disabled={gitStatusLoading || Boolean(gitMutation)}
                      size="xs"
                      title={gitFetchError ? `Remote refresh failed: ${gitFetchError}. Local status is still current.` : "Fetch remote and refresh local status"}
                      type="button"
                      variant="ghost"
                      onClick={() => void loadGitStatus(false, true)}
                    >
                      <RefreshCw aria-hidden="true" className={`size-3 ${gitStatusLoading ? "animate-spin" : ""}`} />
                      Refresh
                    </Button>
                  </div>
                  {renderGitCommits()}
                  </div>
                </>
              ) : null}
            </div>
          </aside>
        ) : null}

        {contextVisible ? (
          <aside
            className={`drawer-right fixed top-14 right-0 bottom-0 z-40 flex w-[var(--context-column-width)] max-w-[calc(100vw-3rem)] min-h-0 flex-col border-l bg-sidebar shadow-[-12px_0_30px_rgba(31,31,30,0.12)] lg:max-w-none ${
              contextPinnedOpen
                ? "lg:relative lg:inset-y-auto lg:z-auto lg:shadow-none"
                : "lg:absolute lg:top-14 lg:right-0 lg:bottom-0 lg:z-40"
            }`}
            style={narrowView && gitVisible ? { width: "calc((100vw - 3rem) / 2)" } : undefined}
            onMouseEnter={() => holdPanelPreview("context")}
            onMouseLeave={() => {
              if (!contextPinnedOpen) closePanelPreview("context", setContextPreviewOpen);
            }}
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
            {contextPinnedOpen ? (
              <header
                className={`flex h-14 shrink-0 items-center justify-start border-b px-3 ${desktop ? "titlebar-drag" : ""}`}
                style={desktopWindowControls ? { paddingRight: `${144 / uiScale}px` } : undefined}
              >
                <Button
                  aria-label="Collapse context"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onClick={() => setContextOpen(false)}
                >
                  <Layers3 aria-hidden="true" className="size-4" />
                </Button>
              </header>
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
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>Toggle context</span>
                <ShortcutKeys keys={[SHORTCUT_LABEL, ALT_LABEL, "B"]} />
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
                                  <span className="flex min-w-0 items-center px-2.5 py-1 font-mono text-xs" key={file} title={file}>
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
