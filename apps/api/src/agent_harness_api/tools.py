from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


ToolHandler = Callable[[dict[str, Any], Path], "ToolResult"]

_SCHEMA_TYPE_MAP: dict[str, type[Any]] = {
    "boolean": bool,
    "integer": int,
    "string": str,
}


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
                input_schema={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                    "additionalProperties": False,
                },
                handler=_read_file,
            ),
            ToolDefinition(
                name="write_file",
                description="Write UTF-8 text content relative to the workspace root.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"],
                    "additionalProperties": False,
                },
                handler=_write_file,
            ),
            ToolDefinition(
                name="list_files",
                description="List files relative to the workspace root.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "limit": {"type": "integer"},
                    },
                    "additionalProperties": False,
                },
                handler=_list_files,
            ),
            ToolDefinition(
                name="search_files",
                description="Search files by text or regex pattern within the workspace root.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "path": {"type": "string"},
                        "limit": {"type": "integer"},
                        "regex": {"type": "boolean"},
                    },
                    "required": ["query"],
                    "additionalProperties": False,
                },
                handler=_search_files,
            ),
            ToolDefinition(
                name="shell",
                description="Run a command inside the workspace root or a subdirectory.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"},
                        "working_directory": {"type": "string"},
                        "timeout_seconds": {"type": "integer"},
                    },
                    "required": ["command"],
                    "additionalProperties": False,
                },
                handler=_shell,
            ),
            ToolDefinition(
                name="git_status",
                description="Return git status output for the workspace.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "timeout_seconds": {"type": "integer"},
                    },
                    "additionalProperties": False,
                },
                handler=_git_status,
            ),
            ToolDefinition(
                name="git_diff",
                description="Return git diff output for the workspace.",
                input_schema={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "timeout_seconds": {"type": "integer"},
                    },
                    "additionalProperties": False,
                },
                handler=_git_diff,
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
    entries = sorted(
        path.relative_to(root).as_posix() for path in search_root.rglob("*") if path.is_file()
    )
    limit = int(arguments.get("limit", 200))
    return ToolResult(
        success=True,
        output="\n".join(entries[:limit]),
        metadata={
            "count": len(entries),
            "returned": min(limit, len(entries)),
            "path": str(search_root.relative_to(root).as_posix()) if search_root != root else ".",
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


def _shell(arguments: dict[str, Any], root: Path) -> ToolResult:
    command = arguments["command"]
    timeout_seconds = int(arguments.get("timeout_seconds", 30))
    working_directory = _resolve_path(root, arguments.get("working_directory", "."))
    completed = subprocess.run(
        command,
        cwd=working_directory,
        shell=True,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    output = completed.stdout
    if completed.stderr:
        output = f"{output}\n{completed.stderr}".strip()

    return ToolResult(
        success=completed.returncode == 0,
        output=output,
        metadata={
            "returncode": completed.returncode,
            "working_directory": str(working_directory.relative_to(root).as_posix())
            if working_directory != root
            else ".",
        },
        error=None
        if completed.returncode == 0
        else f"Command exited with {completed.returncode}",
    )


def _git_status(arguments: dict[str, Any], root: Path) -> ToolResult:
    working_directory = _resolve_path(root, arguments.get("path", "."))
    completed = subprocess.run(
        ["git", "status", "--short"],
        cwd=working_directory,
        capture_output=True,
        text=True,
        timeout=int(arguments.get("timeout_seconds", 30)),
    )
    output = completed.stdout
    if completed.stderr:
        output = f"{output}\n{completed.stderr}".strip()
    return ToolResult(
        success=completed.returncode == 0,
        output=output,
        metadata={"returncode": completed.returncode},
        error=None
        if completed.returncode == 0
        else f"git status exited with {completed.returncode}",
    )


def _git_diff(arguments: dict[str, Any], root: Path) -> ToolResult:
    target = arguments.get("path", ".")
    _resolve_path(root, target)
    completed = subprocess.run(
        ["git", "diff", "--", target],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=int(arguments.get("timeout_seconds", 30)),
    )
    output = completed.stdout
    if completed.stderr:
        output = f"{output}\n{completed.stderr}".strip()
    return ToolResult(
        success=completed.returncode == 0,
        output=output,
        metadata={"returncode": completed.returncode, "path": target},
        error=None if completed.returncode == 0 else f"git diff exited with {completed.returncode}",
    )
