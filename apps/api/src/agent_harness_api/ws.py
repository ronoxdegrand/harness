from __future__ import annotations

import asyncio
import threading
import uuid
from pathlib import Path
from queue import Queue
from typing import Any, Callable

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from .config import DEFAULT_MODEL, Settings
from .context import Context
from .events import EventEmitter, RuntimeEvent
from .gemini_model import GeminiModelProvider
from .runtime import AgentRuntime
from .sarvam_model import SarvamModelProvider
from .store import RunStore, Thread, thread_title_from_prompt
from .tools import ToolExecutor, build_default_tool_registry


def resolve_workspace_path(
    workspace_root: Path, workspace_path: str, allow_absolute: bool = False
) -> Path:
    resolved_root = workspace_root.resolve()
    requested_path = Path(workspace_path)
    resolved_target = (
        requested_path.resolve()
        if allow_absolute and requested_path.is_absolute()
        else (resolved_root / requested_path).resolve()
    )
    if (
        not (allow_absolute and requested_path.is_absolute())
        and resolved_target != resolved_root
        and resolved_root not in resolved_target.parents
    ):
        raise ValueError("Workspace path escapes the configured workspace root.")
    return resolved_target


def build_runtime(
    workspace_path: Path,
    emitter: EventEmitter,
    *,
    gemini_api_key: str | None,
    sarvam_api_key: str | None,
    model_name: str,
    max_iterations: int,
    continuation_decider: Callable[[int], bool],
) -> AgentRuntime:
    registry = build_default_tool_registry()
    if model_name == "sarvam-105b":
        model = SarvamModelProvider(
            api_key=sarvam_api_key, model_name=model_name, tool_registry=registry
        )
    elif model_name.startswith("gemini-"):
        model = GeminiModelProvider(
            api_key=gemini_api_key, model_name=model_name, tool_registry=registry
        )
    else:
        raise ValueError(f"Unsupported model: {model_name}")
    return AgentRuntime(
        model=model,
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=RunStore(),
        event_emitter=emitter,
        max_iterations=max_iterations,
        timeout_seconds=120,
        continuation_decider=continuation_decider,
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
    workspace_path = request.get("workspace_path")
    requested_thread_id = request.get("thread_id")
    requested_model = request.get("model_name")
    requested_title = request.get("title")
    requested_api_key = request.get("api_key")
    requested_sarvam_api_key = request.get("sarvam_api_key")
    requested_max_iterations = request.get("max_iterations")

    if not isinstance(task, str) or not (prompt := task.strip()):
        await _fail_run(websocket, "Task is required to start a run.")
        return

    if requested_model is not None and (
        not isinstance(requested_model, str) or not requested_model.strip()
    ):
        await _fail_run(websocket, "Model name must be a non-empty string.")
        return

    if requested_api_key is not None and (
        not isinstance(requested_api_key, str) or not requested_api_key.strip()
    ):
        await _fail_run(websocket, "API key must be a non-empty string.")
        return

    if requested_sarvam_api_key is not None and (
        not isinstance(requested_sarvam_api_key, str)
        or not requested_sarvam_api_key.strip()
    ):
        await _fail_run(websocket, "Sarvam API key must be a non-empty string.")
        return

    if requested_max_iterations is not None and (
        isinstance(requested_max_iterations, bool)
        or not isinstance(requested_max_iterations, int)
        or not 1 <= requested_max_iterations <= 50
    ):
        await _fail_run(websocket, "Max iterations must be an integer between 1 and 50.")
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
        if (
            not settings.allow_absolute_workspaces
            and target_path != root
            and root not in target_path.parents
        ):
            await _fail_run(websocket, "Thread workspace escapes the configured workspace root.")
            return
    else:
        if workspace_path is None:
            await _fail_run(websocket, "Workspace path is required for a new thread.")
            return
        if not isinstance(workspace_path, str):
            await _fail_run(websocket, "Workspace path must be a string.")
            return
        workspace_path = workspace_path.strip()
        if not workspace_path:
            await _fail_run(websocket, "Workspace path is required for a new thread.")
            return
        try:
            target_path = resolve_workspace_path(
                settings.workspace_root,
                workspace_path,
                settings.allow_absolute_workspaces,
            )
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
    continuation_decisions: Queue[bool] = Queue()
    loop = asyncio.get_running_loop()
    emitter = EventEmitter()

    def on_event(event: RuntimeEvent) -> None:
        _push_message(loop, queue, {"kind": "runtime.event", "event": event.as_dict()})

    def decide_continuation(completed_iterations: int) -> bool:
        _push_message(
            loop,
            queue,
            {
                "kind": "run.continuation_required",
                "payload": {
                    "iteration": completed_iterations,
                    "completed_iterations": completed_iterations,
                    "additional_iterations": requested_max_iterations or 8,
                },
            },
        )
        return continuation_decisions.get()

    emitter.subscribe(on_event)
    try:
        runtime = build_runtime(
            target_path,
            emitter,
            gemini_api_key=(
                requested_api_key.strip() if requested_api_key else settings.gemini_api_key
            ),
            sarvam_api_key=(
                requested_sarvam_api_key.strip()
                if requested_sarvam_api_key
                else settings.sarvam_api_key
            ),
            model_name=model_name,
            max_iterations=requested_max_iterations or 8,
            continuation_decider=decide_continuation,
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
    run_id = str(uuid.uuid4())
    await websocket.send_json(
        {"kind": "thread.opened", "payload": {"thread": thread.as_dict(), "run_id": run_id}}
    )

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
                model_name=model_name,
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
            if message["kind"] == "run.continuation_required":
                try:
                    decision = await websocket.receive_json()
                except (ValueError, WebSocketDisconnect):
                    continuation_decisions.put(False)
                    return
                continuation_decisions.put(
                    isinstance(decision, dict)
                    and decision.get("kind") == "run.continuation_decision"
                    and decision.get("continue") is True
                )
            if message["kind"] == "run.finished":
                break
    except WebSocketDisconnect:
        return
