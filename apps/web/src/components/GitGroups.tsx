import type { Dispatch, SetStateAction } from "react";
import { Check, ChevronDown, LoaderCircle, Minus, Plus, Undo2 } from "lucide-react";
import { Button } from "@/components/ui";
import { CopyButton } from "@/components/AppPrimitives";
import { gitPathParts, formatTimestamp, type GitCommitState, type GitDiffState, type GitFileState, type GitGroup, type GitStatusState } from "@/appShared";

type GitFileGroupProps = {
  group: GitGroup;
  title: string;
  files: GitFileState[];
  action: "stage" | "unstage";
  collapsedGitGroups: Record<GitGroup, boolean>;
  setCollapsedGitGroups: Dispatch<SetStateAction<Record<GitGroup, boolean>>>;
  gitMutation: string | null;
  gitDiff: GitDiffState | null;
  updateGitIndex: (action: "stage" | "unstage", paths: string[]) => Promise<void>;
  discardGitChanges: (paths: string[]) => Promise<void>;
  openGitDiff: (file: GitFileState, staged: boolean) => Promise<void>;
  closeGitDiff: () => void;
};

function gitStatusClass(status: string) {
  if (status.includes("D")) return "text-destructive";
  if (status === "??" || status.includes("A")) return "text-success";
  if (status.includes("M")) return "text-warning";
  return "text-muted-foreground";
}

export function GitFileGroup({
  group, title, files, action, collapsedGitGroups, setCollapsedGitGroups, gitMutation,
  gitDiff, updateGitIndex, discardGitChanges, openGitDiff, closeGitDiff,
}: GitFileGroupProps) {
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
            data-tooltip={`${actionLabel} all`}
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
              data-tooltip="Discard all"
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
              <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" data-tooltip={file.path}>
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
                data-tooltip={actionLabel}
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
                  data-tooltip="Discard changes"
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


type GitCommitsProps = {
  gitStatus: GitStatusState | null;
  collapsedGitGroups: Record<GitGroup, boolean>;
  setCollapsedGitGroups: Dispatch<SetStateAction<Record<GitGroup, boolean>>>;
  gitMutation: string | null;
  runInProgress: boolean;
  undoLastCommit: (commit: GitCommitState) => Promise<void>;
};

export function GitCommits({
  gitStatus, collapsedGitGroups, setCollapsedGitGroups, gitMutation, runInProgress, undoLastCommit,
}: GitCommitsProps) {
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
        <Button
          aria-label="Undo last unsynced commit"
          className="ml-auto size-6"
          disabled={Boolean(gitMutation) || runInProgress}
          size="icon-sm"
          data-tooltip="Undo last unsynced commit and keep its changes staged"
          type="button"
          variant="ghost"
          onClick={() => void undoLastCommit(commits[0])}
        >
          {gitMutation === "undo-commit" ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : <Undo2 aria-hidden="true" className="size-3.5" />}
        </Button>
      </div>
      {!collapsed ? (
        <div className="overflow-hidden rounded-lg border bg-card">
          {commits.map((commit) => (
            <div className="group/commit relative min-w-0" key={commit.hash}>
              <div className="min-w-0 px-2.5 py-1.5 transition-[padding] group-hover/commit:pr-[5.25rem] group-focus-within/commit:pr-[5.25rem]" data-tooltip={commit.subject}>
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
              <div className="flex min-w-0 items-start gap-2 px-2.5 py-1.5 pr-2.5 transition-[padding] group-hover/commit:pr-[5.25rem] group-focus-within/commit:pr-[5.25rem]" data-tooltip={gitStatus.base_commit.subject}>
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
