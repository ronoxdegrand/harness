import { FormEvent, Fragment, useEffect, useRef, useState } from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown, LoaderCircle, PanelLeft, PanelRight, Pencil, Plus, Send, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge, Button, Card, Input, Separator, Textarea } from "@/components/ui";

const MODEL_OPTIONS = [
  "gemini-3-flash",
  "gemini-3-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
];

function selectableModel(model: string) {
  return MODEL_OPTIONS.includes(model) ? model : MODEL_OPTIONS[0];
}

type RunSocketMessage =
  | { kind: "session.ready"; payload: { workspace_root: string } }
  | { kind: "thread.opened"; payload: { thread: ThreadSummary } }
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

type ThreadDetail = {
  thread: ThreadSummary;
  turns: ThreadTurn[];
  events: RuntimeEvent[];
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
  const [lastUsedModel, setLastUsedModel] = useState(MODEL_OPTIONS[0]);
  const [status, setStatus] = useState("idle");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<ThreadSummary | null>(null);
  const [threadToDelete, setThreadToDelete] = useState<ThreadSummary | null>(null);
  const [threadTurns, setThreadTurns] = useState<ThreadTurn[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [assistantText, setAssistantText] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityRunId, setActivityRunId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarPreviewOpen, setSidebarPreviewOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [finalizedByIterationLimit, setFinalizedByIterationLimit] = useState(false);
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const taskInputRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationBottomRef = useRef<HTMLDivElement | null>(null);
  const activityBottomRef = useRef<HTMLDivElement | null>(null);

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
      setAssistantText("");
      setEditingTitle(false);
      setActivityOpen(false);
      setActivityRunId(null);
      if (!preserveIterationLimit) {
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
    setAssistantText("");
    setEditingTitle(false);
    setActivityOpen(false);
    setActivityRunId(null);
    setFinalizedByIterationLimit(false);
    setError("");
    setStatus("idle");
    setTask("");
    setModelName(lastUsedModel);
  }

  async function renameActiveThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeThread) return;
    try {
      const response = await fetch(`/threads/${activeThread.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: titleDraft }),
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
    setLastUsedModel(modelName);

    setStatus("connecting");
    setEvents([]);
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
        content: task,
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
            task,
            workspace_path: workspacePath,
            model_name: modelName,
            ...(thread ? { thread_id: thread.id } : {}),
          }),
        );
        return;
      }

      if (payload.kind === "thread.opened") {
        setActiveThread(payload.payload.thread);
        void refreshThreads();
        return;
      }

      if (payload.kind === "runtime.event") {
        setEvents((current) => [...current, payload.event]);

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

  return (
    <main className="bg-background text-foreground lg:h-screen lg:overflow-hidden">
      <section
        className={`relative mx-auto grid max-w-[1800px] lg:h-screen ${
          sidebarPinnedOpen
            ? activityOpen
              ? "lg:grid-cols-[272px_minmax(0,1fr)_340px]"
              : "lg:grid-cols-[272px_minmax(0,1fr)]"
            : activityOpen
              ? "lg:grid-cols-[minmax(0,1fr)_340px]"
              : "lg:grid-cols-[minmax(0,1fr)]"
        }`}
      >
        {sidebarOpen ? (
          <aside
            className={`flex min-h-0 flex-col border-b bg-sidebar lg:border-b-0 lg:border-r ${
              sidebarPinnedOpen ? "" : "sidebar-preview lg:absolute lg:inset-y-0 lg:left-0 lg:z-20 lg:w-[272px] lg:shadow-[12px_0_30px_rgba(31,31,30,0.12)]"
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

          <div className="flex min-h-0 flex-1 flex-col p-3">
            <nav className="space-y-1 overflow-y-auto pr-1">
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
          </aside>
        ) : null}

        <section className="flex min-h-0 min-w-0 flex-col bg-background lg:h-screen">
          <header className="flex h-14 shrink-0 items-center border-b px-3">
            {!sidebarPinnedOpen ? (
              <div className="mr-2 flex shrink-0 items-center gap-1">
                <Button
                  aria-label="Expand sidebar"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onMouseEnter={() => setSidebarPreviewOpen(true)}
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
            <div className="min-w-0">
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
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-semibold">
                    {activeThread?.title || "New chat"}
                  </h2>
                  {activeThread ? (
                    <Button
                      aria-label="Rename thread"
                      className="size-7 shrink-0 text-muted-foreground"
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setTitleDraft(activeThread.title);
                        setEditingTitle(true);
                      }}
                    >
                      <Pencil aria-hidden="true" className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
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
                            : "message-in ml-auto max-w-[82%] rounded-2xl rounded-br-md bg-secondary px-4 py-3.5 text-secondary-foreground"
                        }
                      >
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
                <article className="message-in">
                  <AssistantMarkdown content={assistantText} />
                </article>
              ) : null}
              <div ref={conversationBottomRef} />
            </div>
          </div>

          <form className="border-t bg-background px-4 py-3 sm:px-5" onSubmit={startRun}>
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
                      <SelectPrimitive.Icon render={<ChevronDown className="size-4 text-muted-foreground" />} />
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
        </section>

        {activityOpen ? (
          <aside className="flex min-h-0 flex-col border-t bg-sidebar lg:h-screen lg:border-t-0 lg:border-l">
            <header className="flex h-14 shrink-0 items-center justify-between border-b px-3">
              <div className="flex items-center gap-2">
                <Button
                  aria-label="Collapse activity"
                  className="size-10 bg-card"
                  size="icon-lg"
                  type="button"
                  variant="outline"
                  onClick={() => setActivityOpen(false)}
                >
                  <PanelRight aria-hidden="true" className="size-4" />
                </Button>
                <p className="text-sm font-semibold">Activity</p>
              </div>
              <span className="text-xs text-muted-foreground">
                {iterationCount} {iterationCount === 1 ? "iteration" : "iterations"}
              </span>
            </header>
            <div className="max-h-[45vh] min-h-0 flex-1 space-y-4 overflow-y-auto p-3 lg:max-h-none">
            {eventGroups.length ? (
              eventGroups.map((group, groupIndex) => (
                <section className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0" key={`${group.iteration}-${groupIndex}`}>
                  <div className="flex items-center justify-between px-1.5">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold">
                        {group.iteration === null ? "Run" : `Iteration ${group.iteration}`}
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
          <AlertDialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[1px]" />
          <AlertDialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
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
