from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import TypedDict


class GitFile(TypedDict):
    path: str
    status: str


class GitCommit(TypedDict):
    hash: str
    short_hash: str
    subject: str
    author: str
    authored_at: str


class GitDiff(TypedDict):
    path: str
    staged: bool
    patch: str
    binary: bool


class GitBranchSwitchError(ValueError):
    def __init__(self, message: str, files: list[str], *, can_force: bool) -> None:
        super().__init__(message)
        self.files = files
        self.can_force = can_force


class GitStatus(TypedDict):
    is_repository: bool
    root: str | None
    branch: str | None
    upstream: str | None
    ahead: int
    behind: int
    branches: list[str]
    staged: list[GitFile]
    modified: list[GitFile]
    untracked: list[GitFile]
    local_commits: list[GitCommit]
    local_commits_truncated: bool
    base_commit: GitCommit | None
    error: str | None
    fetch_error: str | None


def _empty_status(*, error: str | None = None) -> GitStatus:
    return {
        "is_repository": False,
        "root": None,
        "branch": None,
        "upstream": None,
        "ahead": 0,
        "behind": 0,
        "branches": [],
        "staged": [],
        "modified": [],
        "untracked": [],
        "local_commits": [],
        "local_commits_truncated": False,
        "base_commit": None,
        "error": error,
        "fetch_error": None,
    }


def _run_git(
    path: Path,
    *arguments: str,
    timeout: int = 10,
    no_prompt: bool = False,
) -> subprocess.CompletedProcess[str]:
    environment = None
    if no_prompt:
        environment = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never"}
    return subprocess.run(
        ["git", "-c", f"safe.directory={path}", *arguments],
        cwd=path,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
        env=environment,
    )


_COMMIT_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s"
_MAX_LOCAL_COMMITS = 100


def _parse_commits(output: str) -> list[GitCommit]:
    commits: list[GitCommit] = []
    for entry in output.split("\0"):
        if not entry:
            continue
        fields = entry.split("\x1f", 4)
        if len(fields) != 5:
            continue
        commit_hash, short_hash, author, authored_at, subject = fields
        commits.append(
            {
                "hash": commit_hash,
                "short_hash": short_hash,
                "subject": subject,
                "author": author,
                "authored_at": authored_at,
            }
        )
    return commits


def _read_commit(path: Path, revision: str) -> GitCommit | None:
    result = _run_git(path, "show", "-s", "-z", f"--format={_COMMIT_FORMAT}", revision)
    commits = _parse_commits(result.stdout) if result.returncode == 0 else []
    return commits[0] if commits else None


def _read_local_commits(
    path: Path,
    upstream: str | None,
    branch: str | None,
) -> tuple[list[GitCommit], bool, GitCommit | None]:
    if upstream:
        count_result = _run_git(path, "rev-list", "--count", f"{upstream}..HEAD")
        count = int(count_result.stdout.strip()) if count_result.returncode == 0 else 0
        log_result = _run_git(
            path,
            "log",
            "-z",
            f"--format={_COMMIT_FORMAT}",
            f"--max-count={_MAX_LOCAL_COMMITS}",
            f"{upstream}..HEAD",
        )
        base_result = _run_git(path, "merge-base", "HEAD", upstream)
        base_hash = base_result.stdout.strip() if base_result.returncode == 0 else ""
        return (
            _parse_commits(log_result.stdout) if log_result.returncode == 0 else [],
            count > _MAX_LOCAL_COMMITS,
            _read_commit(path, base_hash) if base_hash else None,
        )

    refs_result = _run_git(
        path,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
    )
    other_refs = [
        ref
        for ref in refs_result.stdout.splitlines()
        if ref and ref != branch and not ref.endswith("/HEAD")
    ] if refs_result.returncode == 0 else []
    revision_arguments = ["HEAD", "--not", *other_refs] if other_refs else ["HEAD"]
    rev_list_result = _run_git(path, "rev-list", "--boundary", *revision_arguments)
    revisions = rev_list_result.stdout.splitlines() if rev_list_result.returncode == 0 else []
    local_count = sum(1 for revision in revisions if revision and not revision.startswith("-"))
    boundary_hash = next((revision[1:] for revision in revisions if revision.startswith("-")), "")
    log_result = _run_git(
        path,
        "log",
        "-z",
        f"--format={_COMMIT_FORMAT}",
        f"--max-count={_MAX_LOCAL_COMMITS}",
        *revision_arguments,
    )
    return (
        _parse_commits(log_result.stdout) if log_result.returncode == 0 else [],
        local_count > _MAX_LOCAL_COMMITS,
        _read_commit(path, boundary_hash) if boundary_hash else None,
    )


def read_git_status(path: Path, *, fetch_remote: bool = False) -> GitStatus:
    try:
        repository = _run_git(path, "rev-parse", "--is-inside-work-tree")
    except FileNotFoundError:
        return _empty_status(error="Git is not installed or is not available on PATH.")
    except subprocess.TimeoutExpired:
        return _empty_status(error="Git did not respond in time.")

    if repository.returncode != 0 or repository.stdout.strip() != "true":
        return _empty_status()

    fetch_error: str | None = None
    if fetch_remote:
        try:
            fetch_result = _run_git(path, "fetch", timeout=30, no_prompt=True)
            if fetch_result.returncode != 0:
                detail = fetch_result.stderr.strip()
                fetch_error = next((line.strip() for line in detail.splitlines() if line.strip()), None)
                fetch_error = fetch_error or "Could not fetch from the remote."
        except subprocess.TimeoutExpired:
            fetch_error = "Remote refresh timed out."

    try:
        root_result = _run_git(path, "rev-parse", "--show-toplevel")
        branch_result = _run_git(path, "branch", "--show-current")
        upstream_result = _run_git(
            path,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        )
        divergence_result = _run_git(path, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
        branches_result = _run_git(
            path,
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=refname",
            "refs/heads",
        )
        status_result = _run_git(
            path,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        )
    except subprocess.TimeoutExpired:
        return _empty_status(error="Git did not respond in time.")

    if status_result.returncode != 0:
        message = status_result.stderr.strip() or "Could not read Git status."
        return _empty_status(error=message)

    staged: list[GitFile] = []
    modified: list[GitFile] = []
    untracked: list[GitFile] = []
    entries = status_result.stdout.split("\0")
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if not entry:
            continue
        code = entry[:2]
        file_path = entry[3:]
        if code[0] in {"R", "C"}:
            index += 1  # porcelain -z adds the original path after a rename/copy
        item = {"path": file_path, "status": code}
        if code == "??":
            untracked.append(item)
            continue
        if code[0] not in {" ", "?"}:
            staged.append(item)
        if code[1] not in {" ", "?"}:
            modified.append(item)

    ahead = 0
    behind = 0
    if divergence_result.returncode == 0:
        counts = divergence_result.stdout.split()
        if len(counts) == 2:
            try:
                ahead, behind = (int(count) for count in counts)
            except ValueError:
                pass
    branch = branch_result.stdout.strip() if branch_result.returncode == 0 else None
    upstream = upstream_result.stdout.strip() if upstream_result.returncode == 0 else None
    branches = branches_result.stdout.splitlines() if branches_result.returncode == 0 else []
    if branch and branch not in branches:
        branches.append(branch)
    try:
        local_commits, local_commits_truncated, base_commit = _read_local_commits(
            path,
            upstream,
            branch,
        )
    except subprocess.TimeoutExpired:
        local_commits, local_commits_truncated, base_commit = [], False, None

    return {
        "is_repository": True,
        "root": str(Path(root_result.stdout.strip())) if root_result.returncode == 0 else str(path),
        "branch": branch,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "branches": branches,
        "staged": staged,
        "modified": modified,
        "untracked": untracked,
        "local_commits": local_commits,
        "local_commits_truncated": local_commits_truncated,
        "base_commit": base_commit,
        "error": None,
        "fetch_error": fetch_error,
    }


def _switch_conflicting_files(detail: str) -> list[str]:
    files: list[str] = []
    reading_files = False
    for line in detail.splitlines():
        stripped = line.strip()
        if "following files would be overwritten" in stripped.lower():
            reading_files = True
            continue
        if not reading_files:
            continue
        if not stripped or stripped.lower().startswith(("please ", "aborting")):
            reading_files = False
            continue
        files.append(stripped)
    return list(dict.fromkeys(files))


def switch_git_branch(path: Path, branch: str, *, force: bool = False) -> GitStatus:
    status = read_git_status(path)
    if not status["is_repository"]:
        raise ValueError(status["error"] or "This path is not inside a Git repository.")

    branch = branch.strip()
    if not branch or branch not in status["branches"]:
        raise ValueError("That local branch does not exist.")
    if branch == status["branch"]:
        return status

    try:
        arguments = ("switch", "--discard-changes", branch) if force else ("switch", branch)
        result = _run_git(path, *arguments)
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Git did not respond in time.") from exc
    if result.returncode != 0:
        detail = result.stderr.strip()
        normalized_detail = detail.lower()
        files = _switch_conflicting_files(detail)
        overwritten = "would be overwritten" in normalized_detail
        if "local changes" in normalized_detail and "would be overwritten" in normalized_detail:
            message = "Local changes would be overwritten."
        elif "untracked working tree files" in normalized_detail and "would be overwritten" in normalized_detail:
            message = "Untracked files would be overwritten."
        elif "resolve your current index first" in normalized_detail:
            message = "Resolve the current merge conflicts before switching branches."
        else:
            first_line = next((line.strip() for line in detail.splitlines() if line.strip()), "")
            if first_line.lower().startswith("error:"):
                first_line = first_line[6:].strip()
            message = first_line or f"Git could not switch to {branch}."
        raise GitBranchSwitchError(message, files, can_force=not force and overwritten)
    return read_git_status(path)


def sync_git_branch(path: Path) -> GitStatus:
    status = read_git_status(path)
    if not status["is_repository"]:
        raise ValueError(status["error"] or "This path is not inside a Git repository.")
    if not status["upstream"]:
        raise ValueError("The current branch has no upstream branch to synchronize with.")

    try:
        pull = _run_git(path, "pull", "--no-rebase", "--no-edit", timeout=60, no_prompt=True)
        if pull.returncode != 0:
            detail = pull.stderr.strip() or pull.stdout.strip()
            raise ValueError(detail or "Could not pull remote commits.")
        push = _run_git(path, "push", timeout=60, no_prompt=True)
        if push.returncode != 0:
            detail = push.stderr.strip() or push.stdout.strip()
            raise ValueError(detail or "Could not push local commits.")
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Git synchronization timed out.") from exc
    return read_git_status(path)


def read_staged_diff(path: Path, *, max_characters: int = 16_000) -> str:
    status = read_git_status(path)
    if not status["is_repository"]:
        raise ValueError(status["error"] or "This path is not inside a Git repository.")
    if not status["staged"]:
        raise ValueError("There are no staged changes to describe.")
    try:
        summary = _run_git(path, "diff", "--cached", "--stat")
        diff = _run_git(path, "diff", "--cached", "--no-ext-diff", "--unified=2")
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Git did not respond in time.") from exc
    if diff.returncode != 0:
        raise ValueError(diff.stderr.strip() or "Could not read the staged diff.")
    content = "\n".join(part for part in (summary.stdout.strip(), diff.stdout.strip()) if part)
    if len(content) > max_characters:
        content = f"{content[:max_characters]}\n[staged diff truncated]"
    return content


def read_git_file_diff(path: Path, file_path: str, *, staged: bool) -> GitDiff:
    status = read_git_status(path)
    if not status["is_repository"]:
        raise ValueError(status["error"] or "This path is not inside a Git repository.")

    file_path = file_path.strip()
    available = (
        {item["path"] for item in status["staged"]}
        if staged
        else {
            item["path"]
            for item in (*status["modified"], *status["untracked"])
        }
    )
    if not file_path or file_path not in available:
        raise ValueError("That file is not in the selected Git change group.")

    root = Path(status["root"] or path)
    arguments = ["diff"]
    if staged:
        arguments.append("--cached")
    elif file_path in {item["path"] for item in status["untracked"]}:
        arguments.append("--no-index")
    arguments.extend(("--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--"))
    if not staged and file_path in {item["path"] for item in status["untracked"]}:
        arguments.extend(("/dev/null", file_path))
    else:
        arguments.append(file_path)

    try:
        result = _run_git(root, *arguments)
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Git did not respond in time.") from exc
    expected_return_codes = {0, 1} if "--no-index" in arguments else {0}
    if result.returncode not in expected_return_codes:
        raise ValueError(result.stderr.strip() or "Could not read the file diff.")
    patch = result.stdout
    binary = any(
        line == "GIT binary patch"
        or (line.startswith("Binary files ") and line.endswith(" differ"))
        for line in patch.splitlines()
    )
    return {
        "path": file_path,
        "staged": staged,
        "patch": patch,
        "binary": binary,
    }


def read_commit_message_diff(path: Path, *, max_characters: int = 16_000) -> str:
    status = read_git_status(path)
    if not status["is_repository"]:
        raise ValueError(status["error"] or "This path is not inside a Git repository.")
    if status["staged"]:
        return read_staged_diff(path, max_characters=max_characters)
    if not status["modified"] and not status["untracked"]:
        raise ValueError("There are no changes to describe.")

    try:
        summary = _run_git(path, "diff", "--stat")
        diff = _run_git(path, "diff", "--no-ext-diff", "--unified=2")
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Git did not respond in time.") from exc
    if diff.returncode != 0:
        raise ValueError(diff.stderr.strip() or "Could not read the working-tree diff.")

    parts = [part for part in (summary.stdout.strip(), diff.stdout.strip()) if part]
    if status["untracked"]:
        parts.append("Untracked files:")
        for item in status["untracked"]:
            relative_path = item["path"]
            parts.append(f"--- {relative_path}")
            candidate = path / relative_path
            resolved_candidate = candidate.resolve()
            resolved_path = path.resolve()
            inside_workspace = (
                resolved_candidate == resolved_path or resolved_path in resolved_candidate.parents
            )
            if inside_workspace and candidate.is_file() and not candidate.is_symlink():
                try:
                    with resolved_candidate.open("r", encoding="utf-8", errors="replace") as handle:
                        parts.append(handle.read(max_characters))
                except OSError:
                    pass
            if sum(len(part) for part in parts) >= max_characters:
                break
    content = "\n".join(parts)
    if len(content) > max_characters:
        content = f"{content[:max_characters]}\n[change details truncated]"
    return content


def commit_git_changes(path: Path, message: str) -> GitStatus:
    status = read_git_status(path)
    if not status["is_repository"]:
        raise ValueError(status["error"] or "This path is not inside a Git repository.")
    if not status["staged"]:
        raise ValueError("There are no staged changes to commit.")
    message = " ".join(message.split())
    if not message:
        raise ValueError("A commit message is required.")
    try:
        result = _run_git(path, "commit", "-m", message, timeout=60)
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Git commit timed out.") from exc
    if result.returncode != 0:
        raise ValueError(result.stderr.strip() or result.stdout.strip() or "Could not create the commit.")
    return read_git_status(path)


def update_git_index(path: Path, paths: list[str], *, stage: bool) -> GitStatus:
    status = read_git_status(path)
    if not status["is_repository"]:
        raise ValueError(status["error"] or "This path is not inside a Git repository.")

    clean_paths = [file_path for file_path in paths if file_path]
    if stage:
        arguments = ("add", "--", *clean_paths) if clean_paths else ("add", "--all")
    else:
        try:
            head = _run_git(path, "rev-parse", "--verify", "HEAD")
        except subprocess.TimeoutExpired as exc:
            raise ValueError("Git did not respond in time.") from exc
        if head.returncode == 0:
            arguments = ("reset", "--quiet", "--", *clean_paths) if clean_paths else ("reset", "--quiet")
        else:
            arguments = (
                ("rm", "--cached", "-r", "--ignore-unmatch", "--", *clean_paths)
                if clean_paths
                else ("rm", "--cached", "-r", "--ignore-unmatch", "--", ".")
            )

    try:
        result = _run_git(path, *arguments)
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Git did not respond in time.") from exc
    if result.returncode != 0:
        raise ValueError(result.stderr.strip() or "Could not update the Git index.")
    return read_git_status(path)


def discard_git_changes(path: Path, paths: list[str]) -> GitStatus:
    status = read_git_status(path)
    if not status["is_repository"]:
        raise ValueError(status["error"] or "This path is not inside a Git repository.")

    modified = {item["path"] for item in status["modified"]}
    untracked = {item["path"] for item in status["untracked"]}
    available = modified | untracked
    requested = {file_path for file_path in paths if file_path}
    if requested and not requested.issubset(available):
        raise ValueError("Only current working-tree changes can be discarded.")
    targets = requested or available

    tracked_targets = sorted(targets & modified)
    untracked_targets = sorted(targets & untracked)
    try:
        if tracked_targets:
            restore = _run_git(path, "restore", "--worktree", "--", *tracked_targets)
            if restore.returncode != 0:
                raise ValueError(restore.stderr.strip() or "Could not restore tracked files.")
        if untracked_targets:
            clean = _run_git(path, "clean", "-f", "--", *untracked_targets)
            if clean.returncode != 0:
                raise ValueError(clean.stderr.strip() or "Could not discard untracked files.")
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Git did not respond in time.") from exc
    return read_git_status(path)
