from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from .context import Context
from .model import ModelProvider, ModelResponse
from .tools import ToolCall, ToolResult


@dataclass
class PlannedStep:
    name: str
    arguments: dict[str, object]
    delta: str


class BrowserDemoModelProvider(ModelProvider):
    def __init__(self, workspace_root: Path) -> None:
        self.workspace_root = workspace_root

    def complete(self, context: Context) -> ModelResponse:
        prompt = next(
            (message.content for message in context.messages if message.role == "user"),
            "",
        )
        tool_messages = [message for message in context.messages if message.role == "tool"]
        plan = self._build_plan(prompt)

        if len(tool_messages) < len(plan):
            step = plan[len(tool_messages)]
            return ModelResponse(
                deltas=[step.delta],
                tool_calls=[
                    ToolCall(
                        id=f"step-{len(tool_messages) + 1}",
                        name=step.name,
                        arguments=step.arguments,
                    )
                ],
            )

        summary = self._build_summary(tool_messages)
        return ModelResponse(
            deltas=["Summarizing the run"],
            output_text=summary,
        )

    def _build_plan(self, prompt: str) -> list[PlannedStep]:
        normalized = prompt.lower()
        plan: list[PlannedStep] = [
            PlannedStep(
                name="list_files",
                arguments={"path": ".", "limit": 200},
                delta="Listing files in the workspace",
            )
        ]

        if "search" in normalized or "find" in normalized or "inspect" in normalized:
            query = _extract_search_query(prompt) or "AgentRuntime"
            plan.append(
                PlannedStep(
                    name="search_files",
                    arguments={"query": query, "path": ".", "limit": 25},
                    delta=f'Searching for "{query}"',
                )
            )

        read_path = _extract_read_path(prompt)
        if read_path:
            plan.append(
                PlannedStep(
                    name="read_file",
                    arguments={"path": read_path},
                    delta=f"Reading {read_path}",
                )
            )

        if any(word in normalized for word in ("test", "pytest", "bug", "fix")):
            working_directory = "apps/api" if (self.workspace_root / "apps" / "api").exists() else "."
            plan.append(
                PlannedStep(
                    name="shell",
                    arguments={
                        "command": f'"{sys.executable}" -m pytest -q',
                        "working_directory": working_directory,
                        "timeout_seconds": 60,
                    },
                    delta="Running the test suite",
                )
            )

        if "status" in normalized:
            plan.append(
                PlannedStep(
                    name="git_status",
                    arguments={},
                    delta="Checking git status",
                )
            )

        if "diff" in normalized:
            plan.append(
                PlannedStep(
                    name="git_diff",
                    arguments={"path": "."},
                    delta="Inspecting the git diff",
                )
            )

        return plan

    def _build_summary(self, tool_messages: list[object]) -> str:
        parsed_results: list[tuple[str | None, ToolResult | None]] = []
        for message in tool_messages:
            tool_name = getattr(message, "name", None)
            try:
                payload = ToolResult(**json.loads(getattr(message, "content", "{}")))
            except Exception:
                payload = None
            parsed_results.append((tool_name, payload))

        if not parsed_results:
            return "No tool steps were executed."

        summary_lines: list[str] = []
        for tool_name, payload in parsed_results:
            if payload is None:
                continue
            status = "ok" if payload.success else "failed"
            preview = payload.output.strip().splitlines()
            first_line = preview[0] if preview else (payload.error or "no output")
            summary_lines.append(f"{tool_name}: {status} - {first_line[:140]}")

        return "\n".join(summary_lines) if summary_lines else "The run completed."


def _extract_search_query(prompt: str) -> str | None:
    quoted = re.search(r'"([^"]+)"', prompt)
    if quoted:
        return quoted.group(1)

    search_for = re.search(r"(?:search|find)(?: for)? ([\w./:-]+)", prompt, re.IGNORECASE)
    if search_for:
        return search_for.group(1)
    return None


def _extract_read_path(prompt: str) -> str | None:
    quoted = re.search(r'(?:read|open) "([^"]+)"', prompt, re.IGNORECASE)
    if quoted:
        return quoted.group(1)

    bare = re.search(r"(?:read|open) ([\w./-]+\.[\w]+)", prompt, re.IGNORECASE)
    if bare:
        return bare.group(1)
    return None
