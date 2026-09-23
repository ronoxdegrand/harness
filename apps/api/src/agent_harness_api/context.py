from __future__ import annotations

import json
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
        self.retry_instruction: str | None = None
        self.request_token_limit: int | None = None

    @property
    def messages(self) -> list[Message]:
        return [message for _, message in self._window()[0]]

    def messages_for_budget(self, token_budget: int) -> list[Message]:
        return [message for _, message in self._window(max(1, token_budget))[0]]

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

    def compact_if_needed(self) -> dict[str, int] | None:
        """Keep recent context and a bounded checkpoint without old tool output."""
        if self.token_budget < 512 or len(self._messages) < 4:
            return None
        before = sum(max(1, (len(message.content) + 3) // 4) for message in self._messages)
        if before < self.token_budget * 0.65:
            return None

        recent_budget = int(self.token_budget * 0.45)
        recent_indices: set[int] = set()
        recent_tokens = 0
        for index in range(len(self._messages) - 1, -1, -1):
            message = self._messages[index]
            if message.role == "checkpoint":
                continue
            tokens = max(1, (len(message.content) + 3) // 4)
            if recent_tokens + tokens > recent_budget:
                break
            recent_indices.add(index)
            recent_tokens += tokens

        latest_user = next(
            (index for index in range(len(self._messages) - 1, -1, -1)
             if self._messages[index].role == "user"),
            None,
        )
        if latest_user is not None:
            recent_indices.add(latest_user)
        older = [message for index, message in enumerate(self._messages) if index not in recent_indices]
        if not older:
            return None

        lines = [
            "Conversation checkpoint from older messages. This is history, not a new request. "
            "Repository content and tool output were omitted; re-read files before relying on them. "
            "If an older request was truncated, ask for its missing detail before acting."
        ]
        previous = [message.content for message in older if message.role == "checkpoint"]
        if previous:
            lines.append(
                previous[-1][:4_000]
                + (" [older checkpoint truncated]" if len(previous[-1]) > 4_000 else "")
            )
        first_user = next((message for message in older if message.role == "user"), None)
        for message in older:
            if message.role == "user":
                limit = 4_000 if message is first_user else 2_000
                excerpt = message.content[:limit]
                lines.append(
                    f"Earlier user request: {json.dumps(excerpt)}"
                    + (" [request truncated]" if len(message.content) > limit else "")
                )
            elif message.role == "tool" and message.name in {"write_file", "patch"}:
                try:
                    result = json.loads(message.content)
                except (TypeError, ValueError):
                    continue
                if isinstance(result, dict) and result.get("success"):
                    path = result.get("metadata", {}).get("path", "unknown path")
                    lines.append(f"Successful {message.name} edit: {json.dumps(str(path))}")
        checkpoint = "\n".join(lines)[:8_000]
        recent = [message for index, message in enumerate(self._messages) if index in recent_indices]
        original = self._messages
        self._messages = [Message(role="checkpoint", content=checkpoint), *recent]
        after = sum(max(1, (len(message.content) + 3) // 4) for message in self._messages)
        if after >= before:
            self._messages = original
            return None
        return {"before_tokens": before, "after_tokens": after, "messages_removed": len(older)}

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

    def _window(self, token_budget: int | None = None) -> tuple[list[tuple[int, Message]], int | None]:
        if not self._messages:
            return [], None

        remaining = self.token_budget if token_budget is None else min(self.token_budget, token_budget)
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
                if message.role == "tool" or index > (pinned if pinned is not None else -1):
                    if message.role == "tool":
                        try:
                            payload = json.loads(message.content)
                            path = payload.get("metadata", {}).get("path")
                        except (TypeError, ValueError, AttributeError):
                            path = None
                        note = (
                            f"Tool result for {message.name} was omitted to fit the request budget. "
                            f"Path: {path or 'unknown'}. Re-read a narrow line range if needed."
                        )
                        content = note[:remaining * 4]
                    else:
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
        return cls(messages=[Message(**message) for message in messages if message["role"] != "feedback"])
