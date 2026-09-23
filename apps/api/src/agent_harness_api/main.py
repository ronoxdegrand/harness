import asyncio
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketDisconnect
from watchfiles import awatch

from .config import get_settings
from .context import Context
from .db import LATEST_SCHEMA_VERSION, database_status, initialize_database
from .model_catalog import MODELS, build_model_provider, model_spec
from .git_status import (
    GitBranchSwitchError,
    GitStagedChangesWarning,
    GitDiff,
    GitStatus,
    commit_git_changes,
    discard_git_changes,
    read_commit_message_diff,
    read_git_file_diff,
    read_git_status,
    sync_git_branch,
    switch_git_branch,
    update_git_index,
    undo_last_git_commit,
)
from .store import RunStore, Thread, thread_title_from_prompt
from .tools import build_default_tool_registry
from .ws import handle_run_websocket, resolve_workspace_path


class ThreadCreateRequest(BaseModel):
    workspace_path: str
    title: str | None = None
    prompt: str | None = None
    model_name: str | None = None


class ThreadRenameRequest(BaseModel):
    title: str


class GitStatusRequest(BaseModel):
    workspace_path: str
    fetch_remote: bool = False


class GitIndexRequest(GitStatusRequest):
    paths: list[str] = Field(default_factory=list)


class GitUndoCommitRequest(GitStatusRequest):
    expected_head: str
    allow_staged: bool = False


class GitDiffRequest(GitStatusRequest):
    path: str
    staged: bool = False
    full_context: bool = False


class GitSwitchRequest(GitStatusRequest):
    branch: str
    force: bool = False


class GitCommitRequest(GitStatusRequest):
    message: str


class GitCommitMessageRequest(GitStatusRequest):
    model_name: str
    api_key: str | None = None
    sarvam_api_key: str | None = None


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


@app.get("/models")
async def list_models() -> dict[str, object]:
    return {
        "models": [
            {"id": spec.id, "provider": spec.provider, "selectable": spec.selectable}
            for spec in MODELS
        ],
    }


@app.post("/shutdown", status_code=202)
async def shutdown(request: Request) -> dict[str, str]:
    callback = getattr(request.app.state, "request_shutdown", None)
    if callback is None:
        raise HTTPException(status_code=409, detail="Managed shutdown is not available.")
    callback()
    return {"status": "shutting_down"}


@app.get("/threads")
async def list_threads() -> dict[str, list[dict[str, object]]]:
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
    if request.model_name is not None:
        try:
            model_spec(request.model_name.strip())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    store = RunStore()
    thread = store.create_thread(
        workspace_path=workspace_path,
        model_name=request.model_name.strip() if request.model_name else None,
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


@app.post("/git/status")
async def git_status(request: GitStatusRequest) -> GitStatus:
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
    return read_git_status(workspace_path, fetch_remote=request.fetch_remote)


@app.post("/git/diff")
async def git_diff(request: GitDiffRequest) -> GitDiff:
    settings = get_settings()
    if not request.workspace_path.strip():
        raise HTTPException(status_code=400, detail="Workspace path is required.")
    try:
        workspace_path = resolve_workspace_path(
            settings.workspace_root,
            request.workspace_path.strip(),
            settings.allow_absolute_workspaces,
        )
        if not workspace_path.is_dir():
            raise ValueError("Workspace path does not exist or is not a directory.")
        return read_git_file_diff(
            workspace_path,
            request.path,
            staged=request.staged,
            full_context=request.full_context,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _update_git_index(request: GitIndexRequest, *, stage: bool) -> GitStatus:
    settings = get_settings()
    if not request.workspace_path.strip():
        raise HTTPException(status_code=400, detail="Workspace path is required.")
    try:
        workspace_path = resolve_workspace_path(
            settings.workspace_root,
            request.workspace_path.strip(),
            settings.allow_absolute_workspaces,
        )
        if not workspace_path.is_dir():
            raise ValueError("Workspace path does not exist or is not a directory.")
        return update_git_index(workspace_path, request.paths, stage=stage)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/git/stage")
async def git_stage(request: GitIndexRequest) -> GitStatus:
    return _update_git_index(request, stage=True)


@app.post("/git/unstage")
async def git_unstage(request: GitIndexRequest) -> GitStatus:
    return _update_git_index(request, stage=False)


@app.post("/git/commit")
async def git_commit(request: GitCommitRequest) -> GitStatus:
    settings = get_settings()
    if not request.workspace_path.strip():
        raise HTTPException(status_code=400, detail="Workspace path is required.")
    try:
        workspace_path = resolve_workspace_path(
            settings.workspace_root,
            request.workspace_path.strip(),
            settings.allow_absolute_workspaces,
        )
        if not workspace_path.is_dir():
            raise ValueError("Workspace path does not exist or is not a directory.")
        return commit_git_changes(workspace_path, request.message)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/git/undo-commit")
async def git_undo_commit(request: GitUndoCommitRequest) -> GitStatus:
    settings = get_settings()
    try:
        if not request.workspace_path.strip():
            raise ValueError("Workspace path is required.")
        workspace_path = resolve_workspace_path(settings.workspace_root, request.workspace_path.strip(), settings.allow_absolute_workspaces)
        if not workspace_path.is_dir():
            raise ValueError("Workspace path does not exist or is not a directory.")
        return undo_last_git_commit(workspace_path, request.expected_head, allow_staged=request.allow_staged)
    except GitStagedChangesWarning as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/git/commit-message")
async def git_commit_message(request: GitCommitMessageRequest) -> dict[str, str]:
    settings = get_settings()
    if not request.workspace_path.strip():
        raise HTTPException(status_code=400, detail="Workspace path is required.")
    try:
        workspace_path = resolve_workspace_path(
            settings.workspace_root,
            request.workspace_path.strip(),
            settings.allow_absolute_workspaces,
        )
        if not workspace_path.is_dir():
            raise ValueError("Workspace path does not exist or is not a directory.")
        change_details = read_commit_message_diff(workspace_path)
        registry = build_default_tool_registry()
        provider = build_model_provider(
            request.model_name,
            registry,
            gemini_api_key=request.api_key or settings.gemini_api_key,
            sarvam_api_key=request.sarvam_api_key or settings.sarvam_api_key,
            max_output_tokens=settings.max_output_tokens,
        )
        context = Context()
        context.add_user(
            "Write exactly one concise Git commit subject for the changes below. "
            "Use imperative mood, return no quotes or Markdown, and keep it under 72 characters.\n\n"
            f"{change_details}"
        )
        response = await run_in_threadpool(provider.complete, context, final_response=True)
        lines = [line.strip() for line in response.output_text.splitlines() if line.strip()]
        if not lines:
            raise ValueError("The model did not generate a commit message.")
        message = lines[0].removeprefix("- ").strip("`\"'")
        if message.lower().startswith("commit message:"):
            message = message.split(":", 1)[1].strip()
        message = " ".join(message.split())[:72].rstrip()
        if not message:
            raise ValueError("The model did not generate a commit message.")
        return {"message": message}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail="The selected model could not generate a commit message.") from exc


@app.post("/git/switch")
async def git_switch(request: GitSwitchRequest) -> GitStatus:
    settings = get_settings()
    if not request.workspace_path.strip():
        raise HTTPException(status_code=400, detail="Workspace path is required.")
    try:
        workspace_path = resolve_workspace_path(
            settings.workspace_root,
            request.workspace_path.strip(),
            settings.allow_absolute_workspaces,
        )
        if not workspace_path.is_dir():
            raise ValueError("Workspace path does not exist or is not a directory.")
        return switch_git_branch(workspace_path, request.branch, force=request.force)
    except GitBranchSwitchError as exc:
        raise HTTPException(
            status_code=409,
            detail={"message": str(exc), "files": exc.files, "can_force": exc.can_force},
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/git/sync")
async def git_sync(request: GitStatusRequest) -> GitStatus:
    settings = get_settings()
    if not request.workspace_path.strip():
        raise HTTPException(status_code=400, detail="Workspace path is required.")
    try:
        workspace_path = resolve_workspace_path(
            settings.workspace_root,
            request.workspace_path.strip(),
            settings.allow_absolute_workspaces,
        )
        if not workspace_path.is_dir():
            raise ValueError("Workspace path does not exist or is not a directory.")
        return sync_git_branch(workspace_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/git/discard")
async def git_discard(request: GitIndexRequest) -> GitStatus:
    settings = get_settings()
    if not request.workspace_path.strip():
        raise HTTPException(status_code=400, detail="Workspace path is required.")
    try:
        workspace_path = resolve_workspace_path(
            settings.workspace_root,
            request.workspace_path.strip(),
            settings.allow_absolute_workspaces,
        )
        if not workspace_path.is_dir():
            raise ValueError("Workspace path does not exist or is not a directory.")
        return discard_git_changes(workspace_path, request.paths)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/threads/{thread_id}")
async def rename_thread(thread_id: str, request: ThreadRenameRequest) -> dict[str, object]:
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


@app.websocket("/ws/git/changes")
async def git_changes_websocket(websocket: WebSocket) -> None:
    settings = get_settings()
    authorization = websocket.headers.get("authorization", "")
    query_token = websocket.query_params.get("token", "")
    if settings.auth_token and not (
        secrets.compare_digest(authorization, f"Bearer {settings.auth_token}")
        or secrets.compare_digest(query_token, settings.auth_token)
    ):
        await websocket.close(code=1008, reason="Unauthorized")
        return
    workspace_path = websocket.query_params.get("workspace_path", "").strip()
    try:
        target = resolve_workspace_path(
            settings.workspace_root, workspace_path, settings.allow_absolute_workspaces,
        ) if workspace_path else None
    except ValueError:
        target = None
    if target is None or not target.is_dir():
        await websocket.close(code=1008, reason="Invalid workspace")
        return
    status = await run_in_threadpool(read_git_status, target)
    git_root = Path(status["root"]).resolve() if status["root"] else target

    await websocket.accept()
    stop = asyncio.Event()

    async def wait_for_disconnect() -> None:
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            stop.set()

    receiver = asyncio.create_task(wait_for_disconnect())
    try:
        async for changes in awatch(target, stop_event=stop, debounce=250):
            paths = sorted({
                str(Path(path).relative_to(git_root)).replace("\\", "/")
                for _, path in changes
                if Path(path).is_relative_to(git_root)
            })
            if paths:
                await websocket.send_json({"kind": "git.changed", "paths": paths})
    except WebSocketDisconnect:
        pass
    finally:
        stop.set()
        receiver.cancel()


if settings.web_dist_path and settings.web_dist_path.is_dir():
    app.mount("/", StaticFiles(directory=settings.web_dist_path, html=True), name="web")
