from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from .context import Context
from .tools import ToolCall


@dataclass
class ModelResponse:
    output_text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    deltas: list[str] = field(default_factory=list)


class ModelProvider(Protocol):
    def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
        ...


def system_prompt(final_response: bool) -> str:
    if final_response:
        return (
            "Produce the final answer for the user from the work and tool results already in context. "
            "Do not request more tools or describe future work. State what was done, relevant verification, "
            "and any remaining limitation concisely."
        )
    return (
        "You are an autonomous coding agent. Use the available tools to inspect the repository, "
        "execute tests, and answer the user's task. "
        "When the task requires repo inspection or command execution, call a tool directly instead of "
        "describing the action. Prefer structured function calls for file reads, searches, and shell commands. "
        "Only respond with plain text when no tool call is needed or after tool results have been collected."
    )
