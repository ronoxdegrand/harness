from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket
from pydantic import BaseModel

from .config import get_settings
from .db import database_status, initialize_database
from .store import RunStore, Thread, thread_title_from_prompt
from .ws import handle_run_websocket, resolve_workspace_path


class ThreadCreateRequest(BaseModel):
    workspace_path: str = "."
    title: str | None = None
    prompt: str | None = None


def _thread_payload(store: RunStore, thread: Thread) -> dict[str, object]:
    return {
        "thread": thread.as_dict(),
        "turns": store.list_turns(thread.id),
        "events": store.list_thread_events(thread.id),
    }


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


settings = get_settings()
app = FastAPI(title=settings.app_name, lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": settings.app_name,
        "environment": settings.app_env,
    }


@app.get("/health/db")
async def health_db() -> dict[str, str | bool]:
    return database_status()


@app.get("/threads")
async def list_threads() -> dict[str, list[dict[str, str]]]:
    return {"threads": [thread.as_dict() for thread in RunStore().list_threads()]}


@app.post("/threads")
async def create_thread(request: ThreadCreateRequest) -> dict[str, object]:
    settings = get_settings()
    try:
        workspace_path = resolve_workspace_path(settings.workspace_root, request.workspace_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not workspace_path.is_dir():
        raise HTTPException(status_code=400, detail="Workspace path does not exist or is not a directory.")
    if not request.title and not request.prompt:
        raise HTTPException(status_code=400, detail="Thread title or first prompt is required.")

    store = RunStore()
    thread = store.create_thread(
        workspace_path=workspace_path,
        model_name=settings.gemini_model,
        title=request.title or thread_title_from_prompt(request.prompt or ""),
    )
    return _thread_payload(store, thread)


@app.get("/threads/{thread_id}")
async def get_thread(thread_id: str) -> dict[str, object]:
    store = RunStore()
    thread = store.get_thread(thread_id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Thread not found.")
    return _thread_payload(store, thread)


@app.websocket("/ws/run")
async def run_websocket(websocket: WebSocket) -> None:
    await handle_run_websocket(websocket, get_settings())
