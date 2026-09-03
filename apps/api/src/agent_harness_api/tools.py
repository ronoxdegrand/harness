from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .git_status import (
    GitBranchSwitchError,
    discard_git_changes,
    read_git_status,
    switch_git_branch,
    update_git_index,
)

ToolHandler = Callable[[dict[str, Any], Path], "ToolResult"]

_SCHEMA_TYPE_MAP: dict[str, type[Any]] = {
    "array": list,
    "boolean": bool,
    "integer": int,
    "string": str,
}


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
                description="Read a UTF-8 text file relative to the workspace root.",
                input_schema=_object_schema(
                    {"path": {"type": "string"}},
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
                name="list_files",
                description=(
                    "List files relative to the workspace root. Dot-prefixed files and directories "
                    "are excluded unless include_hidden is true."
                ),
                input_schema=_object_schema(
                    {
                        "path": {"type": "string"},
                        "limit": {"type": "integer"},
                        "include_hidden": {"type": "boolean"},
                    },
                ),
                handler=_list_files,
                replay_policy="safe",
            ),
            ToolDefinition(
                name="search_files",
                description="Search files by text or regex pattern within the workspace root.",
                input_schema=_object_schema(
                    {
                        "query": {"type": "string"},
                        "path": {"type": "string"},
                        "limit": {"type": "integer"},
                        "regex": {"type": "boolean"},
                    },
                    required=["query"],
                ),
                handler=_search_files,
                replay_policy="safe",
            ),
            ToolDefinition(
                name="shell",
                description="Run a command inside the workspace root or a subdirectory.",
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
                description="Return unstaged or staged git diff output. An omitted or blank path means the workspace root.",
                input_schema=_object_schema(
                    {
                        "path": {"type": "string"},
                        "staged": {"type": "boolean"},
                        "timeout_seconds": {"type": "integer"},
                    },
                ),
                handler=_git_diff,
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


def _read_file(arguments: dict[str, Any], root: Path) -> ToolResult:
    path = _resolve_path(root, arguments["path"])
    return ToolResult(
        success=True,
        output=path.read_text(encoding="utf-8"),
        metadata={"path": str(path.relative_to(root).as_posix())},
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


def _list_files(arguments: dict[str, Any], root: Path) -> ToolResult:
    relative_root = arguments.get("path", ".")
    search_root = _resolve_path(root, relative_root)
    include_hidden = bool(arguments.get("include_hidden", False))
    entries = []
    for path in search_root.rglob("*"):
        relative_path = path.relative_to(root)
        if path.is_file() and (
            include_hidden or not any(part.startswith(".") for part in relative_path.parts)
        ):
            entries.append(relative_path.as_posix())
    entries.sort()
    limit = int(arguments.get("limit", 200))
    return ToolResult(
        success=True,
        output="\n".join(entries[:limit]),
        metadata={
            "count": len(entries),
            "returned": min(limit, len(entries)),
            "path": str(search_root.relative_to(root).as_posix()) if search_root != root else ".",
            "include_hidden": include_hidden,
        },
    )


def _search_files(arguments: dict[str, Any], root: Path) -> ToolResult:
    query = arguments["query"]
    search_root = _resolve_path(root, arguments.get("path", "."))
    limit = int(arguments.get("limit", 50))
    use_regex = bool(arguments.get("regex", False))
    compiled = re.compile(query) if use_regex else None
    matches: list[str] = []

    for path in search_root.rglob("*"):
        if not path.is_file():
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
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
        metadata={"count": len(matches), "truncated": False, "regex": use_regex},
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

    return ToolResult(
        success=completed.returncode == 0,
        output=_output_from_completed(completed),
        metadata={
            "returncode": completed.returncode,
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
    return ToolResult(
        success=completed.returncode == 0,
        output=_output_from_completed(completed),
        metadata={"returncode": completed.returncode, "path": target},
        error=None if completed.returncode == 0 else f"git diff exited with {completed.returncode}",
    )
