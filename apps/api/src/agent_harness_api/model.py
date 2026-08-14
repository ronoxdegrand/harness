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
    def complete(self, context: Context) -> ModelResponse:
        ...

