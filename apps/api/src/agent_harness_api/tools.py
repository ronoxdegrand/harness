from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


ToolHandler = Callable[[dict[str, Any], Path], "ToolResult"]


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
    handler: ToolHandler


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


class ToolExecutor:
    def __init__(self, registry: ToolRegistry) -> None:
        self.registry = registry

    def execute(self, call: ToolCall, *, target_path: Path) -> ToolResult:
        try:
            tool = self.registry.get(call.name)
            return tool.handler(call.arguments, target_path)
        except Exception as exc:
            return ToolResult(
                success=False,
                output="",
                error=str(exc),
                metadata={"tool_name": call.name},
            )


def build_default_tool_registry() -> ToolRegistry:
    return ToolRegistry(
        tools=[
            ToolDefinition(
                name="read_file",
                description="Read a UTF-8 text file relative to the target path.",
                handler=_read_file,
            ),
            ToolDefinition(
                name="list_files",
                description="List files relative to the target path.",
                handler=_list_files,
            ),
            ToolDefinition(
                name="search_files",
                description="Search file contents for a substring.",
                handler=_search_files,
            ),
            ToolDefinition(
                name="shell",
                description="Run a shell command in the target path.",
                handler=_shell,
            ),
            ToolDefinition(
                name="git_diff",
                description="Return git diff output for the target path.",
                handler=_git_diff,
            ),
        ]
    )


def _resolve_path(root: Path, relative_path: str) -> Path:
    resolved = (root / relative_path).resolve()
    if root not in resolved.parents and resolved != root:
        raise ValueError("Path escapes the target directory.")
    return resolved


def _read_file(arguments: dict[str, Any], root: Path) -> ToolResult:
    path = _resolve_path(root, arguments["path"])
    return ToolResult(success=True, output=path.read_text(encoding="utf-8"))


def _list_files(arguments: dict[str, Any], root: Path) -> ToolResult:
    relative_root = arguments.get("path", ".")
    search_root = _resolve_path(root, relative_root)
    entries = sorted(
        str(path.relative_to(root)).replace("\\", "/")
        for path in search_root.rglob("*")
        if path.is_file()
    )
    limit = int(arguments.get("limit", 200))
    return ToolResult(
        success=True,
        output="\n".join(entries[:limit]),
        metadata={"count": len(entries), "returned": min(limit, len(entries))},
    )


def _search_files(arguments: dict[str, Any], root: Path) -> ToolResult:
    query = arguments["query"]
    limit = int(arguments.get("limit", 50))
    matches: list[str] = []

    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for index, line in enumerate(content.splitlines(), start=1):
            if query in line:
                matches.append(
                    f"{path.relative_to(root).as_posix()}:{index}:{line.strip()}"
                )
                if len(matches) >= limit:
                    return ToolResult(
                        success=True,
                        output="\n".join(matches),
                        metadata={"count": len(matches), "truncated": True},
                    )

    return ToolResult(
        success=True,
        output="\n".join(matches),
        metadata={"count": len(matches), "truncated": False},
    )


def _shell(arguments: dict[str, Any], root: Path) -> ToolResult:
    command = arguments["command"]
    timeout_seconds = int(arguments.get("timeout_seconds", 30))
    completed = subprocess.run(
        command,
        cwd=root,
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
        metadata={"returncode": completed.returncode},
        error=None if completed.returncode == 0 else f"Command exited with {completed.returncode}",
    )


def _git_diff(arguments: dict[str, Any], root: Path) -> ToolResult:
    target = arguments.get("path", ".")
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
        metadata={"returncode": completed.returncode},
        error=None if completed.returncode == 0 else f"git diff exited with {completed.returncode}",
    )
