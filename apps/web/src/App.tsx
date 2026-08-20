import { type CSSProperties, FormEvent, Fragment, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronUp, Copy, Layers3, LoaderCircle, Minimize2, PanelLeft, Pencil, Plus, Send, Settings2, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge, Button, Card, Input, Separator, Textarea } from "@/components/ui";

const MODEL_OPTIONS = [
  "gemini-3-flash",
  "gemini-3-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
];
const DEFAULT_SIDEBAR_WIDTH = 272;
const DEFAULT_ACTIVITY_WIDTH = 340;
const DEFAULT_CONTEXT_WIDTH = 340;
const MAX_SIDEBAR_WIDTH = 600;
const MAX_ACTIVITY_WIDTH = 720;
const MAX_CONTEXT_WIDTH = 720;

function selectableModel(model: string) {
  return MODEL_OPTIONS.includes(model) ? model : MODEL_OPTIONS[0];
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
  model_name: string;
  created_at: string;
  updated_at: string;
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
  return (
    <Button
      aria-label={label}
      className={`size-7 text-muted-foreground opacity-60 hover:opacity-100 ${className}`}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
      onClick={() => navigator.clipboard.writeText(content).catch(() => undefined)}
    >
      <Copy aria-hidden="true" className="size-3.5" />
    </Button>
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
  const [task, setTask] = useState("");
  const [workspacePath, setWorkspacePath] = useState(".");
  const [modelName, setModelName] = useState(MODEL_OPTIONS[0]);
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("gemini-api-key") || "");
  const [maxIterations, setMaxIterations] = useState(() =>
    Math.min(Math.max(Number(localStorage.getItem("max-iterations")) || 8, 1), 50),
  );
  const [lastUsedModel, setLastUsedModel] = useState(MODEL_OPTIONS[0]);
  const [status, setStatus] = useState("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<ThreadSummary | null>(null);
  const [threadToDelete, setThreadToDelete] = useState<ThreadSummary | null>(null);
  const [threadTurns, setThreadTurns] = useState<ThreadTurn[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [threadContext, setThreadContext] = useState<ContextState | null>(null);
  const [assistantText, setAssistantText] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  const [activityRunId, setActivityRunId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarPreviewOpen, setSidebarPreviewOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Math.min(Math.max(Number(localStorage.getItem("sidebar-width")) || DEFAULT_SIDEBAR_WIDTH, 220), MAX_SIDEBAR_WIDTH),
  );
  const [activityWidth, setActivityWidth] = useState(() =>
    Math.min(Math.max(Number(localStorage.getItem("activity-width")) || DEFAULT_ACTIVITY_WIDTH, 280), MAX_ACTIVITY_WIDTH),
  );
  const [contextWidth, setContextWidth] = useState(() =>
    Math.min(Math.max(Number(localStorage.getItem("context-width")) || DEFAULT_CONTEXT_WIDTH, 280), MAX_CONTEXT_WIDTH),
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [newThreadTitle, setNewThreadTitle] = useState<string | null>(null);
  const [finalizedByIterationLimit, setFinalizedByIterationLimit] = useState(false);
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const taskInputRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationBottomRef = useRef<HTMLDivElement | null>(null);
  const activityBottomRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<{ panel: "sidebar" | "activity" | "context"; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    conversationBottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    if (activityOpen) {
      activityBottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [activityOpen, events, assistantText, status]);

  useEffect(() => {
    const input = taskInputRef.current;
    if (!input) {
      return;
    }
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [task]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem("activity-width", String(activityWidth));
  }, [activityWidth]);

  useEffect(() => {
    localStorage.setItem("context-width", String(contextWidth));
  }, [contextWidth]);

  useEffect(() => {
    sessionStorage.setItem("gemini-api-key", apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem("max-iterations", String(maxIterations));
  }, [maxIterations]);

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
        const latestModel = selectableModel(payload.threads[0].model_name);
        setModelName(latestModel);
        setLastUsedModel(latestModel);
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
      setActiveThread(payload.thread);
      setModelName(selectableModel(payload.thread.model_name));
      setThreadTurns(payload.turns);
      setEvents(payload.events);
      setThreadContext(payload.context);
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
    setActiveThread(null);
    setThreadTurns([]);
    setEvents([]);
    setThreadContext(null);
    setAssistantText("");
    setEditingTitle(false);
    setActivityOpen(false);
    setActivityRunId(null);
    setFinalizedByIterationLimit(false);
    setError("");
    setStatus("idle");
    setTask("");
    setNewThreadTitle(null);
    setModelName(lastUsedModel);
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
    socketRef.current?.close();

    const thread = activeThread;
    const submittedTask = task;
    setLastUsedModel(modelName);

    setStatus("connecting");
    setTask("");
    setAssistantText("");
    setActivityOpen(false);
    setActivityRunId(null);
    setFinalizedByIterationLimit(false);
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
            ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
            ...(thread ? { thread_id: thread.id } : {}),
            ...(!thread && newThreadTitle ? { title: newThreadTitle } : {}),
          }),
        );
        return;
      }

      if (payload.kind === "thread.opened") {
        setActiveThread(payload.payload.thread);
        setThreadTurns((current) => {
          const pending = current.at(-1);
          if (pending?.role !== "user" || pending.run_id !== null) return current;
          return [...current.slice(0, -1), { ...pending, run_id: payload.payload.run_id }];
        });
        void refreshThreads();
        return;
      }

      if (payload.kind === "runtime.event") {
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

        if (payload.event.type === "tool.failed") {
          const toolCall = payload.event.payload.tool_call as Record<string, unknown> | undefined;
          const toolName = typeof toolCall?.name === "string" ? toolCall.name : "tool";
          const result = payload.event.payload.result as Record<string, unknown> | undefined;
          const output = typeof result?.output === "string" ? result.output : "Tool failed.";
          setStatus("failed");
          setError(`Tool failed: ${toolName}. ${output}`);
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

      if (payload.kind === "run.completed") {
        setStatus(payload.payload.status);
        setFinalizedByIterationLimit(payload.payload.finalized_by_iteration_limit);
        if (payload.payload.output_text.trim()) {
          setAssistantText(payload.payload.output_text);
        }
        void openThread(payload.payload.thread_id, true);
        void refreshThreads();
        return;
      }

      if (payload.kind === "run.failed") {
        setStatus("failed");
        setError(payload.error);
        setAssistantText((current) => current || "The run failed.");
        return;
      }

      if (payload.kind === "run.finished") {
        setStatus((current) => (current === "running" ? "completed" : current));
        socket.close();
      }
    };

    socket.onerror = () => {
      setStatus("failed");
      setError("WebSocket connection failed.");
    };
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

  const visibleEvents = activityRunId
    ? events.filter((runtimeEvent) => eventRunId(runtimeEvent) === activityRunId)
    : events;
  const sidebarPinnedOpen = !sidebarCollapsed;
  const sidebarOpen = sidebarPinnedOpen || sidebarPreviewOpen;
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
  const layoutColumns = [
    sidebarPinnedOpen ? "var(--sidebar-width)" : null,
    "minmax(0,1fr)",
    contextOpen ? "var(--context-column-width)" : null,
  ].filter(Boolean).join(" ");

  return (
    <main className="bg-background text-foreground lg:h-screen lg:overflow-hidden">
      <section
        style={{
          "--sidebar-width": `${sidebarWidth}px`,
          "--activity-width": `${activityWidth}px`,
          "--context-column-width": `${contextWidth}px`,
          "--layout-columns": layoutColumns,
        } as CSSProperties}
        className="relative grid w-full lg:h-screen lg:grid-cols-[var(--layout-columns)]"
      >
        {sidebarOpen ? (
          <aside
            className={`relative flex min-h-0 flex-col border-b bg-sidebar lg:border-b-0 lg:border-r ${
              sidebarPinnedOpen ? "" : "sidebar-preview lg:absolute lg:inset-y-0 lg:left-0 lg:z-20 lg:w-[var(--sidebar-width)] lg:shadow-[12px_0_30px_rgba(31,31,30,0.12)]"
            }`}
            onMouseLeave={() => {
              if (!sidebarPinnedOpen) {
                setSidebarPreviewOpen(false);
              }
            }}
          >
          <header className="flex h-14 shrink-0 items-center gap-1.5 border-b px-3">
                <Button
                  aria-label={sidebarPreviewOpen ? "Pin sidebar" : "Collapse sidebar"}
                  className="size-10 shrink-0 bg-card"
                  size="icon-lg"
                  variant="outline"
                  type="button"
                  onClick={() => {
                    if (sidebarPreviewOpen) {
                      setSidebarCollapsed(false);
                      setSidebarPreviewOpen(false);
                    } else {
                      setSidebarCollapsed(true);
                    }
                  }}
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

          <div className="flex min-h-0 flex-1 flex-col py-3 pl-3">
            <nav className="space-y-1 overflow-y-auto pr-3">
              {threads.length ? (
                threads.map((thread) => (
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
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {formatTimestamp(thread.updated_at)}
                        </span>
                      </span>
                    </Button>
                    <Button
                      aria-label={`Delete ${thread.title}`}
                      className="absolute top-1/2 right-1.5 size-7 -translate-y-1/2 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-destructive"
                      disabled={activeThread?.id === thread.id && (status === "connecting" || status === "running")}
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
                  </div>
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

        <section className="relative flex min-h-0 min-w-0 flex-col bg-background lg:grid lg:h-screen lg:grid-cols-1 lg:grid-rows-[56px_minmax(0,1fr)_auto]">
          <header className="relative z-30 col-start-1 row-start-1 flex h-14 shrink-0 items-center border-b bg-background px-4 sm:px-5">
            {!sidebarPinnedOpen ? (
              <div className="absolute left-3 flex shrink-0 items-center gap-1">
                <Button
                  aria-label="Expand sidebar"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onMouseEnter={() => setSidebarPreviewOpen(true)}
                  onClick={() => {
                    setSidebarCollapsed(false);
                    setSidebarPreviewOpen(false);
                  }}
                >
                  <PanelLeft aria-hidden="true" className="size-4" />
                </Button>
                <Button
                  aria-label="New chat"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onClick={startNewThread}
                >
                  <Plus aria-hidden="true" className="size-4" />
                </Button>
              </div>
            ) : null}
            <div className={`mx-auto min-w-0 w-full max-w-3xl ${!sidebarPinnedOpen ? "max-lg:pl-24" : ""} ${!contextOpen ? "pr-24" : "pr-12"}`}>
              {editingTitle ? (
                <form className="flex items-center gap-2" onSubmit={renameActiveThread}>
                  <Input
                    autoFocus
                    className="h-8 min-w-0 bg-card text-sm font-semibold"
                    maxLength={80}
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                  />
                  <Button className="h-7 px-2" size="sm" type="submit" variant="ghost">
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
                <div className={`flex items-center gap-2 ${activeThread ? "" : "justify-center"}`}>
                  <h2 className="truncate text-sm font-semibold">
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
            <div className="absolute right-3 flex items-center gap-1">
              <DialogPrimitive.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
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
                    className="fixed inset-0 z-40 bg-black/10"
                    onClick={() => setSettingsOpen(false)}
                  />
                  <DialogPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
                    <DialogPrimitive.Popup className="pointer-events-auto w-full max-w-sm rounded-xl border bg-card p-4 text-card-foreground shadow-xl outline-none">
                      <DialogPrimitive.Title className="text-sm font-semibold">Settings</DialogPrimitive.Title>
                      <DialogPrimitive.Description className="mt-1 text-xs leading-5 text-muted-foreground">
                        Applied to new runs.
                      </DialogPrimitive.Description>
                      <div className="mt-4 space-y-4">
                        <label className="block space-y-1.5 text-xs font-medium">
                          <span>Gemini API key</span>
                          <Input
                            autoComplete="off"
                            placeholder="Use server key when empty"
                            type="password"
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                          />
                          <span className="block font-normal leading-4 text-muted-foreground">
                            Kept only in this browser tab.
                          </span>
                        </label>
                        <label className="block space-y-1.5 text-xs font-medium">
                          <span>Max iterations</span>
                          <Input
                            max={50}
                            min={1}
                            type="number"
                            value={maxIterations}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              if (Number.isInteger(value)) setMaxIterations(Math.min(Math.max(value, 1), 50));
                            }}
                          />
                        </label>
                      </div>
                      <div className="mt-5 flex justify-end">
                        <DialogPrimitive.Close render={<Button type="button">Done</Button>} />
                      </div>
                    </DialogPrimitive.Popup>
                  </DialogPrimitive.Viewport>
                </DialogPrimitive.Portal>
              </DialogPrimitive.Root>
              {!contextOpen ? (
                <Button
                  aria-label="Open context"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onClick={() => setContextOpen(true)}
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
                            ? "message-in relative pr-10"
                            : "message-in relative ml-auto max-w-[82%] rounded-2xl rounded-br-md bg-secondary px-4 py-3.5 pr-10 text-secondary-foreground"
                        }
                      >
                        <CopyButton className={turn.role === "assistant" ? "absolute top-0 right-0" : "absolute top-2 right-2"} content={turn.content} />
                        {turn.role === "assistant" ? (
                          <div>
                            <AssistantMarkdown content={turn.content} />
                            <time className="mt-2 block text-xs text-muted-foreground" dateTime={turn.created_at}>
                              {formatTimestamp(turn.created_at)}
                            </time>
                          </div>
                        ) : (
                          <div>
                            <p className="whitespace-pre-wrap text-sm leading-7">{turn.content}</p>
                            <time className="mt-2 block text-xs text-muted-foreground" dateTime={turn.created_at}>
                              {formatTimestamp(turn.created_at)}
                            </time>
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
                            <Badge className="bg-amber-100 text-amber-800">
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
                <article className="message-in relative pr-10">
                  <CopyButton className="absolute top-0 right-0" content={assistantText} />
                  <AssistantMarkdown content={assistantText} />
                </article>
              ) : null}
              <div ref={conversationBottomRef} />
            </div>
          </div>

          <form className="relative z-30 col-start-1 row-start-3 border-t bg-background px-4 py-3 sm:px-5" onSubmit={startRun}>
            <Card className="mx-auto max-w-3xl rounded-2xl p-2 shadow-sm transition-shadow focus-within:shadow-md">
              <Textarea
                ref={taskInputRef}
                className="min-h-16 max-h-60 resize-none overflow-y-auto border-0 bg-transparent px-3 py-2 text-sm leading-6 shadow-none focus-visible:ring-0"
                placeholder={'Inspect the repo, search for "AgentRuntime", run tests, and show git diff'}
                value={task}
                onChange={(event) => setTask(event.target.value)}
              />
              <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
                <label className="mr-auto min-w-0 text-xs text-muted-foreground">
                  <span className="sr-only">Workspace path</span>
                  <Input
                    className="h-7 w-36 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0 sm:w-52"
                    value={workspacePath}
                    onChange={(event) => setWorkspacePath(event.target.value)}
                    placeholder="Workspace path"
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  <span className="sr-only">Model</span>
                  <SelectPrimitive.Root
                    value={modelName}
                    onValueChange={(value) => value && setModelName(value as string)}
                  >
                    <SelectPrimitive.Trigger className="flex h-8 w-48 cursor-pointer items-center justify-between gap-1.5 rounded-lg bg-transparent px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                      <SelectPrimitive.Value />
                      <SelectPrimitive.Icon render={<ChevronUp className="size-4 text-muted-foreground" />} />
                    </SelectPrimitive.Trigger>
                    <SelectPrimitive.Portal>
                      <SelectPrimitive.Positioner alignItemWithTrigger sideOffset={4} className="z-50">
                        <SelectPrimitive.Popup className="min-w-48 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                          <SelectPrimitive.List>
                            {MODEL_OPTIONS.map((model) => (
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
                            ))}
                          </SelectPrimitive.List>
                        </SelectPrimitive.Popup>
                      </SelectPrimitive.Positioner>
                    </SelectPrimitive.Portal>
                  </SelectPrimitive.Root>
                </label>
                {status === "connecting" || status === "running" ? (
                  <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                    Working
                  </span>
                ) : null}
                <Button
                  className="h-8 px-3 text-xs font-semibold"
                  disabled={!task.trim() || status === "connecting" || status === "running"}
                  size="sm"
                  type="submit"
                >
                  <Send aria-hidden="true" className="size-3.5" /> Send
                </Button>
              </div>
            </Card>
          </form>

        {activityOpen ? (
          <aside className="relative flex min-h-0 flex-col border-t bg-sidebar lg:col-start-1 lg:row-start-2 lg:z-20 lg:w-[var(--activity-width)] lg:justify-self-end lg:self-stretch lg:border-t-0 lg:border-l lg:shadow-[-8px_0_24px_rgba(31,31,30,0.1)]">
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
            <div className="max-h-[45vh] min-h-0 flex-1 space-y-4 overflow-y-auto p-3 lg:max-h-none">
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
                              ? "border-emerald-200 bg-emerald-50"
                              : "bg-card"
                        }`}
                      >
                        <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${
                          isFailedEvent ? "text-destructive" : "text-muted-foreground"
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
                              <p className="text-xs text-red-700">{String(result.error)}</p>
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

        {contextOpen ? (
          <aside className="relative flex min-h-0 flex-col border-t bg-sidebar lg:h-screen lg:border-t-0 lg:border-l">
            {contextOpen ? (
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
            <header className="flex h-14 shrink-0 items-center justify-between border-b px-3">
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
                {contextOpen ? <p className="text-sm font-semibold">Context</p> : null}
              </div>
              {contextOpen ? <span className="text-xs text-muted-foreground">
                {threadContext
                  ? `${threadContext.messages.length} entries`
                  : "Empty"}
              </span> : null}
            </header>
            {contextOpen ? (
            <div className="max-h-[45vh] min-h-0 flex-1 space-y-4 overflow-y-auto p-3 lg:max-h-none">
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
                    <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-blue-500" />Pinned</span>
                    <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-500" />Included</span>
                    <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-amber-500" />Truncated</span>
                    <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-muted-foreground" />Excluded</span>
                  </div>
                  <div className="space-y-1.5">
                    {threadContext.messages.map((message) => (
                      <div
                        className={`rounded-lg border bg-card p-3 ${message.included ? "" : "opacity-45"}`}
                        key={message.index}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`size-2 rounded-full ${
                            !message.included
                              ? "bg-muted-foreground"
                              : message.truncated
                                ? "bg-amber-500"
                                : message.pinned
                                  ? "bg-blue-500"
                                  : "bg-emerald-500"
                          }`} />
                          <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">
                            {message.name || message.role}
                          </span>
                          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                            ~{message.tokens.toLocaleString()} tok
                          </span>
                        </div>
                        <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">
                          {message.preview || "Empty message"}
                        </p>
                        {message.pinned || message.truncated || !message.included ? (
                          <p className={`mt-2 text-[10px] font-semibold uppercase tracking-[0.1em] ${
                            !message.included
                              ? "text-muted-foreground"
                              : message.truncated
                                ? "text-amber-700"
                                : "text-blue-700"
                          }`}>
                            {message.truncated
                              ? message.pinned ? "Pinned | truncated" : "Truncated to fit"
                              : message.pinned ? "Latest instruction | pinned" : "Outside window"}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="px-2 py-8 text-center text-sm leading-6 text-muted-foreground">
                  Context will appear when a run starts.
                </p>
              )}
            </div>
            ) : null}
          </aside>
        ) : null}
      </section>
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
              <AlertDialogPrimitive.Title className="text-base font-semibold">
                {threadToDelete ? "Delete thread?" : "Something went wrong"}
              </AlertDialogPrimitive.Title>
              <AlertDialogPrimitive.Description className="mt-2 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-muted-foreground">
                {threadToDelete
                  ? `This will permanently delete "${threadToDelete.title}" and its activity.`
                  : error}
              </AlertDialogPrimitive.Description>
              <div className="mt-5 flex justify-end gap-2">
                <AlertDialogPrimitive.Close
                  render={<Button type="button" variant="outline">{threadToDelete ? "Cancel" : "Dismiss"}</Button>}
                />
                {threadToDelete ? (
                  <Button type="button" variant="destructive" onClick={() => void deleteThread()}>
                    Delete
                  </Button>
                ) : null}
              </div>
            </AlertDialogPrimitive.Popup>
          </AlertDialogPrimitive.Viewport>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </main>
  );
}
