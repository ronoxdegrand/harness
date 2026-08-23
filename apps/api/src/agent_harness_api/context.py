from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .tools import ToolCall, ToolResult

DEFAULT_TOKEN_BUDGET = 32_000


@dataclass
class Message:
    role: str
    content: str
    name: str | None = None
    tool_call_id: str | None = None


class Context:
    def __init__(
        self,
        messages: list[Message] | None = None,
        token_budget: int = DEFAULT_TOKEN_BUDGET,
    ) -> None:
        self._messages = messages or []
        self.token_budget = max(1, token_budget)

    @property
    def messages(self) -> list[Message]:
        return [message for _, message in self._window()[0]]

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

    def inspect(self) -> dict[str, Any]:
        window, truncated = self._window()
        projected = dict(window)
        pinned = next(
            (index for index in range(len(self._messages) - 1, -1, -1) if self._messages[index].role == "user"),
            None,
        )
        items = []
        for index, message in enumerate(self._messages):
            selected = projected.get(index)
            content = selected.content if selected else message.content
            preview = " ".join(content.split())
            items.append(
                {
                    "index": index + 1,
                    "role": message.role,
                    "name": message.name,
                    "tokens": max(1, (len(content) + 3) // 4),
                    "included": selected is not None,
                    "pinned": index == pinned,
                    "truncated": index == truncated,
                    "preview": preview[:160],
                    "expandable": index == truncated or len(preview) > 160 or content.strip() != preview,
                }
            )
        return {
            "token_budget": self.token_budget,
            "estimated_tokens": sum(
                max(1, (len(message.content) + 3) // 4) for _, message in window
            ),
            "estimate_method": "message characters divided by 4",
            "messages": items,
        }

    def _window(self) -> tuple[list[tuple[int, Message]], int | None]:
        if not self._messages:
            return [], None

        remaining = self.token_budget
        window: list[tuple[int, Message]] = []
        truncated = None
        pinned = next(
            (index for index in range(len(self._messages) - 1, -1, -1) if self._messages[index].role == "user"),
            None,
        )
        if pinned is not None:
            message = self._messages[pinned]
            content = message.content[: remaining * 4]
            window.append((pinned, Message(message.role, content, message.name, message.tool_call_id)))
            remaining -= max(1, (len(content) + 3) // 4)
            if content != message.content:
                truncated = pinned

        for index in range(len(self._messages) - 1, -1, -1):
            if index == pinned or remaining <= 0:
                continue
            message = self._messages[index]
            tokens = max(1, (len(message.content) + 3) // 4)
            if tokens > remaining:
                if index > (pinned if pinned is not None else -1):
                    content = message.content[: remaining * 4]
                    window.append((index, Message(message.role, content, message.name, message.tool_call_id)))
                    truncated = index
                break
            window.append((index, message))
            remaining -= tokens

        window.sort(key=lambda item: item[0])
        return window, truncated

    @classmethod
    def from_snapshot(cls, messages: list[dict[str, Any]]) -> "Context":
        return cls(messages=[Message(**message) for message in messages])
