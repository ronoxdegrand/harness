from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .tools import ToolCall, ToolResult


@dataclass
class Message:
    role: str
    content: str
    name: str | None = None
    tool_call_id: str | None = None


class Context:
    def __init__(self, messages: list[Message] | None = None) -> None:
        self._messages = messages or []

    @property
    def messages(self) -> list[Message]:
        return self._messages

    def add_user(self, content: str) -> None:
        self._messages.append(Message(role="user", content=content))

    def add_assistant(self, content: str) -> None:
        self._messages.append(Message(role="assistant", content=content))

    def add_tool_result(self, call: ToolCall, result: ToolResult) -> None:
        self._messages.append(
            Message(
                role="tool",
                name=call.name,
                tool_call_id=call.id,
                content=result.to_message_content(),
            )
        )

    def snapshot(self) -> list[dict[str, Any]]:
        return [asdict(message) for message in self._messages]

    @classmethod
    def from_snapshot(cls, messages: list[dict[str, Any]]) -> "Context":
        return cls(messages=[Message(**message) for message in messages])

