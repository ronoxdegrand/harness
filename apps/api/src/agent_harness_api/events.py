from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


EventHandler = Callable[["RuntimeEvent"], None]


@dataclass
class RuntimeEvent:
    type: str
    payload: dict[str, Any]
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def as_dict(self) -> dict[str, Any]:
        return {"type": self.type, "payload": self.payload, "created_at": self.created_at}


class EventEmitter:
    def __init__(self) -> None:
        self._handlers: list[EventHandler] = []

    def subscribe(self, handler: EventHandler) -> None:
        self._handlers.append(handler)

    def emit(self, event_type: str, **payload: Any) -> RuntimeEvent:
        event = RuntimeEvent(type=event_type, payload=payload)
        for handler in self._handlers:
            handler(event)
        return event
