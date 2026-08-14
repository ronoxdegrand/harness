import sqlite3
from pathlib import Path

from .config import get_settings


def get_database_path() -> Path:
    return get_settings().sqlite_path


def initialize_database() -> Path:
    db_path = get_database_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS harness_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.commit()

    return db_path


def database_status() -> dict[str, str | bool]:
    db_path = get_database_path()
    return {
        "engine": "sqlite",
        "path": str(db_path),
        "exists": db_path.exists(),
    }

