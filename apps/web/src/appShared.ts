export const DEFAULT_SIDEBAR_WIDTH = 272;
export const DEFAULT_ACTIVITY_WIDTH = 420;
export const MIN_ACTIVITY_WIDTH = 400;
export const DEFAULT_CONTEXT_WIDTH = 340;
export const DEFAULT_GIT_WIDTH = 340;
export const DEFAULT_DIFF_WIDTH = 760;
export const MIN_SPLIT_DIFF_WIDTH = 720;
export const LARGE_DIFF_SIDEBAR_BREAKPOINT = 1800;
export const MIN_THREAD_WIDTH_WITH_ACTIVITY = 480;
export const ACTIVITY_LAYOUT_GAP = 16;
export const CONVERSATION_HORIZONTAL_GUTTER = 48;
export const MAX_SIDEBAR_WIDTH = 600;
export const MAX_ACTIVITY_WIDTH = 720;
export const MAX_CONTEXT_WIDTH = 720;
export const MAX_GIT_WIDTH = 720;
export const MAX_DIFF_WIDTH = 1800;
export const GIT_REFRESH_INTERVAL_MS = 5000;
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const SHORTCUT_KEY = IS_MAC ? "Meta" : "Control";
export const SHORTCUT_LABEL = IS_MAC ? "Cmd" : "Ctrl";

export type Appearance = "light" | "dark" | "system";
export type ThreadSort = "recent-message" | "created";
export type MidRunEnterAction = "queue" | "steer";
export type ModelOption = { id: string; provider: "gemini" | "sarvam"; selectable: boolean };
export type PreviewPanel = "sidebar" | "git" | "context";
export type GitGroup = "staged" | "changes" | "commits";

export type BranchSwitchError = {
  to: string;
  message: string;
  files: string[];
  canForce: boolean;
};

export function gitPathParts(filePath: string) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const separator = normalizedPath.lastIndexOf("/");
  return {
    fileName: separator >= 0 ? normalizedPath.slice(separator + 1) : normalizedPath,
    relativeDirectory: separator >= 0 ? normalizedPath.slice(0, separator) : "",
  };
}

export function validAppearance(value: unknown): Appearance {
  return value === "dark" || value === "system" ? value : "light";
}

export function validThreadSort(value: unknown): ThreadSort {
  return value === "created" ? value : "recent-message";
}

export function validMidRunEnterAction(value: unknown): MidRunEnterAction {
  return value === "steer" ? "steer" : "queue";
}

export function clampActivityWidth(value: number) {
  return Math.min(Math.max(value || DEFAULT_ACTIVITY_WIDTH, MIN_ACTIVITY_WIDTH), MAX_ACTIVITY_WIDTH);
}

export function clampDiffWidth(value: number) {
  return Math.min(Math.max(value || DEFAULT_DIFF_WIDTH, 420), MAX_DIFF_WIDTH);
}

export function selectableModel(model: string, options: string[]) {
  return options.includes(model) ? model : "";
}

export function eventTime(event: RuntimeEvent): number | null {
  if (!event.created_at) return null;
  const timestamp = event.created_at;
  const parsed = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) ? timestamp : `${timestamp.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function elapsedLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export type RunSocketMessage =
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
      payload: {
        iteration: number;
        completed_iterations: number;
        additional_iterations: number;
        reason?: "time_limit" | "repeated_failure";
        ceiling_seconds?: number;
        tool_name?: string;
        repeat_count?: number;
      };
    }
  | { kind: "run.finished" };

export type RuntimeEvent = {
  run_id?: string;
  type: string;
  payload: Record<string, unknown>;
  created_at?: string;
};

export type ThreadSummary = {
  id: string;
  title: string;
  workspace_path: string;
  model_name: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
};

export type ThreadTurn = {
  id: number;
  run_id: string | null;
  model_name: string | null;
  finalized_by_iteration_limit: boolean;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type QueuedTask = {
  id: string;
  content: string;
  createdAt: string;
};

export type ContextState = {
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

export type GitFileState = {
  path: string;
  status: string;
};

export type GitDiffState = {
  path: string;
  staged: boolean;
  patch: string | null;
  binary: boolean;
  error: string | null;
};

export type GitCommitState = {
  hash: string;
  short_hash: string;
  subject: string;
  author: string;
  authored_at: string;
};

export type GitStatusState = {
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

export type ThreadDetail = {
  thread: ThreadSummary;
  turns: ThreadTurn[];
  events: RuntimeEvent[];
  context: ContextState | null;
};

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The API returned an unexpected response.");
  }
  return (await response.json()) as T;
}


export function formatTimestamp(timestamp: string) {
  const isoTimestamp = timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoTimestamp));
}

export function eventRunId(event: RuntimeEvent) {
  const runId = event.run_id ?? event.payload.run_id;
  return typeof runId === "string" ? runId : null;
}

export function countIterations(events: RuntimeEvent[]) {
  return new Set(
    events
      .map((event) => event.payload.iteration)
      .filter((iteration): iteration is number => typeof iteration === "number"),
  ).size;
}

export function showInActivity(event: RuntimeEvent) {
  return !event.type.endsWith(".started")
    && event.type !== "model.delta"
    && event.type !== "turn.completed";
}

