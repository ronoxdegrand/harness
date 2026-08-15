import { FormEvent, useEffect, useRef, useState } from "react";

type RunSocketMessage =
  | { kind: "session.ready"; payload: { workspace_root: string } }
  | { kind: "runtime.event"; event: RuntimeEvent }
  | { kind: "run.completed"; payload: { output_text: string; status: string } }
  | { kind: "run.failed"; error: string }
  | { kind: "run.finished" };

type RuntimeEvent = {
  type: string;
  payload: Record<string, unknown>;
};

const starterTask =
  'inspect the repo, search for "AgentRuntime", run tests, and show git diff';

function getWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws/run`;
}

function formatEventLabel(type: string) {
  return type.replaceAll(".", " ");
}

export default function App() {
  const [task, setTask] = useState(starterTask);
  const [workspacePath, setWorkspacePath] = useState(".");
  const [status, setStatus] = useState("idle");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [assistantText, setAssistantText] = useState("");
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

  function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    socketRef.current?.close();

    setStatus("connecting");
    setEvents([]);
    setAssistantText("");
    setError("");

    const socket = new WebSocket(getWebSocketUrl());
    socketRef.current = socket;

    socket.onmessage = (message) => {
      const payload = JSON.parse(message.data) as RunSocketMessage;

      if (payload.kind === "session.ready") {
        setWorkspaceRoot(payload.payload.workspace_root);
        setStatus("running");
        socket.send(JSON.stringify({ task, workspace_path: workspacePath }));
        return;
      }

      if (payload.kind === "runtime.event") {
        setEvents((current) => [...current, payload.event]);

        if (payload.event.type === "model.delta") {
          const delta = String(payload.event.payload.delta ?? "");
          setAssistantText((current) => (current ? `${current}\n${delta}` : delta));
        }

        if (payload.event.type === "tool.started") {
          const toolName = String(payload.event.payload.tool_call?.name ?? "tool");
          setAssistantText((current) => current || `Running tool: ${toolName}...`);
        }

        if (payload.event.type === "tool.failed") {
          const toolName = String(payload.event.payload.tool_call?.name ?? "tool");
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
        if (payload.payload.output_text.trim()) {
          setAssistantText(payload.payload.output_text);
        }
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
    <main className="min-h-screen bg-[#f4f4f0] px-4 py-6 text-slate-950 sm:px-6">
      <section className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="space-y-4 border border-slate-300 bg-[#fffdf7] p-4">
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
              Milestone 4
            </p>
            <h1 className="text-2xl font-semibold">Agent loop in the browser</h1>
            <p className="text-sm leading-6 text-slate-600">
              Submit a task, stream runtime events, and watch tools execute live.
            </p>
          </div>

          <form className="space-y-3" onSubmit={startRun}>
            <label className="block text-sm font-medium text-slate-700">
              Task
              <textarea
                className="mt-1 min-h-32 w-full border border-slate-300 bg-white p-3 text-sm outline-none"
                value={task}
                onChange={(event) => setTask(event.target.value)}
              />
            </label>

            <label className="block text-sm font-medium text-slate-700">
              Workspace path
              <input
                className="mt-1 w-full border border-slate-300 bg-white p-3 text-sm outline-none"
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
              />
            </label>

            <button
              className="w-full border border-slate-950 bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
              type="submit"
            >
              Run task
            </button>
          </form>

          <div className="space-y-2 border border-slate-200 bg-white p-3 text-xs text-slate-600">
            <p>
              <span className="font-semibold text-slate-900">Status:</span> {status}
            </p>
            <p className="break-all">
              <span className="font-semibold text-slate-900">Workspace root:</span>{" "}
              {workspaceRoot || "connecting..."}
            </p>
          </div>

          {error ? (
            <div className="border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}
        </aside>

        <section className="grid min-h-[80vh] gap-4 lg:grid-rows-[auto_minmax(0,1fr)]">
          <div className="border border-slate-300 bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
              Thread
            </p>
            <div className="mt-3 space-y-3">
              <article className="border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                  User
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-900">{task}</p>
              </article>
              <article className="border border-slate-900 bg-slate-900 p-3 text-slate-50">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
                  Assistant
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                  {assistantText || "Waiting for streamed model output..."}
                </p>
              </article>
            </div>
          </div>

          <div className="overflow-hidden border border-slate-300 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                Activity feed
              </p>
            </div>
            <div className="h-[55vh] space-y-3 overflow-y-auto p-4">
              {events.map((runtimeEvent, index) => {
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
                    className={`border p-3 text-sm ${
                      runtimeEvent.type === "tool.failed"
                        ? "border-red-300 bg-red-50"
                        : runtimeEvent.type === "tool.completed"
                          ? "border-emerald-300 bg-emerald-50"
                          : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                      {formatEventLabel(runtimeEvent.type)}
                    </p>

                    {isToolEvent ? (
                      <div className="mt-2 space-y-2">
                        <p className="font-medium text-slate-900">
                          {toolCall?.name || "tool"}
                        </p>
                        <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-slate-600">
                          {JSON.stringify(toolCall?.arguments ?? {}, null, 2)}
                        </pre>
                        {result?.output ? (
                          <pre className="overflow-x-auto whitespace-pre-wrap border border-slate-200 bg-white p-2 text-xs text-slate-700">
                            {String(result.output).slice(0, 1200)}
                          </pre>
                        ) : null}
                        {result?.error ? (
                          <p className="text-xs text-red-700">{String(result.error)}</p>
                        ) : null}
                      </div>
                    ) : (
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-slate-600">
                        {JSON.stringify(runtimeEvent.payload, null, 2)}
                      </pre>
                    )}
                  </article>
                );
              })}
              <div ref={feedBottomRef} />
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
