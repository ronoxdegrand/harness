from contextlib import asynccontextmanager
import secrets

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import DEFAULT_MODEL, get_settings
from .db import LATEST_SCHEMA_VERSION, database_status, initialize_database
from .store import RunStore, Thread, thread_title_from_prompt
from .ws import handle_run_websocket, resolve_workspace_path


class ThreadCreateRequest(BaseModel):
    workspace_path: str
    title: str | None = None
    prompt: str | None = None


class ThreadRenameRequest(BaseModel):
    title: str


def _thread_payload(store: RunStore, thread: Thread) -> dict[str, object]:
    return {
        "thread": thread.as_dict(),
        "turns": store.list_turns(thread.id),
        "events": store.list_thread_events(thread.id),
        "context": store.get_thread_context(thread.id),
    }


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


settings = get_settings()
app = FastAPI(title=settings.app_name, lifespan=lifespan)


@app.middleware("http")
async def authenticate(request: Request, call_next):
    token = get_settings().auth_token
    authorization = request.headers.get("authorization", "")
    if token and not secrets.compare_digest(authorization, f"Bearer {token}"):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ok",
        "service": settings.app_name,
        "environment": settings.app_env,
    }


@app.get("/health/ready")
async def health_ready() -> dict[str, str | int]:
    settings = get_settings()
    return {
        "status": "ready",
        "version": settings.app_version,
        "schema_version": LATEST_SCHEMA_VERSION,
    }


@app.get("/health/db")
async def health_db() -> dict[str, str | bool | int]:
    return database_status()


@app.post("/shutdown", status_code=202)
async def shutdown(request: Request) -> dict[str, str]:
    callback = getattr(request.app.state, "request_shutdown", None)
    if callback is None:
        raise HTTPException(status_code=409, detail="Managed shutdown is not available.")
    callback()
    return {"status": "shutting_down"}


@app.get("/threads")
async def list_threads() -> dict[str, list[dict[str, str]]]:
    return {"threads": [thread.as_dict() for thread in RunStore().list_threads()]}


@app.post("/threads")
async def create_thread(request: ThreadCreateRequest) -> dict[str, object]:
    settings = get_settings()
    if not request.workspace_path.strip():
        raise HTTPException(status_code=400, detail="Workspace path is required.")
    try:
        workspace_path = resolve_workspace_path(
            settings.workspace_root,
            request.workspace_path.strip(),
            settings.allow_absolute_workspaces,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not workspace_path.is_dir():
        raise HTTPException(status_code=400, detail="Workspace path does not exist or is not a directory.")
    if not request.title and not request.prompt:
        raise HTTPException(status_code=400, detail="Thread title or first prompt is required.")
    store = RunStore()
    thread = store.create_thread(
        workspace_path=workspace_path,
        model_name=DEFAULT_MODEL,
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


@app.get("/threads/{thread_id}/context/{message_index}")
async def get_thread_context_entry(thread_id: str, message_index: int) -> dict[str, str]:
    content = RunStore().get_thread_context_entry(thread_id, message_index)
    if content is None:
        raise HTTPException(status_code=404, detail="Context entry not found.")
    return {"content": content}


@app.patch("/threads/{thread_id}")
async def rename_thread(thread_id: str, request: ThreadRenameRequest) -> dict[str, str]:
    title = request.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Thread title cannot be empty.")
    if len(title) > 80:
        raise HTTPException(status_code=400, detail="Thread title must be 80 characters or fewer.")

    thread = RunStore().rename_thread(thread_id, title)
    if thread is None:
        raise HTTPException(status_code=404, detail="Thread not found.")
    return thread.as_dict()


@app.delete("/threads/{thread_id}", status_code=204)
async def delete_thread(thread_id: str) -> None:
    if not RunStore().delete_thread(thread_id):
        raise HTTPException(status_code=404, detail="Thread not found.")


@app.websocket("/ws/run")
async def run_websocket(websocket: WebSocket) -> None:
    settings = get_settings()
    authorization = websocket.headers.get("authorization", "")
    query_token = websocket.query_params.get("token", "")
    if settings.auth_token and not (
        secrets.compare_digest(authorization, f"Bearer {settings.auth_token}")
        or secrets.compare_digest(query_token, settings.auth_token)
    ):
        await websocket.close(code=1008, reason="Unauthorized")
        return
    await handle_run_websocket(websocket, settings)


if settings.web_dist_path and settings.web_dist_path.is_dir():
    app.mount("/", StaticFiles(directory=settings.web_dist_path, html=True), name="web")
