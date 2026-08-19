from __future__ import annotations

import asyncio
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from .config import DEFAULT_MODEL, Settings
from .context import Context
from .events import EventEmitter, RuntimeEvent
from .gemini_model import GeminiModelProvider
from .runtime import AgentRuntime
from .store import RunStore, Thread, thread_title_from_prompt
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
    except ValueError:
        await _fail_run(websocket, "Request must contain valid JSON.")
        return

    if not isinstance(request, dict):
        await _fail_run(websocket, "Request must be a JSON object.")
        return

    task = request.get("task")
    workspace_path = request.get("workspace_path", ".")
    requested_thread_id = request.get("thread_id")
    requested_model = request.get("model_name")
    requested_title = request.get("title")

    if not isinstance(task, str) or not (prompt := task.strip()):
        await _fail_run(websocket, "Task is required to start a run.")
        return

    if not isinstance(workspace_path, str):
        await _fail_run(websocket, "Workspace path must be a string.")
        return
    workspace_path = workspace_path.strip() or "."

    if requested_model is not None and (
        not isinstance(requested_model, str) or not requested_model.strip()
    ):
        await _fail_run(websocket, "Model name must be a non-empty string.")
        return

    if requested_title is not None and (
        not isinstance(requested_title, str) or not requested_title.strip()
    ):
        await _fail_run(websocket, "Thread title must be a non-empty string.")
        return
    if isinstance(requested_title, str) and len(requested_title.strip()) > 80:
        await _fail_run(websocket, "Thread title must be 80 characters or fewer.")
        return

    store = RunStore()
    thread: Thread | None = None
    if requested_thread_id is not None:
        if not isinstance(requested_thread_id, str) or not requested_thread_id.strip():
            await _fail_run(websocket, "Thread ID must be a string.")
            return
        thread = store.get_thread(requested_thread_id)
        if thread is None:
            await _fail_run(websocket, "Thread not found.")
            return
        target_path = Path(thread.workspace_path).resolve()
        root = settings.workspace_root.resolve()
        if target_path != root and root not in target_path.parents:
            await _fail_run(websocket, "Thread workspace escapes the configured workspace root.")
            return
    else:
        try:
            target_path = resolve_workspace_path(settings.workspace_root, workspace_path)
        except ValueError as exc:
            await _fail_run(websocket, str(exc))
            return
    if not target_path.is_dir():
        await _fail_run(websocket, "Workspace path does not exist or is not a directory.")
        return

    model_name = requested_model.strip() if requested_model else (
        thread.model_name if thread else DEFAULT_MODEL
    )

    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    emitter = EventEmitter()

    def on_event(event: RuntimeEvent) -> None:
        _push_message(loop, queue, {"kind": "runtime.event", "event": event.as_dict()})

    emitter.subscribe(on_event)
    try:
        runtime = build_runtime(
            target_path,
            emitter,
            api_key=settings.gemini_api_key,
            model_name=model_name,
        )
    except ValueError as exc:
        await _fail_run(websocket, str(exc))
        return

    if thread is None:
        thread = store.create_thread(
            workspace_path=target_path,
            model_name=model_name,
            title=requested_title.strip() if requested_title else thread_title_from_prompt(prompt),
        )
    await websocket.send_json({"kind": "thread.opened", "payload": {"thread": thread.as_dict()}})

    run_id = str(uuid.uuid4())
    history = Context.from_snapshot(
        [
            {"role": turn["role"], "content": turn["content"], "name": None, "tool_call_id": None}
            for turn in store.list_turns(thread.id)
        ]
    )
    store.append_turn(
        thread_id=thread.id,
        role="user",
        content=prompt,
        run_id=run_id,
        model_name=model_name,
    )

    def run_agent() -> None:
        try:
            result = runtime.run(
                prompt,
                target_path=target_path,
                run_id=run_id,
                thread_id=thread.id,
                initial_context=history,
            )
            store.append_turn(
                thread_id=thread.id,
                role="assistant",
                content=result.output_text,
                run_id=result.run_id,
            )
            _push_message(
                loop,
                queue,
                {
                    "kind": "run.completed",
                    "payload": {
                        "run_id": result.run_id,
                        "thread_id": thread.id,
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

    agent_thread = threading.Thread(target=run_agent, daemon=True)
    agent_thread.start()

    try:
        while True:
            message = await queue.get()
            await websocket.send_json(message)
            if message["kind"] == "run.finished":
                break
    except WebSocketDisconnect:
        return
