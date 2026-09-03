from __future__ import annotations

import subprocess
from pathlib import Path
from typing import TypedDict


class GitFile(TypedDict):
    path: str
    status: str


class GitStatus(TypedDict):
    is_repository: bool
    root: str | None
    branch: str | None
    staged: list[GitFile]
    modified: list[GitFile]
    untracked: list[GitFile]
    error: str | None


def _empty_status(*, error: str | None = None) -> GitStatus:
    return {
        "is_repository": False,
        "root": None,
        "branch": None,
        "staged": [],
        "modified": [],
        "untracked": [],
        "error": error,
    }


def _run_git(path: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-c", f"safe.directory={path}", *arguments],
        cwd=path,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
        check=False,
    )


def read_git_status(path: Path) -> GitStatus:
    try:
        repository = _run_git(path, "rev-parse", "--is-inside-work-tree")
    except FileNotFoundError:
        return _empty_status(error="Git is not installed or is not available on PATH.")
    except subprocess.TimeoutExpired:
        return _empty_status(error="Git did not respond in time.")

    if repository.returncode != 0 or repository.stdout.strip() != "true":
        return _empty_status()

    try:
        root_result = _run_git(path, "rev-parse", "--show-toplevel")
        branch_result = _run_git(path, "branch", "--show-current")
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

    return {
        "is_repository": True,
        "root": str(Path(root_result.stdout.strip())) if root_result.returncode == 0 else str(path),
        "branch": branch_result.stdout.strip() if branch_result.returncode == 0 else None,
        "staged": staged,
        "modified": modified,
        "untracked": untracked,
        "error": None,
    }


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
