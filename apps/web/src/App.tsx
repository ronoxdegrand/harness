import { type CSSProperties, FormEvent, Fragment, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronUp, Copy, FolderGit2, Layers3, LoaderCircle, Minus, Minimize2, PanelLeft, Pencil, Plus, RefreshCw, Send, Settings2, Trash2 } from "lucide-react";
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
const DEFAULT_ACTIVITY_WIDTH = 340;
const DEFAULT_CONTEXT_WIDTH = 340;
const MAX_SIDEBAR_WIDTH = 600;
const MAX_ACTIVITY_WIDTH = 720;
const MAX_CONTEXT_WIDTH = 720;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT_KEY = IS_MAC ? "Meta" : "Control";
const SHORTCUT_LABEL = IS_MAC ? "Cmd" : "Ctrl";
const ALT_LABEL = IS_MAC ? "Option" : "Alt";
type Appearance = "light" | "dark" | "system";
type ThreadSort = "recent-message" | "created";

function validAppearance(value: unknown): Appearance {
  return value === "dark" || value === "system" ? value : "light";
}

function validThreadSort(value: unknown): ThreadSort {
  return value === "created" ? value : "recent-message";
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
  const [uiScale, setUiScale] = useState(1);
  const [appearance, setAppearance] = useState<Appearance>(() =>
    desktop ? "light" : validAppearance(localStorage.getItem("appearance")),
  );
  const [settingsLoaded, setSettingsLoaded] = useState(!desktop);
  const [lastUsedModel, setLastUsedModel] = useState("");
  const [status, setStatus] = useState("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState(apiKey);
  const [sarvamApiKeyDraft, setSarvamApiKeyDraft] = useState(sarvamApiKey);
  const [maxIterationsDraft, setMaxIterationsDraft] = useState(String(maxIterations));
  const [maxIterationsError, setMaxIterationsError] = useState("");
  const [sendOnEnterDraft, setSendOnEnterDraft] = useState(sendOnEnter);
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
  const [threadContext, setThreadContext] = useState<ContextState | null>(null);
  const [expandedContextEntries, setExpandedContextEntries] = useState<Record<number, string | null>>({});
  const [assistantText, setAssistantText] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  const [narrowView, setNarrowView] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [activityRunId, setActivityRunId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
      : Math.min(
          Math.max(Number(localStorage.getItem("activity-width")) || DEFAULT_ACTIVITY_WIDTH, 280),
          MAX_ACTIVITY_WIDTH,
        ),
  );
  const [contextWidth, setContextWidth] = useState(() =>
    desktop
      ? DEFAULT_CONTEXT_WIDTH
      : Math.min(
          Math.max(Number(localStorage.getItem("context-width")) || DEFAULT_CONTEXT_WIDTH, 280),
          MAX_CONTEXT_WIDTH,
        ),
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
  } | null>(null);
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const taskInputRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationBottomRef = useRef<HTMLDivElement | null>(null);
  const activityBottomRef = useRef<HTMLDivElement | null>(null);
  const shortcutTimerRef = useRef<number | null>(null);
  const panelPreviewTimerRef = useRef<number | null>(null);
  const apiKeyPromptedRef = useRef(false);
  const continuationPendingRef = useRef(false);
  const resizeRef = useRef<{ panel: "sidebar" | "activity" | "context"; startX: number; startWidth: number } | null>(null);
  const availableModels = [
    ...(apiKey.trim() ? GEMINI_MODELS : []),
    ...(sarvamApiKey.trim() ? SARVAM_MODELS : []),
  ];

  useEffect(() => {
    conversationBottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    if (activityOpen) {
      activityBottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [activityOpen, events, assistantText, continuationRequest, status]);

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
      if (panelPreviewTimerRef.current !== null) window.clearTimeout(panelPreviewTimerRef.current);
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
        setUiScale(settings.scale ?? 1);
        setAppearance(validAppearance(settings.appearance));
        setSidebarWidth(
          settings.sidebarWidth ??
            Math.min(
              Math.max(Number(localStorage.getItem("sidebar-width")) || DEFAULT_SIDEBAR_WIDTH, 220),
              MAX_SIDEBAR_WIDTH,
            ),
        );
        setActivityWidth(
          settings.activityWidth ??
            Math.min(
              Math.max(Number(localStorage.getItem("activity-width")) || DEFAULT_ACTIVITY_WIDTH, 280),
              MAX_ACTIVITY_WIDTH,
            ),
        );
        setContextWidth(
          settings.contextWidth ??
            Math.min(
              Math.max(Number(localStorage.getItem("context-width")) || DEFAULT_CONTEXT_WIDTH, 280),
              MAX_CONTEXT_WIDTH,
            ),
        );
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
          sidebarWidth,
          activityWidth,
          contextWidth,
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
          localStorage.removeItem("sidebar-width");
          localStorage.removeItem("activity-width");
          localStorage.removeItem("context-width");
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
    localStorage.setItem("sidebar-width", String(sidebarWidth));
    localStorage.setItem("activity-width", String(activityWidth));
    localStorage.setItem("context-width", String(contextWidth));
    localStorage.setItem("thread-sort", threadSort);
    localStorage.setItem("group-threads-by-path", String(groupThreadsByPath));
    localStorage.setItem("appearance", appearance);
  }, [activityWidth, apiKey, appearance, contextWidth, desktop, groupThreadsByPath, maxIterations, sarvamApiKey, sendOnEnter, settingsLoaded, sidebarWidth, threadSort, uiScale]);

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
    };
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
    setUiScaleDraft(uiScale);
    setAppearanceDraft(appearance);
    setSettingsOpen(true);
  }, [apiKey, appearance, maxIterations, sarvamApiKey, sendOnEnter, settingsLoaded, uiScale]);

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
        setThreadToDelete(null);
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
        startNewThread();
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
        setContextOpen((open) => !open);
        setContextPreviewOpen(false);
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
  }, [activeThread, lastUsedModel, threads, workspacePath]);

  useEffect(() => {
    void refreshThreads(true);
  }, []);

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

  function startNewThread() {
    socketRef.current?.close();
    activeThreadIdRef.current = null;
    setActiveThread(null);
    setThreadTurns([]);
    setEvents([]);
    setThreadContext(null);
    setExpandedContextEntries({});
    setAssistantText("");
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
    setWorkspacePath(threads[0]?.workspace_path ?? workspacePath);
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

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task.trim() || !modelName || (!activeThread && !workspacePath.trim()) || status === "connecting" || status === "running") return;
    socketRef.current?.close();

    const thread = activeThread;
    let runThreadId = thread?.id ?? null;
    const submittedTask = task;
    setLastUsedModel(modelName);

    setStatus("connecting");
    setRunningThreadId(runThreadId);
    setTask("");
    setAssistantText("");
    setActivityOpen(false);
    setActivityRunId(null);
    setFinalizedByIterationLimit(false);
    continuationPendingRef.current = false;
    setContinuationRequest(null);
    setError("");
    setThreadTurns((current) => [
      ...current,
      {
        id: Date.now(),
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

      if (payload.kind === "run.completed") {
        setStatus(payload.payload.status);
        if (activeThreadIdRef.current === payload.payload.thread_id) {
          setFinalizedByIterationLimit(payload.payload.finalized_by_iteration_limit);
          if (payload.payload.output_text.trim()) {
            setAssistantText(payload.payload.output_text);
          }
          void openThread(payload.payload.thread_id, true);
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
        setRunningThreadId(null);
        setStatus((current) => (current === "running" ? "completed" : current));
        socket.close();
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

  function startResize(panel: "sidebar" | "activity" | "context", event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      panel,
      startX: event.clientX,
      startWidth: panel === "sidebar" ? sidebarWidth : panel === "activity" ? activityWidth : contextWidth,
    };
  }

  function resizePanel(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize) return;
    const delta = event.clientX - resize.startX;
    const width = resize.startWidth + (resize.panel === "sidebar" ? delta : -delta);
    (resize.panel === "sidebar" ? setSidebarWidth : resize.panel === "activity" ? setActivityWidth : setContextWidth)(
      Math.min(
        Math.max(width, resize.panel === "sidebar" ? 220 : 280),
        resize.panel === "sidebar" ? MAX_SIDEBAR_WIDTH : resize.panel === "activity" ? MAX_ACTIVITY_WIDTH : MAX_CONTEXT_WIDTH,
      ),
    );
  }

  function holdPanelPreview() {
    if (panelPreviewTimerRef.current !== null) window.clearTimeout(panelPreviewTimerRef.current);
    panelPreviewTimerRef.current = null;
  }

  function closePanelPreview(setOpen: (open: boolean) => void) {
    holdPanelPreview();
    panelPreviewTimerRef.current = window.setTimeout(() => {
      panelPreviewTimerRef.current = null;
      setOpen(false);
    }, 100);
  }

  function openSettings() {
    setApiKeyDraft(apiKey);
    setSarvamApiKeyDraft(sarvamApiKey);
    setMaxIterationsDraft(String(maxIterations));
    setMaxIterationsError("");
    setSendOnEnterDraft(sendOnEnter);
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
  const sidebarPinnedOpen = !narrowView && !sidebarCollapsed;
  const sidebarOpen = sidebarPinnedOpen || sidebarPreviewOpen;
  const contextPinnedOpen = !narrowView && contextOpen;
  const contextVisible = contextPinnedOpen || contextPreviewOpen;
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
  const contextUsage = threadContext
    ? Math.min((threadContext.estimated_tokens / threadContext.token_budget) * 100, 100)
    : 0;
  const settingsDirty = apiKeyDraft !== apiKey
    || sarvamApiKeyDraft !== sarvamApiKey
    || maxIterationsDraft !== String(maxIterations)
    || sendOnEnterDraft !== sendOnEnter
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
    contextPinnedOpen ? "var(--context-column-width)" : null,
  ].filter(Boolean).join(" ");

  return (
    <main className="h-dvh overflow-hidden bg-background text-foreground">
      <section
        style={{
          "--sidebar-width": `${sidebarWidth}px`,
          "--activity-width": `${activityWidth}px`,
          "--context-column-width": `${contextWidth}px`,
          "--layout-columns": layoutColumns,
        } as CSSProperties}
        className="relative grid h-dvh w-full overflow-hidden lg:grid-cols-[var(--layout-columns)]"
      >
        {sidebarOpen ? (
          <aside
            className={`drawer-left fixed top-14 bottom-0 left-0 z-40 flex w-[var(--sidebar-width)] max-w-[calc(100vw-3rem)] min-h-0 flex-col border-r bg-sidebar shadow-[12px_0_30px_rgba(31,31,30,0.12)] lg:max-w-none ${
              sidebarPinnedOpen
                ? "lg:relative lg:inset-y-auto lg:z-auto lg:shadow-none"
                : "sidebar-preview lg:absolute lg:top-14 lg:bottom-0 lg:left-0 lg:z-20"
            }`}
            onMouseEnter={holdPanelPreview}
            onMouseLeave={() => {
              if (!sidebarPinnedOpen) {
                closePanelPreview(setSidebarPreviewOpen);
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
                  onClick={startNewThread}
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
                      className={`h-auto w-full justify-start rounded-lg px-3 py-2.5 pr-10 text-left ${
                        activeThread?.id === thread.id
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                      }`}
                      type="button"
                      variant="ghost"
                      onClick={() => void openThread(thread.id)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{thread.title}</span>
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
                    holdPanelPreview();
                    setSidebarPreviewOpen(true);
                  }}
                  onMouseLeave={() => closePanelPreview(setSidebarPreviewOpen)}
                  onClick={() => {
                    setSidebarCollapsed(false);
                    if (!narrowView) setSidebarPreviewOpen(false);
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
                  onClick={startNewThread}
                >
                  <Plus aria-hidden="true" className="size-4" />
                </Button>
              </div>
            ) : null}
            <div className={`min-w-0 w-full text-left lg:mx-auto lg:max-w-3xl ${!sidebarPinnedOpen ? editingTitle ? "max-lg:pl-16" : "max-lg:pl-24" : ""} ${editingTitle ? "max-lg:pr-3" : !contextPinnedOpen ? "pr-24" : "pr-12"}`}>
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
              className={`absolute z-50 flex items-center gap-1 ${editingTitle ? "max-lg:hidden" : ""} ${desktopWindowControls && !contextPinnedOpen ? "" : "right-3"}`}
              style={desktopWindowControls && !contextPinnedOpen ? { right: `${144 / uiScale}px` } : undefined}
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
                    <DialogPrimitive.Popup className="pointer-events-auto w-full max-w-sm rounded-xl border bg-card p-4 text-card-foreground shadow-xl outline-none">
                      <form
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
                          setUiScale(uiScaleDraft);
                          setAppearance(appearanceDraft);
                          void desktop?.setScale(uiScaleDraft);
                          void desktop?.setAppearance(appearanceDraft);
                          setSettingsOpen(false);
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <DialogPrimitive.Title className="text-sm font-semibold">Settings</DialogPrimitive.Title>
                          <span className="rounded-full border border-brand-border bg-brand-muted px-2 py-0.5 text-xs font-semibold text-brand">
                            v{appVersion}
                          </span>
                        </div>
                        <DialogPrimitive.Description className="sr-only">
                          Changes are saved only when Done is selected.
                        </DialogPrimitive.Description>
                        <div className="mt-4 space-y-4">
                          <label className="block space-y-1.5 text-xs font-medium">
                            <span>Gemini API key</span>
                            <Input
                              autoFocus
                              autoComplete="off"
                              placeholder="Enter your API key"
                              type="password"
                              value={apiKeyDraft}
                              onChange={(event) => setApiKeyDraft(event.target.value)}
                            />
                          </label>
                          <label className="block space-y-1.5 text-xs font-medium">
                            <span>Sarvam API key</span>
                            <Input
                              autoComplete="off"
                              placeholder="Enter your API key"
                              type="password"
                              value={sarvamApiKeyDraft}
                              onChange={(event) => setSarvamApiKeyDraft(event.target.value)}
                            />
                          </label>
                          <label className="block space-y-1.5 text-xs font-medium">
                            <span>Iteration warning</span>
                            <Input
                              aria-describedby={maxIterationsError ? "iteration-warning-error" : undefined}
                              aria-invalid={Boolean(maxIterationsError)}
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
                            {maxIterationsError ? (
                              <span className="block text-xs font-normal text-destructive" id="iteration-warning-error">
                                {maxIterationsError}
                              </span>
                            ) : null}
                          </label>
                          {desktop ? (
                            <div className="space-y-2 text-xs font-medium">
                              <span>Scale</span>
                              <div className="grid grid-cols-[40px_minmax(0,1fr)_40px] gap-2">
                                <Button
                                  aria-label="Zoom out"
                                  className="size-10"
                                  disabled={uiScaleDraft <= 0.5}
                                  size="icon"
                                  type="button"
                                  variant="outline"
                                  onClick={() => setUiScaleDraft((scale) => Math.max(scale - 0.1, 0.5))}
                                >
                                  <Minus aria-hidden="true" className="size-4" />
                                </Button>
                                <div className="flex h-10 items-center justify-center rounded-md border bg-muted font-mono text-sm">
                                  {Math.round(uiScaleDraft * 100)}%
                                </div>
                                <Button
                                  aria-label="Zoom in"
                                  className="size-10"
                                  disabled={uiScaleDraft >= 2}
                                  size="icon"
                                  type="button"
                                  variant="outline"
                                  onClick={() => setUiScaleDraft((scale) => Math.min(scale + 0.1, 2))}
                                >
                                  <Plus aria-hidden="true" className="size-4" />
                                </Button>
                              </div>
                            </div>
                          ) : null}
                          <div className="space-y-2 text-xs font-medium">
                            <span>Appearance</span>
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
                          <div className="space-y-2 text-xs font-medium">
                            <span>Message input</span>
                            <div className="grid gap-2" role="group" aria-label="Message input shortcut">
                              <Button
                                aria-pressed={sendOnEnterDraft}
                                className="h-auto w-full justify-between gap-3 px-3 py-2"
                                type="button"
                                variant={sendOnEnterDraft ? "default" : "outline"}
                                onClick={() => setSendOnEnterDraft(true)}
                              >
                                <kbd className="shrink-0 rounded border bg-muted px-2 py-1 font-mono text-xs text-foreground">
                                  Enter
                                </kbd>
                                <span>{sendOnEnterDraft ? "Sends" : "New line"}</span>
                              </Button>
                              <Button
                                aria-pressed={!sendOnEnterDraft}
                                className="h-auto w-full justify-between gap-3 px-3 py-2"
                                type="button"
                                variant={sendOnEnterDraft ? "outline" : "default"}
                                onClick={() => setSendOnEnterDraft(false)}
                              >
                                <kbd className="shrink-0 rounded border bg-muted px-2 py-1 font-mono text-xs text-foreground">
                                  Shift + Enter
                                </kbd>
                                <span>{sendOnEnterDraft ? "New line" : "Sends"}</span>
                              </Button>
                            </div>
                          </div>
                        </div>
                        <div className="mt-5 flex min-h-9 items-center gap-3">
                          {settingsDirty ? (
                            <span className="text-xs font-medium text-warning" role="status">
                              Changes not saved yet
                            </span>
                          ) : null}
                          <Button className="ml-auto" type="submit" variant="affirmative">Done</Button>
                        </div>
                      </form>
                    </DialogPrimitive.Popup>
                  </DialogPrimitive.Viewport>
                </DialogPrimitive.Portal>
              </DialogPrimitive.Root>
              {!contextPinnedOpen ? (
                <Button
                  aria-label="Open context"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onMouseEnter={() => {
                    holdPanelPreview();
                    setContextPreviewOpen(true);
                  }}
                  onMouseLeave={() => closePanelPreview(setContextPreviewOpen)}
                  onClick={() => {
                    setContextOpen(true);
                    if (!narrowView) setContextPreviewOpen(false);
                  }}
                >
                  <Layers3 aria-hidden="true" className="size-4" />
                </Button>
              ) : null}
            </div>
          </header>

          <div className="col-start-1 row-start-2 min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
            <div className="mx-auto w-full max-w-3xl space-y-4">
              {threadTurns.length ? (
                threadTurns.map((turn, index) => {
                  const runEvents = turn.run_id
                    ? events.filter((runtimeEvent) => eventRunId(runtimeEvent) === turn.run_id)
                    : events;
                  const activityIterationCount = countIterations(runEvents);
                  const isLatestPrompt =
                    turn.role === "user" && !threadTurns.slice(index + 1).some((item) => item.role === "user");

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
                              <time className="text-xs text-muted-foreground" dateTime={turn.created_at}>
                                {formatTimestamp(turn.created_at)}
                              </time>
                              <CopyButton className="!size-4 [&_svg]:!size-2.5" content={turn.content} />
                            </div>
                          </div>
                        )}
                      </article>
                      {turn.role === "user" ? (
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
              <div ref={conversationBottomRef} />
            </div>
          </div>

          <form className="relative z-30 col-start-1 row-start-3 border-t bg-background px-4 py-3 sm:px-5" onSubmit={startRun}>
            <Card className="mx-auto max-w-3xl rounded-2xl p-2 shadow-sm transition-shadow focus-within:shadow-md">
              <Textarea
                ref={taskInputRef}
                className="min-h-16 max-h-60 resize-none overflow-y-auto border-0 bg-transparent px-3 py-2 text-sm leading-6 shadow-none focus-visible:ring-0"
                disabled={viewingOtherThreadDuringRun}
                placeholder={'Inspect the repo, search for "AgentRuntime", run tests, and show git diff'}
                value={task}
                onChange={(event) => setTask(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  const shouldSend = sendOnEnter ? !event.shiftKey : event.shiftKey;
                  if (!shouldSend) return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
              />
              <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
                <div className="mr-auto min-w-0 text-xs text-muted-foreground">
                  {activeThread ? (
                    <span
                      className="block max-w-52 overflow-hidden text-ellipsis whitespace-nowrap px-2 text-left font-mono [direction:rtl]"
                      title={activeThread.workspace_path}
                    >
                      {activeThread.workspace_path}
                    </span>
                  ) : desktop ? (
                    <Button
                      className={`h-8 max-w-52 justify-start gap-2 px-2 font-mono text-xs font-normal ${
                        repositoryRequired
                          ? "bg-warning-muted text-warning ring-2 ring-warning-border hover:bg-warning-muted/80"
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
                        className={`h-7 w-36 border-0 bg-transparent px-0 font-mono text-xs shadow-none sm:w-52 ${
                          repositoryRequired
                            ? "bg-warning-muted px-2 text-warning ring-2 ring-warning-border"
                            : "focus-visible:ring-0"
                        }`}
                        value={workspacePath}
                        onChange={(event) => setWorkspacePath(event.target.value)}
                        placeholder="Workspace path"
                      />
                    </label>
                  )}
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
                  <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                    Working
                  </span>
                ) : null}
                <Button
                  className="h-8 px-3 text-xs font-semibold"
                  disabled={!task.trim() || !modelName || (!activeThread && !workspacePath.trim()) || status === "connecting" || status === "running"}
                  size="sm"
                  type="submit"
                  variant="affirmative"
                >
                  <Send aria-hidden="true" className="size-3.5" /> Send
                </Button>
              </div>
            </Card>
          </form>

        {activityOpen ? (
          <aside className="drawer-right relative z-20 col-start-1 row-start-2 flex min-h-0 w-[var(--activity-width)] max-w-[calc(100vw-3rem)] flex-col justify-self-end self-stretch border-l bg-sidebar shadow-[-8px_0_24px_rgba(31,31,30,0.1)] lg:max-w-none">
            <div
              aria-label="Resize activity panel"
              className="group absolute inset-y-0 -left-1 z-30 hidden w-2 cursor-col-resize touch-none lg:block"
              role="separator"
              onDoubleClick={() => setActivityWidth(DEFAULT_ACTIVITY_WIDTH)}
              onPointerCancel={() => (resizeRef.current = null)}
              onPointerDown={(event) => startResize("activity", event)}
              onPointerMove={resizePanel}
              onPointerUp={() => (resizeRef.current = null)}
            >
              <span className="absolute inset-y-0 left-1/2 w-px bg-transparent group-hover:bg-border" />
            </div>
            <header className="flex h-14 shrink-0 items-center justify-between border-b px-3">
              <div className="flex items-center gap-2">
                <Button
                  aria-label="Close activity"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onClick={() => setActivityOpen(false)}
                >
                  <Minimize2 aria-hidden="true" className="size-4" />
                </Button>
                <p className="text-sm font-semibold">Activity</p>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">
                  {iterationCount} {iterationCount === 1 ? "iteration" : "iterations"}
                </span>
                <CopyButton
                  className=""
                  content={JSON.stringify(visibleEvents, null, 2)}
                  label="Copy activity"
                />
              </div>
            </header>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
            {eventGroups.length ? (
              eventGroups.map((group, groupIndex) => (
                <section className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0" key={`${group.iteration}-${groupIndex}`}>
                  <div className="flex items-center justify-between px-1.5">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold">
                        {group.iteration === null ? "Initialization" : `Iteration ${group.iteration}`}
                      </p>
                      <Badge className="h-5 rounded-sm px-1.5 text-xs">
                        {group.events.length} {group.events.length === 1 ? "event" : "events"}
                      </Badge>
                    </div>
                    {group.createdAt ? (
                      <time className="text-xs text-muted-foreground" dateTime={group.createdAt}>
                        {formatTimestamp(group.createdAt)}
                      </time>
                    ) : null}
                  </div>
                  {group.events.map((runtimeEvent, eventIndex) => {
                    const isToolEvent = runtimeEvent.type.startsWith("tool.");
                    const isFailedEvent = runtimeEvent.type.endsWith(".failed");
                    const toolCall = runtimeEvent.payload.tool_call as
                      | { name?: string; arguments?: Record<string, unknown> }
                      | undefined;
                    const result = runtimeEvent.payload.result as
                      | { output?: string; error?: string }
                      | undefined;
                    const { iteration: _, run_id: __, ...eventPayload } = runtimeEvent.payload;

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
                            <p className="font-medium">
                              {toolCall?.name || "tool"}
                            </p>
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
                </section>
              ))
            ) : (
              <p className="px-2 py-8 text-center text-sm leading-6 text-muted-foreground">
                Tool calls, model events, and run details will appear here.
              </p>
            )}
            <div ref={activityBottomRef} />
            </div>
          </aside>
        ) : null}
        </section>

        {contextVisible ? (
          <aside
            className={`drawer-right fixed top-14 right-0 bottom-0 z-40 flex w-[var(--context-column-width)] max-w-[calc(100vw-3rem)] min-h-0 flex-col border-l bg-sidebar shadow-[-12px_0_30px_rgba(31,31,30,0.12)] lg:max-w-none ${
              contextPinnedOpen
                ? "lg:relative lg:inset-y-auto lg:z-auto lg:shadow-none"
                : "lg:absolute lg:top-14 lg:right-0 lg:bottom-0 lg:z-20"
            }`}
            onMouseEnter={holdPanelPreview}
            onMouseLeave={() => {
              if (!contextPinnedOpen) closePanelPreview(setContextPreviewOpen);
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
                className={`flex h-14 shrink-0 items-center justify-between border-b px-3 ${desktop ? "titlebar-drag" : ""}`}
                style={desktopWindowControls ? { paddingRight: `${144 / uiScale}px` } : undefined}
              >
              <div className="flex items-center gap-2">
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
                <p className="text-sm font-semibold">Context</p>
              </div>
              <span className="text-xs text-muted-foreground">
                {threadContext
                  ? `${threadContext.messages.length} entries`
                  : "Empty"}
              </span>
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
                <span>New thread</span>
                <ShortcutKeys keys={[SHORTCUT_LABEL, "T"]} />
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
        open={Boolean(threadToDelete || error)}
        onOpenChange={(open) => {
          if (!open) {
            setThreadToDelete(null);
            setError("");
          }
        }}
      >
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Backdrop
            className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[1px]"
            onClick={() => {
              setThreadToDelete(null);
              setError("");
            }}
          />
          <AlertDialogPrimitive.Viewport
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return;
              setThreadToDelete(null);
              setError("");
            }}
          >
            <AlertDialogPrimitive.Popup className="w-full min-w-0 max-w-md overflow-hidden rounded-xl border bg-card p-5 text-card-foreground shadow-xl outline-none">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (threadToDelete) void deleteThread();
                  else setError("");
                }}
              >
                <AlertDialogPrimitive.Title className="text-base font-semibold">
                  {threadToDelete ? "Delete thread?" : "Something went wrong"}
                </AlertDialogPrimitive.Title>
                <AlertDialogPrimitive.Description className="mt-2 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-muted-foreground">
                  {threadToDelete
                    ? `This will permanently delete "${threadToDelete.title}" and its activity.`
                    : error}
                </AlertDialogPrimitive.Description>
                <div className="mt-5 flex justify-end gap-2">
                  {!threadToDelete ? (
                    <CopyButton className="mr-auto" content={error} label="Copy error" />
                  ) : null}
                  {threadToDelete ? (
                    <AlertDialogPrimitive.Close
                      render={<Button type="button" variant="outline">Cancel</Button>}
                    />
                  ) : null}
                  <Button type="submit" variant={threadToDelete ? "destructive" : "default"}>
                    {threadToDelete ? "Delete" : "Dismiss"}
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
