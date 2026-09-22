from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .git_status import (
    GitBranchSwitchError,
    commit_git_changes,
    discard_git_changes,
    read_git_status,
    sync_git_branch,
    switch_git_branch,
    update_git_index,
)
from .web_fetch import fetch_public_page

ToolHandler = Callable[[dict[str, Any], Path], "ToolResult"]

_SCHEMA_TYPE_MAP: dict[str, type[Any]] = {
    "array": list,
    "boolean": bool,
    "integer": int,
    "string": str,
}
_MAX_DISCOVERY_FILES = 5_000
_OUTPUT_CHARS = 16_000
_READ_LINES = 200


def _workspace_files(
    search_root: Path, *, include_hidden: bool = False, include_ignored: bool = False,
) -> tuple[list[Path], bool]:
    """Discover files using Git's ignore rules, with a bounded fallback outside Git."""
    if not include_ignored:
        try:
            completed = subprocess.run(
                ["git", "-C", str(search_root), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                capture_output=True,
                check=False,
                timeout=10,
            )
            if completed.returncode == 0:
                names = completed.stdout.split(b"\0")
                paths = []
                for raw_name in names:
                    if not raw_name:
                        continue
                    relative = Path(os.fsdecode(raw_name))
                    if not include_hidden and any(part.startswith(".") for part in relative.parts):
                        continue
                    path = search_root / relative
                    if path.is_file() and not path.is_symlink():
                        paths.append(path)
                    if len(paths) > _MAX_DISCOVERY_FILES:
                        return sorted(paths[:_MAX_DISCOVERY_FILES]), True
                return sorted(paths), False
        except (OSError, subprocess.TimeoutExpired):
            pass

    paths = []
    for directory, directories, files in os.walk(search_root):
        directories[:] = sorted(
            name for name in directories
            if name != ".git" and (include_hidden or not name.startswith("."))
            and not (Path(directory) / name).is_symlink()
        )
        for name in sorted(files):
            path = Path(directory) / name
            if (include_hidden or not name.startswith(".")) and not path.is_symlink():
                paths.append(path)
                if len(paths) > _MAX_DISCOVERY_FILES:
                    return paths[:_MAX_DISCOVERY_FILES], True
    return paths, False


def _object_schema(
    properties: dict[str, Any],
    *,
    required: list[str] | None = None,
) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "arguments": self.arguments}


@dataclass
class ToolResult:
    success: bool
    output: str
    metadata: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "output": self.output,
            "metadata": self.metadata,
            "error": self.error,
        }

    def to_message_content(self) -> str:
        return json.dumps(self.as_dict())


@dataclass
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: ToolHandler
    replay_policy: str = "never"

    def execute(self, arguments: dict[str, Any], workspace_root: Path) -> ToolResult:
        _validate_arguments(self.input_schema, arguments)
        return self.handler(arguments, workspace_root)

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


class ToolRegistry:
    def __init__(self, tools: list[ToolDefinition] | None = None) -> None:
        self._tools: dict[str, ToolDefinition] = {}
        for tool in tools or []:
            self.register(tool)

    def register(self, tool: ToolDefinition) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> ToolDefinition:
        if name not in self._tools:
            raise KeyError(f"Unknown tool: {name}")
        return self._tools[name]

    def list(self) -> list[str]:
        return sorted(self._tools)

    def definitions(self) -> list[dict[str, Any]]:
        return [self._tools[name].as_dict() for name in self.list()]


class ToolExecutor:
    def __init__(self, registry: ToolRegistry) -> None:
        self.registry = registry

    def execute(self, call: ToolCall, *, target_path: Path) -> ToolResult:
        workspace_root = target_path.resolve()
        try:
            tool = self.registry.get(call.name)
            result = tool.execute(call.arguments, workspace_root)
            result.metadata.setdefault("tool_name", call.name)
            result.metadata.setdefault("workspace_root", str(workspace_root))
            return result
        except Exception as exc:
            return ToolResult(
                success=False,
                output="",
                error=str(exc),
                metadata={
                    "tool_name": call.name,
                    "workspace_root": str(workspace_root),
                },
            )


def build_default_tool_registry() -> ToolRegistry:
    return ToolRegistry(
        tools=[
            ToolDefinition(
                name="read_file",
                description=(
                    "Read a UTF-8 file in bounded slices. The result includes next_offset when more "
                    "content remains; pass it as offset to continue reading."
                ),
                input_schema=_object_schema(
                    {"path": {"type": "string"}, "offset": {"type": "integer"}},
                    required=["path"],
                ),
                handler=_read_file,
                replay_policy="safe",
            ),
            ToolDefinition(
                name="write_file",
                description="Write UTF-8 text content relative to the workspace root.",
                input_schema=_object_schema(
                    {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    required=["path", "content"],
                ),
                handler=_write_file,
                replay_policy="idempotent",
            ),
            ToolDefinition(
                name="patch",
                description=(
                    "Replace exactly one occurrence of old_string with new_string in an existing "
                    "UTF-8 file. Use a distinctive old_string; the file is unchanged if it is "
                    "missing or ambiguous."
                ),
                input_schema=_object_schema(
                    {
                        "path": {"type": "string"},
                        "old_string": {"type": "string"},
                        "new_string": {"type": "string"},
                    },
                    required=["path", "old_string", "new_string"],
                ),
                handler=_patch_file,
                replay_policy="never",
            ),
            ToolDefinition(
                name="list_files",
                description=(
                    "List workspace files. Git-ignored files are excluded by default in Git repositories. "
                    "Use path to narrow a large listing, include_hidden for dotfiles, or include_ignored "
                    "when ignored files are needed."
                ),
                input_schema=_object_schema(
                    {
                        "path": {"type": "string"},
                        "limit": {"type": "integer"},
                        "include_hidden": {"type": "boolean"},
                        "include_ignored": {"type": "boolean"},
                    },
                ),
                handler=_list_files,
                replay_policy="safe",
            ),
            ToolDefinition(
                name="search_files",
                description=(
                    "Search workspace files by text or regex pattern. Git-ignored files are excluded "
                    "by default in Git repositories. Use path or include_ignored when needed. "
                    "This does not search the internet."
                ),
                input_schema=_object_schema(
                    {
                        "query": {"type": "string"},
                        "path": {"type": "string"},
                        "limit": {"type": "integer"},
                        "regex": {"type": "boolean"},
                        "include_hidden": {"type": "boolean"},
                        "include_ignored": {"type": "boolean"},
                    },
                    required=["query"],
                ),
                handler=_search_files,
                replay_policy="safe",
            ),
            ToolDefinition(
                name="fetch_url",
                description=(
                    "Read a public HTTPS text page at a known URL. The result includes page links and "
                    "the final URL for citation. Use query to locate a term in long pages. "
                    "This tool reads pages but does not search the web for URLs."
                ),
                input_schema=_object_schema(
                    {"url": {"type": "string"}, "query": {"type": "string"}},
                    required=["url"],
                ),
                handler=_fetch_url,
                replay_policy="safe",
            ),
            ToolDefinition(
                name="shell",
                description=(
                    "Run a command inside the workspace root or a subdirectory. Output is bounded; "
                    "if truncated, narrow the command rather than rerunning it for a later output slice."
                ),
                input_schema=_object_schema(
                    {
                        "command": {"type": "string"},
                        "working_directory": {"type": "string"},
                        "timeout_seconds": {"type": "integer"},
                    },
                    required=["command"],
                ),
                handler=_shell,
            ),
            ToolDefinition(
                name="git_status",
                description="Return git status output for the workspace.",
                input_schema=_object_schema(
                    {
                        "path": {"type": "string"},
                        "timeout_seconds": {"type": "integer"},
                    },
                ),
                handler=_git_status,
                replay_policy="safe",
            ),
            ToolDefinition(
                name="git_diff",
                description=(
                    "Return unstaged or staged git diff output. An omitted path means the workspace root. "
                    "Use next_offset from a truncated result to read the next slice."
                ),
                input_schema=_object_schema(
                    {
                        "path": {"type": "string"},
                        "staged": {"type": "boolean"},
                        "timeout_seconds": {"type": "integer"},
                        "offset": {"type": "integer"},
                    },
                ),
                handler=_git_diff,
                replay_policy="safe",
            ),
            ToolDefinition(
                name="git_log",
                description=(
                    "Return recent commit history for the current repository, including hashes, authors, "
                    "dates, subjects, and commit bodies. Optionally limit history to a repository-relative path."
                ),
                input_schema=_object_schema(
                    {
                        "limit": {"type": "integer"},
                        "path": {"type": "string"},
                        "timeout_seconds": {"type": "integer"},
                    },
                ),
                handler=_git_log,
                replay_policy="safe",
            ),
            ToolDefinition(
                name="git_refresh",
                description=(
                    "Fetch the configured Git remote, then return branch, push/pull, and file status. "
                    "Local status is still returned if the remote fetch fails."
                ),
                input_schema=_object_schema({"path": {"type": "string"}}),
                handler=_git_refresh,
            ),
            ToolDefinition(
                name="git_switch",
                description=(
                    "Switch to an existing local Git branch. Set force only when the user explicitly "
                    "accepts discarding conflicting tracked changes and blocking untracked files."
                ),
                input_schema=_object_schema(
                    {
                        "branch": {"type": "string"},
                        "force": {"type": "boolean"},
                        "path": {"type": "string"},
                    },
                    required=["branch"],
                ),
                handler=_git_switch,
            ),
            ToolDefinition(
                name="git_sync",
                description=(
                    "Synchronize the current branch with its upstream by pulling remote commits, "
                    "then pushing local commits. Stops without pushing if the pull fails."
                ),
                input_schema=_object_schema({"path": {"type": "string"}}),
                handler=_git_sync,
            ),
            ToolDefinition(
                name="git_commit",
                description="Commit all staged changes with a one-line commit message.",
                input_schema=_object_schema(
                    {"message": {"type": "string"}, "path": {"type": "string"}},
                    required=["message"],
                ),
                handler=_git_commit,
            ),
            ToolDefinition(
                name="git_stage",
                description="Stage selected paths, or all changes when paths is omitted.",
                input_schema=_object_schema(
                    {
                        "paths": {"type": "array", "items": {"type": "string"}},
                        "path": {"type": "string"},
                    },
                ),
                handler=_git_stage,
            ),
            ToolDefinition(
                name="git_unstage",
                description="Unstage selected paths, or all staged changes when paths is omitted.",
                input_schema=_object_schema(
                    {
                        "paths": {"type": "array", "items": {"type": "string"}},
                        "path": {"type": "string"},
                    },
                ),
                handler=_git_unstage,
            ),
            ToolDefinition(
                name="git_discard",
                description=(
                    "Discard working-tree changes for selected paths, or all changes when paths is omitted. "
                    "This restores tracked files and permanently removes matching untracked files."
                ),
                input_schema=_object_schema(
                    {
                        "paths": {"type": "array", "items": {"type": "string"}},
                        "path": {"type": "string"},
                    },
                ),
                handler=_git_discard,
            ),
        ]
    )


def _validate_arguments(schema: dict[str, Any], arguments: dict[str, Any]) -> None:
    if schema.get("type") != "object":
        raise ValueError("Tool schemas must be object schemas.")

    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    additional_properties = schema.get("additionalProperties", True)

    missing = sorted(field for field in required if field not in arguments)
    if missing:
        raise ValueError(f"Missing required arguments: {', '.join(missing)}")

    if additional_properties is False:
        unknown = sorted(key for key in arguments if key not in properties)
        if unknown:
            raise ValueError(f"Unknown arguments: {', '.join(unknown)}")

    for key, value in arguments.items():
        expected_type = properties.get(key, {}).get("type")
        if expected_type is None:
            continue
        python_type = _SCHEMA_TYPE_MAP.get(expected_type)
        if python_type is None:
            continue
        if not isinstance(value, python_type):
            raise ValueError(
                f"Argument '{key}' must be of type {expected_type}, got {type(value).__name__}."
            )
        item_type = properties.get(key, {}).get("items", {}).get("type")
        item_python_type = _SCHEMA_TYPE_MAP.get(item_type)
        if expected_type == "array" and item_python_type is not None:
            if any(not isinstance(item, item_python_type) for item in value):
                raise ValueError(f"Every item in argument '{key}' must be of type {item_type}.")


def _resolve_path(root: Path, relative_path: str = ".") -> Path:
    resolved = (root / relative_path).resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError("Path escapes the workspace root.")
    return resolved


def _slice_output(content: str, offset: int, *, max_lines: int | None = None) -> tuple[str, dict[str, Any]]:
    if offset < 0 or offset > len(content):
        raise ValueError("Output offset is outside the available content.")
    portion = content[offset : offset + _OUTPUT_CHARS]
    if max_lines is not None:
        portion = "".join(portion.splitlines(keepends=True)[:max_lines])
    end = offset + len(portion)
    return portion, {
        "offset": offset,
        "total_chars": len(content),
        "truncated": end < len(content),
        "next_offset": end if end < len(content) else None,
    }


def _read_file(arguments: dict[str, Any], root: Path) -> ToolResult:
    path = _resolve_path(root, arguments["path"])
    content = path.read_text(encoding="utf-8")
    offset = int(arguments.get("offset", 0))
    output, metadata = _slice_output(content, offset, max_lines=_READ_LINES)
    start_line = content.count("\n", 0, offset) + 1
    return ToolResult(
        success=True,
        output=output,
        metadata={
            "path": str(path.relative_to(root).as_posix()),
            "start_line": start_line,
            "end_line": start_line + output.count("\n") - int(output.endswith("\n")),
            **metadata,
        },
    )


def _write_file(arguments: dict[str, Any], root: Path) -> ToolResult:
    path = _resolve_path(root, arguments["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(arguments["content"], encoding="utf-8")
    return ToolResult(
        success=True,
        output="",
        metadata={
            "path": str(path.relative_to(root).as_posix()),
            "bytes_written": path.stat().st_size,
        },
    )


def _patch_file(arguments: dict[str, Any], root: Path) -> ToolResult:
    path = _resolve_path(root, arguments["path"])
    old_string = arguments["old_string"]
    if not old_string:
        raise ValueError("old_string must not be empty.")
    content = path.read_text(encoding="utf-8")
    matches = content.count(old_string)
    if matches != 1:
        raise ValueError(f"Patch needs exactly one match; found {matches}.")
    updated = content.replace(old_string, arguments["new_string"], 1)
    path.write_text(updated, encoding="utf-8")
    return ToolResult(
        success=True,
        output="",
        metadata={"path": str(path.relative_to(root).as_posix())},
    )


def _list_files(arguments: dict[str, Any], root: Path) -> ToolResult:
    relative_root = arguments.get("path", ".")
    search_root = _resolve_path(root, relative_root)
    include_hidden = bool(arguments.get("include_hidden", False))
    paths, truncated = _workspace_files(
        search_root,
        include_hidden=include_hidden,
        include_ignored=bool(arguments.get("include_ignored", False)),
    )
    entries = sorted(path.relative_to(root).as_posix() for path in paths)
    limit = int(arguments.get("limit", 200))
    return ToolResult(
        success=True,
        output="\n".join(entries[:limit]),
        metadata={
            "count": len(entries),
            "returned": min(limit, len(entries)),
            "path": str(search_root.relative_to(root).as_posix()) if search_root != root else ".",
            "include_hidden": include_hidden,
            "truncated": truncated or len(entries) > limit,
        },
    )


def _search_files(arguments: dict[str, Any], root: Path) -> ToolResult:
    query = arguments["query"]
    search_root = _resolve_path(root, arguments.get("path", "."))
    limit = int(arguments.get("limit", 50))
    use_regex = bool(arguments.get("regex", False))
    compiled = re.compile(query) if use_regex else None
    matches: list[str] = []
    paths, discovery_truncated = _workspace_files(
        search_root,
        include_hidden=bool(arguments.get("include_hidden", False)),
        include_ignored=bool(arguments.get("include_ignored", False)),
    )
    for path in paths:
        try:
            if path.stat().st_size > 1_000_000:
                continue
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for index, line in enumerate(content.splitlines(), start=1):
            found = compiled.search(line) is not None if compiled else query in line
            if found:
                matches.append(f"{path.relative_to(root).as_posix()}:{index}:{line.strip()}")
                if len(matches) >= limit:
                    return ToolResult(
                        success=True,
                        output="\n".join(matches),
                        metadata={"count": len(matches), "truncated": True, "regex": use_regex},
                    )

    return ToolResult(
        success=True,
        output="\n".join(matches),
        metadata={"count": len(matches), "truncated": discovery_truncated, "regex": use_regex},
    )


def _fetch_url(arguments: dict[str, Any], root: Path) -> ToolResult:
    url, content, truncated = fetch_public_page(arguments["url"], arguments.get("query"))
    return ToolResult(
        success=True,
        output=content,
        metadata={"url": url, "truncated": truncated},
    )


def _output_from_completed(completed: subprocess.CompletedProcess[str]) -> str:
    return "\n".join(part for part in (completed.stdout, completed.stderr) if part).strip()


def _run_command(
    command: str | list[str],
    *,
    cwd: Path,
    timeout_seconds: int,
    shell: bool = False,
) -> subprocess.CompletedProcess[str]:
    timeout_seconds = max(1, min(timeout_seconds, 120))
    return subprocess.run(
        command,
        cwd=cwd,
        shell=shell,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def _shell(arguments: dict[str, Any], root: Path) -> ToolResult:
    command = arguments["command"]
    timeout_seconds = int(arguments.get("timeout_seconds", 30))
    working_directory = _resolve_path(root, arguments.get("working_directory", "."))
    completed = _run_command(
        command,
        cwd=working_directory,
        shell=True,
        timeout_seconds=timeout_seconds,
    )
    output, output_metadata = _slice_output(_output_from_completed(completed), 0)
    output_metadata.pop("next_offset")

    return ToolResult(
        success=completed.returncode == 0,
        output=output,
        metadata={
            "returncode": completed.returncode,
            **output_metadata,
            "working_directory": (
                working_directory.relative_to(root).as_posix()
                if working_directory != root
                else "."
            ),
        },
        error=None
        if completed.returncode == 0
        else f"Command exited with {completed.returncode}",
    )


def _git_target(arguments: dict[str, Any], root: Path) -> Path:
    target = arguments.get("path", ".")
    if not target.strip():
        target = "."
    return _resolve_path(root, target)


def _git_state_result(status: dict[str, Any]) -> ToolResult:
    return ToolResult(
        success=status.get("error") is None,
        output=json.dumps(status, indent=2),
        metadata={
            "is_repository": status.get("is_repository", False),
            "branch": status.get("branch"),
            "fetch_error": status.get("fetch_error"),
        },
        error=status.get("error"),
    )


def _git_refresh(arguments: dict[str, Any], root: Path) -> ToolResult:
    return _git_state_result(read_git_status(_git_target(arguments, root), fetch_remote=True))


def _git_switch(arguments: dict[str, Any], root: Path) -> ToolResult:
    try:
        status = switch_git_branch(
            _git_target(arguments, root),
            arguments["branch"],
            force=bool(arguments.get("force", False)),
        )
    except GitBranchSwitchError as exc:
        return ToolResult(
            success=False,
            output=json.dumps(
                {"message": str(exc), "files": exc.files, "can_force": exc.can_force},
                indent=2,
            ),
            metadata={"files": exc.files, "can_force": exc.can_force},
            error=str(exc),
        )
    return _git_state_result(status)


def _git_sync(arguments: dict[str, Any], root: Path) -> ToolResult:
    return _git_state_result(sync_git_branch(_git_target(arguments, root)))


def _git_commit(arguments: dict[str, Any], root: Path) -> ToolResult:
    return _git_state_result(
        commit_git_changes(_git_target(arguments, root), arguments["message"])
    )


def _git_paths(arguments: dict[str, Any]) -> list[str]:
    return list(arguments.get("paths", []))


def _git_stage(arguments: dict[str, Any], root: Path) -> ToolResult:
    return _git_state_result(
        update_git_index(_git_target(arguments, root), _git_paths(arguments), stage=True)
    )


def _git_unstage(arguments: dict[str, Any], root: Path) -> ToolResult:
    return _git_state_result(
        update_git_index(_git_target(arguments, root), _git_paths(arguments), stage=False)
    )


def _git_discard(arguments: dict[str, Any], root: Path) -> ToolResult:
    return _git_state_result(
        discard_git_changes(_git_target(arguments, root), _git_paths(arguments))
    )


def _git_status(arguments: dict[str, Any], root: Path) -> ToolResult:
    target = arguments.get("path", ".")
    if not target.strip():
        target = "."
    working_directory = _resolve_path(root, target)
    completed = _run_command(
        ["git", "status", "--short"],
        cwd=working_directory,
        timeout_seconds=int(arguments.get("timeout_seconds", 30)),
    )
    return ToolResult(
        success=completed.returncode == 0,
        output=_output_from_completed(completed),
        metadata={"returncode": completed.returncode},
        error=None
        if completed.returncode == 0
        else f"git status exited with {completed.returncode}",
    )


def _git_log(arguments: dict[str, Any], root: Path) -> ToolResult:
    limit = max(1, min(int(arguments.get("limit", 20)), 100))
    command = [
        "git",
        "log",
        f"--max-count={limit}",
        "--date=iso-strict",
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1e",
    ]
    path = str(arguments.get("path", "")).strip()
    if path:
        resolved = _resolve_path(root, path)
        relative_path = resolved.relative_to(root).as_posix()
        command.extend(["--", relative_path])
    completed = _run_command(
        command,
        cwd=root,
        timeout_seconds=int(arguments.get("timeout_seconds", 30)),
    )
    if completed.returncode != 0:
        return ToolResult(
            success=False,
            output=_output_from_completed(completed),
            metadata={"returncode": completed.returncode, "count": 0},
            error=f"git log exited with {completed.returncode}",
        )
    commits = []
    for record in completed.stdout.split("\x1e"):
        fields = record.strip("\r\n").split("\x1f", 6)
        if len(fields) != 7:
            continue
        commit_hash, short_hash, author, email, date, subject, body = fields
        commits.append(
            {
                "hash": commit_hash,
                "short_hash": short_hash,
                "author": author,
                "email": email,
                "date": date,
                "subject": subject,
                "body": body.strip(),
            }
        )
    return ToolResult(
        success=True,
        output=json.dumps(commits, indent=2),
        metadata={"returncode": 0, "count": len(commits), "path": path or None},
    )


def _git_diff(arguments: dict[str, Any], root: Path) -> ToolResult:
    target = arguments.get("path", ".")
    if not target.strip():
        target = "."
    _resolve_path(root, target)
    command = ["git", "diff"]
    if arguments.get("staged", False):
        command.append("--cached")
    command.extend(["--", target])
    completed = _run_command(
        command,
        cwd=root,
        timeout_seconds=int(arguments.get("timeout_seconds", 30)),
    )
    output, output_metadata = _slice_output(
        _output_from_completed(completed), int(arguments.get("offset", 0)),
    )
    return ToolResult(
        success=completed.returncode == 0,
        output=output,
        metadata={"returncode": completed.returncode, "path": target, **output_metadata},
        error=None if completed.returncode == 0 else f"git diff exited with {completed.returncode}",
    )
