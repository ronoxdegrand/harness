import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  readJson, type BranchSwitchError, type GitCommitState, type GitDiffState,
  type GitFileState, type GitStatusState, type ModelOption,
} from "@/appShared";

type GitOptions = {
  workspacePath: string;
  narrowView: boolean;
  gitDiffShowUnchanged: boolean;
  runInProgress: boolean;
  modelName: string;
  modelInfo: Map<string, ModelOption>;
  apiKey: string;
  sarvamApiKey: string;
  setError: Dispatch<SetStateAction<string>>;
  setGitOpen: Dispatch<SetStateAction<boolean>>;
  setGitPreviewOpen: Dispatch<SetStateAction<boolean>>;
  setSidebarPreviewOpen: Dispatch<SetStateAction<boolean>>;
  setContextPreviewOpen: Dispatch<SetStateAction<boolean>>;
  setBranchPickerOpen: Dispatch<SetStateAction<boolean>>;
};

export function useGitController({
  workspacePath, narrowView, gitDiffShowUnchanged, runInProgress, modelName,
  modelInfo, apiKey, sarvamApiKey, setError, setGitOpen, setGitPreviewOpen,
  setSidebarPreviewOpen, setContextPreviewOpen, setBranchPickerOpen,
}: GitOptions) {
  const [gitStatus, setGitStatus] = useState<GitStatusState | null>(null);

  const [gitStatusLoading, setGitStatusLoading] = useState(false);

  const [gitFetchError, setGitFetchError] = useState<string | null>(null);

  const [gitMutation, setGitMutation] = useState<string | null>(null);

  const [gitDiff, setGitDiff] = useState<GitDiffState | null>(null);

  const [commitMessage, setCommitMessage] = useState("");

  const [commitMessageGenerating, setCommitMessageGenerating] = useState(false);

  const [undoCommitWarning, setUndoCommitWarning] = useState<GitCommitState | null>(null);

  const [branchSwitchError, setBranchSwitchError] = useState<BranchSwitchError | null>(null);

  const commitGenerationRef = useRef<AbortController | null>(null);

  const gitStatusRequestRef = useRef<AbortController | null>(null);

  const gitDiffRequestRef = useRef<AbortController | null>(null);

  const gitDiffSelectionRef = useRef<Pick<GitDiffState, "path" | "staged"> | null>(null);

  const showUnchangedRef = useRef(gitDiffShowUnchanged);
  showUnchangedRef.current = gitDiffShowUnchanged;

  async function refreshSelectedDiff(nextStatus: GitStatusState, changedPaths: string[], autoOpen = false) {
    if (!nextStatus.is_repository) {
      if (gitDiffSelectionRef.current) closeGitDiff();
      return;
    }
    const selected = gitDiffSelectionRef.current;
    const changes = [...nextStatus.modified, ...nextStatus.untracked];
    const allFiles = [
      ...changes.map((file) => ({ file, staged: false })),
      ...nextStatus.staged.map((file) => ({ file, staged: true })),
    ];
    if (!selected) {
      if (autoOpen) {
        const firstChanged = allFiles.find(({ file }) => changedPaths.includes(file.path));
        if (firstChanged) void openGitDiff(firstChanged.file, firstChanged.staged);
      }
      return;
    }
    if (changedPaths.length && !changedPaths.includes(selected.path)) return;
    const current = allFiles.find(({ file, staged }) => file.path === selected.path && staged === selected.staged)
      ?? allFiles.find(({ file }) => file.path === selected.path);
    if (!current) {
      closeGitDiff();
      return;
    }
    gitDiffRequestRef.current?.abort();
    const controller = new AbortController();
    gitDiffRequestRef.current = controller;
    try {
      const response = await fetch("/git/diff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_path: workspacePath,
          path: current.file.path,
          staged: current.staged,
          full_context: showUnchangedRef.current,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Could not refresh the file diff.");
      const payload = await readJson<{ path: string; staged: boolean; patch: string; binary: boolean }>(response);
      if (gitDiffSelectionRef.current?.path !== selected.path
        || gitDiffSelectionRef.current.staged !== selected.staged
        || controller.signal.aborted) return;
      gitDiffSelectionRef.current = { path: payload.path, staged: payload.staged };
      setGitDiff((previous) => previous?.path === selected.path
        ? previous.patch === payload.patch && previous.staged === payload.staged && previous.binary === payload.binary && !previous.error
          ? previous
          : { ...payload, error: null }
        : previous);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setGitDiff((previous) => previous?.path === selected.path
        ? { ...previous, error: reason instanceof Error ? reason.message : "Could not refresh the file diff." }
        : previous);
    } finally {
      if (gitDiffRequestRef.current === controller) gitDiffRequestRef.current = null;
    }
  }

  async function loadGitStatus(silent = false, fetchRemote = false, changedPaths?: string[], autoOpen = false): Promise<GitStatusState | null> {
    gitStatusRequestRef.current?.abort();
    if (!workspacePath.trim()) {
      setGitStatus(null);
      setGitFetchError(null);
      setGitStatusLoading(false);
      return null;
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
      if (changedPaths) void refreshSelectedDiff(nextStatus, changedPaths, autoOpen);
      if (fetchRemote) setGitFetchError(nextStatus.fetch_error);
      return nextStatus;
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return null;
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
      return null;
    } finally {
      if (gitStatusRequestRef.current === controller) {
        gitStatusRequestRef.current = null;
        if (!silent) setGitStatusLoading(false);
      }
    }
  }

  async function openGitDiff(
    file: GitFileState,
    staged: boolean,
    showUnchanged = gitDiffShowUnchanged,
  ) {
    if (!workspacePath.trim()) return;
    gitDiffRequestRef.current?.abort();
    const controller = new AbortController();
    gitDiffRequestRef.current = controller;
    gitDiffSelectionRef.current = { path: file.path, staged };
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
        body: JSON.stringify({
          workspace_path: workspacePath,
          path: file.path,
          staged,
          full_context: showUnchanged,
        }),
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
    gitDiffSelectionRef.current = null;
    setGitDiff(null);
    setSidebarPreviewOpen(false);
    setContextPreviewOpen(false);
  }

  async function updateGitIndex(action: "stage" | "unstage", paths: string[]) {
    if (!workspacePath.trim() || gitMutation) return;
    gitStatusRequestRef.current?.abort();
    const viewedDiff = gitDiffSelectionRef.current;
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
      const nextStatus = await readJson<GitStatusState>(response);
      setGitStatus(nextStatus);
      if (viewedDiff && (!paths.length || paths.includes(viewedDiff.path))
        && gitDiffSelectionRef.current?.path === viewedDiff.path
        && gitDiffSelectionRef.current.staged === viewedDiff.staged) {
        const staged = action === "stage";
        const nextFiles = staged
          ? nextStatus.staged
          : [...nextStatus.modified, ...nextStatus.untracked];
        const nextFile = nextFiles.find((file) => file.path === viewedDiff.path);
        if (nextFile) void openGitDiff(nextFile, staged);
        else closeGitDiff();
      }
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

  async function undoLastCommit(commit: GitCommitState, allowStaged = false) {
    if (!workspacePath.trim() || gitMutation || runInProgress) return;
    if (gitStatus?.staged.length && !allowStaged) {
      setUndoCommitWarning(commit);
      return;
    }
    gitStatusRequestRef.current?.abort();
    setGitMutation("undo-commit");
    try {
      const response = await fetch("/git/undo-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_path: workspacePath, expected_head: commit.hash, allow_staged: allowStaged }),
      });
      if (response.status === 409) {
        setUndoCommitWarning(commit);
        return;
      }
      if (!response.ok) {
        const payload = await readJson<{ detail?: string }>(response);
        throw new Error(payload.detail || "Could not undo the commit.");
      }
      setGitStatus(await readJson<GitStatusState>(response));
      setCommitMessage(commit.subject);
      setUndoCommitWarning(null);
      closeGitDiff();
    } catch (reason) {
      setUndoCommitWarning(null);
      setError(reason instanceof Error ? reason.message : "Could not undo the commit.");
    } finally {
      setGitMutation(null);
    }
  }

  async function generateCommitMessage() {
    const hasChanges = Boolean(
      gitStatus?.staged.length || gitStatus?.modified.length || gitStatus?.untracked.length,
    );
    if (!workspacePath.trim() || !modelName || !hasChanges || commitGenerationRef.current || gitMutation) return;
    const controller = new AbortController();
    commitGenerationRef.current = controller;
    setCommitMessageGenerating(true);
    try {
      const response = await fetch("/git/commit-message", {
        signal: controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_path: workspacePath,
          model_name: modelName,
          ...(modelInfo.get(modelName)?.provider === "sarvam"
            ? sarvamApiKey.trim() ? { sarvam_api_key: sarvamApiKey.trim() } : {}
            : apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const payload = await readJson<{ detail?: string }>(response);
        throw new Error(payload.detail || "Could not generate a commit message.");
      }
      const payload = await readJson<{ message: string }>(response);
      if (!controller.signal.aborted) setCommitMessage(payload.message);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not generate a commit message.");
    } finally {
      if (commitGenerationRef.current === controller) {
        commitGenerationRef.current = null;
        setCommitMessageGenerating(false);
      }
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

  return {
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
  };
}
