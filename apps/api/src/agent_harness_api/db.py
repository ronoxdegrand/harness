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
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                target_path TEXT NOT NULL,
                max_iterations INTEGER NOT NULL,
                timeout_seconds INTEGER NOT NULL,
                final_output TEXT,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS harness_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (run_id) REFERENCES harness_runs (id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS harness_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                iteration INTEGER NOT NULL,
                messages TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (run_id) REFERENCES harness_runs (id)
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
