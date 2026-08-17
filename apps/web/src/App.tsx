import { FormEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  type: string;
  payload: Record<string, unknown>;
  created_at?: string;
};

type ThreadSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type ThreadTurn = {
  id: number;
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

export default function App() {
  const [task, setTask] = useState("");
  const [workspacePath, setWorkspacePath] = useState(".");
  const [status, setStatus] = useState("idle");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<ThreadSummary | null>(null);
  const [threadTurns, setThreadTurns] = useState<ThreadTurn[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [assistantText, setAssistantText] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [finalizedByIterationLimit, setFinalizedByIterationLimit] = useState(false);
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const feedBottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    feedBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events, assistantText, status, error]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    void refreshThreads();
  }, []);

  async function refreshThreads() {
    try {
      const response = await fetch("/threads");
      if (!response.ok) {
        return;
      }
      const payload = await readJson<{ threads: ThreadSummary[] }>(response);
      setThreads(payload.threads);
    } catch {
      setError("Could not load threads. Is the API running?");
    }
  }

  async function openThread(threadId: string) {
    try {
      const response = await fetch(`/threads/${threadId}`);
      if (!response.ok) {
        setError("Could not open this thread.");
        return;
      }
      const payload = await readJson<ThreadDetail>(response);
      setActiveThread(payload.thread);
      setThreadTurns(payload.turns);
      setEvents(payload.events);
      setAssistantText("");
      setEditingTitle(false);
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
    setFinalizedByIterationLimit(false);
    setError("");
    setStatus("idle");
    setTask("");
  }

  async function renameActiveThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeThread) {
      return;
    }

    try {
      const response = await fetch(`/threads/${activeThread.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: titleDraft }),
      });
      if (!response.ok) {
        setError("Could not rename this thread.");
        return;
      }
      const thread = await readJson<ThreadSummary>(response);
      setActiveThread(thread);
      setThreads((current) => current.map((item) => (item.id === thread.id ? thread : item)));
      setEditingTitle(false);
    } catch {
      setError("Could not rename this thread.");
    }
  }

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    socketRef.current?.close();

    const thread = activeThread;

    setStatus("connecting");
    setEvents([]);
    setAssistantText("");
    setFinalizedByIterationLimit(false);
    setError("");
    setThreadTurns((current) => [
      ...current,
      { id: Date.now(), role: "user", content: task, created_at: new Date().toISOString() },
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
        void openThread(payload.payload.thread_id);
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

  return (
    <main className="bg-[#f7f7f5] text-[#1b1b1a] lg:h-screen lg:overflow-hidden">
      <section className="mx-auto grid max-w-[1800px] lg:h-screen lg:grid-cols-[272px_minmax(0,1fr)_340px]">
        <aside className="flex min-h-0 flex-col border-b border-[#e7e7e1] bg-[#f6f6f2] lg:border-b-0 lg:border-r">
          <header className="flex h-14 shrink-0 items-center border-b border-[#e7e7e1] px-3">
            <button
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-[#d9d9d2] bg-white px-3 py-2 text-sm font-semibold text-[#20201e] transition hover:bg-[#fdfdfb]"
              type="button"
              onClick={startNewThread}
            >
              <span className="text-lg font-normal leading-none">+</span> New chat
            </button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#777770]">
              Recent threads
            </p>
            <nav className="mt-3 space-y-1 overflow-y-auto pr-1">
              {threads.length ? (
                threads.map((thread) => (
                  <button
                    className={`block w-full cursor-pointer rounded-md px-3 py-2 text-left transition ${
                      activeThread?.id === thread.id
                        ? "bg-[#e8e8e2] text-[#20201e]"
                        : "text-[#5d5d57] hover:bg-[#ecece7] hover:text-[#20201e]"
                    }`}
                    key={thread.id}
                    type="button"
                    onClick={() => void openThread(thread.id)}
                  >
                    <span className="block truncate text-sm">{thread.title}</span>
                    <span className="mt-0.5 block text-xs text-[#85857e]">
                      {formatTimestamp(thread.updated_at)}
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-4 text-sm text-[#777770]">Your chats will appear here.</p>
              )}
            </nav>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col bg-[#fcfcfa] lg:h-screen">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#e7e7e1] px-3">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8b8b84]">Conversation</p>
              {editingTitle ? (
                <form className="mt-1 flex items-center gap-2" onSubmit={renameActiveThread}>
                  <input
                    autoFocus
                    className="min-w-0 rounded-md border border-[#cfcfc8] bg-white px-2 py-1 text-sm font-semibold outline-none focus:border-[#777770]"
                    maxLength={80}
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                  />
                  <button className="cursor-pointer text-xs font-semibold text-[#50504b] hover:text-[#1b1b1a]" type="submit">
                    Save
                  </button>
                  <button
                    className="cursor-pointer text-xs text-[#777770] hover:text-[#1b1b1a]"
                    type="button"
                    onClick={() => setEditingTitle(false)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="mt-1 flex items-center gap-2">
                  <h2 className="truncate text-xl font-semibold tracking-tight">
                    {activeThread?.title || "New chat"}
                  </h2>
                  {activeThread ? (
                    <button
                      aria-label="Rename thread"
                      className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-[#777770] transition hover:bg-[#ecece7] hover:text-[#1b1b1a]"
                      type="button"
                      onClick={() => {
                        setTitleDraft(activeThread.title);
                        setEditingTitle(true);
                      }}
                    >
                      <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
                        <path
                          d="M13.5 6.5 17.5 10.5M4 20l4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.7"
                        />
                      </svg>
                    </button>
                  ) : null}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs">
              {finalizedByIterationLimit ? (
                <span className="rounded-full bg-amber-100 px-2 py-1 font-semibold text-amber-800">
                  Limit reached
                </span>
              ) : null}
              <span
                className={`size-2 rounded-full ${
                  status === "failed" ? "bg-red-500" : status === "running" ? "bg-amber-500" : "bg-emerald-500"
                }`}
              />
              <span className="capitalize text-[#666660]">{status}</span>
            </div>
          </header>

          {error ? (
            <div className="mx-auto mt-3 w-[min(100%-2rem,720px)] rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <div className="mx-auto w-full max-w-3xl space-y-3">
              {threadTurns.length ? (
                threadTurns.map((turn) => (
                  <article
                    className={
                      turn.role === "assistant"
                        ? "message-in flex gap-3"
                        : "message-in ml-auto max-w-[82%] rounded-2xl bg-[#ecece7] px-4 py-3"
                    }
                    key={turn.id}
                  >
                    {turn.role === "assistant" ? (
                      <div className="border-l-2 border-[#d8d8d1] pl-3">
                        <AssistantMarkdown content={turn.content} />
                        <time className="mt-2 block text-xs text-[#85857e]" dateTime={turn.created_at}>
                          {formatTimestamp(turn.created_at)}
                        </time>
                      </div>
                    ) : (
                      <div>
                        <p className="whitespace-pre-wrap text-sm leading-7">{turn.content}</p>
                        <time className="mt-2 block text-xs text-[#85857e]" dateTime={turn.created_at}>
                          {formatTimestamp(turn.created_at)}
                        </time>
                      </div>
                    )}
                  </article>
                ))
              ) : null}
              {status === "running" && assistantText ? (
                <article className="message-in border-l-2 border-[#d8d8d1] pl-3">
                  <AssistantMarkdown content={assistantText} />
                </article>
              ) : null}
              {finalizedByIterationLimit ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  Iteration limit reached. This response was generated from the work completed so far.
                </p>
              ) : null}
            </div>
          </div>

          <form className="border-t border-[#e7e7e1] bg-[#fcfcfa] px-3 py-3" onSubmit={startRun}>
            <div className="mx-auto max-w-3xl rounded-2xl border border-[#d8d8d1] bg-white p-2 shadow-[0_12px_35px_rgba(31,31,30,0.07)]">
              <textarea
                className="min-h-24 w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-[#97978f]"
                placeholder={'Inspect the repo, search for "AgentRuntime", run tests, and show git diff'}
                value={task}
                onChange={(event) => setTask(event.target.value)}
              />
              <div className="flex items-center justify-between gap-3 px-1 pt-1">
                <label className="min-w-0 text-xs text-[#777770]">
                  <span className="sr-only">Workspace path</span>
                  <input
                    className="w-36 bg-transparent outline-none placeholder:text-[#a0a09a] sm:w-52"
                    value={workspacePath}
                    onChange={(event) => setWorkspacePath(event.target.value)}
                    placeholder="Workspace path"
                  />
                </label>
                <button
                  className="cursor-pointer rounded-xl bg-[#30302d] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#1f1f1e] disabled:cursor-not-allowed disabled:bg-[#b5b5ae]"
                  disabled={!task.trim() || status === "connecting" || status === "running"}
                  type="submit"
                >
                  Send
                </button>
              </div>
            </div>
          </form>
        </section>

        <aside className="flex min-h-0 flex-col border-t border-[#e7e7e1] bg-[#f6f6f2] lg:h-screen lg:border-t-0 lg:border-l">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#e1e1db] px-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#888880]">Run inspector</p>
              <p className="mt-1 text-sm font-semibold">Activity</p>
            </div>
            <span className="rounded-full bg-[#e5e5de] px-2 py-1 text-xs text-[#65655e]">{events.length}</span>
          </header>
          <div className="max-h-[45vh] min-h-0 flex-1 space-y-3 overflow-y-auto p-3 lg:max-h-none">
            {events.length ? (
              events.map((runtimeEvent, index) => {
                const isToolEvent = runtimeEvent.type.startsWith("tool.");
                const toolCall = runtimeEvent.payload.tool_call as
                  | { name?: string; arguments?: Record<string, unknown> }
                  | undefined;
                const result = runtimeEvent.payload.result as
                  | { output?: string; error?: string }
                  | undefined;

                return (
                  <article
                    key={`${runtimeEvent.type}-${index}`}
                    className={`rounded-xl border p-3 text-sm ${
                      runtimeEvent.type === "tool.failed"
                        ? "border-red-200 bg-red-50"
                      : runtimeEvent.type === "tool.completed"
                          ? "border-emerald-200 bg-emerald-50"
                          : "border-[#e1e1db] bg-[#fcfcfa]"
                    }`}
                  >
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#7c7c75]">
                      {runtimeEvent.type.replaceAll(".", " ")}
                    </p>
                    {runtimeEvent.created_at ? (
                      <time className="mt-1 block text-xs text-[#85857e]" dateTime={runtimeEvent.created_at}>
                        {formatTimestamp(runtimeEvent.created_at)}
                      </time>
                    ) : null}

                    {isToolEvent ? (
                      <div className="mt-2 space-y-2">
                        <p className="font-medium text-[#252523]">
                          {toolCall?.name || "tool"}
                        </p>
                        <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-[#666660]">
                          {JSON.stringify(toolCall?.arguments ?? {}, null, 2)}
                        </pre>
                        {result?.output ? (
                          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-[#e5e5de] bg-white p-2 text-xs text-[#55554f]">
                            {String(result.output).slice(0, 1200)}
                          </pre>
                        ) : null}
                        {result?.error ? (
                          <p className="text-xs text-red-700">{String(result.error)}</p>
                        ) : null}
                      </div>
                    ) : (
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-[#666660]">
                        {JSON.stringify(runtimeEvent.payload, null, 2)}
                      </pre>
                    )}
                  </article>
                );
              })
            ) : (
              <p className="px-2 py-8 text-center text-sm leading-6 text-[#81817a]">
                Tool calls, model events, and run details will appear here.
              </p>
            )}
            <div ref={feedBottomRef} />
          </div>
        </aside>
      </section>
    </main>
  );
}
