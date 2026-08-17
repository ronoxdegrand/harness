from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from .config import Settings
from .events import EventEmitter, RuntimeEvent
from .gemini_model import GeminiModelProvider
from .runtime import AgentRuntime
from .store import RunStore
from .tools import ToolExecutor, build_default_tool_registry


def resolve_workspace_path(workspace_root: Path, workspace_path: str) -> Path:
    resolved_root = workspace_root.resolve()
    resolved_target = (resolved_root / workspace_path).resolve()
    if resolved_target != resolved_root and resolved_root not in resolved_target.parents:
        raise ValueError("Workspace path escapes the configured workspace root.")
    return resolved_target


def build_runtime(
    workspace_path: Path,
    emitter: EventEmitter,
    *,
    api_key: str | None,
    model_name: str,
) -> AgentRuntime:
    registry = build_default_tool_registry()
    return AgentRuntime(
        model=GeminiModelProvider(
            api_key=api_key,
            model_name=model_name,
            tool_registry=registry,
        ),
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=RunStore(),
        event_emitter=emitter,
        max_iterations=8,
        timeout_seconds=120,
    )


async def _fail_run(websocket: WebSocket, message: str) -> None:
    await websocket.send_json({"kind": "run.failed", "error": message})
    await websocket.close()


def _push_message(
    loop: asyncio.AbstractEventLoop,
    queue: asyncio.Queue[dict[str, Any]],
    message: dict[str, Any],
) -> None:
    loop.call_soon_threadsafe(queue.put_nowait, message)


async def handle_run_websocket(websocket: WebSocket, settings: Settings) -> None:
    await websocket.accept()
    await websocket.send_json(
        {
            "kind": "session.ready",
            "payload": {"workspace_root": str(settings.workspace_root.resolve())},
        }
    )

    try:
        request = await websocket.receive_json()
    except WebSocketDisconnect:
        return

    prompt = str(request.get("task", "")).strip()
    workspace_path = str(request.get("workspace_path", ".")).strip() or "."

    if not prompt:
        await _fail_run(websocket, "Task is required to start a run.")
        return

    try:
        target_path = resolve_workspace_path(settings.workspace_root, workspace_path)
    except ValueError as exc:
        await _fail_run(websocket, str(exc))
        return

    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    emitter = EventEmitter()

    def on_event(event: RuntimeEvent) -> None:
        _push_message(loop, queue, {"kind": "runtime.event", "event": event.as_dict()})

    emitter.subscribe(on_event)
    runtime = build_runtime(
        target_path,
        emitter,
        api_key=settings.gemini_api_key,
        model_name=settings.gemini_model,
    )

    def run_agent() -> None:
        try:
            result = runtime.run(prompt, target_path=target_path)
            _push_message(
                loop,
                queue,
                {
                    "kind": "run.completed",
                    "payload": {
                        "run_id": result.run_id,
                        "status": result.status,
                        "output_text": result.output_text,
                        "iterations": result.iterations,
                        "finalized_by_iteration_limit": result.finalized_by_iteration_limit,
                    },
                },
            )
        except Exception as exc:
            _push_message(loop, queue, {"kind": "run.failed", "error": str(exc)})
        finally:
            _push_message(loop, queue, {"kind": "run.finished"})

    thread = threading.Thread(target=run_agent, daemon=True)
    thread.start()

    try:
        while True:
            message = await queue.get()
            await websocket.send_json(message)
            if message["kind"] == "run.finished":
                break
    except WebSocketDisconnect:
        return
