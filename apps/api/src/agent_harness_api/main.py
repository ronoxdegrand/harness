from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket

from .config import get_settings
from .db import database_status, initialize_database
from .ws import handle_run_websocket


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


@app.websocket("/ws/run")
async def run_websocket(websocket: WebSocket) -> None:
    await handle_run_websocket(websocket, get_settings())

