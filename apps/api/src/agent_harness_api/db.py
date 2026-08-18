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
            CREATE TABLE IF NOT EXISTS harness_threads (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                model_name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS harness_turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id TEXT NOT NULL,
                run_id TEXT,
                role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (thread_id) REFERENCES harness_threads (id),
                FOREIGN KEY (run_id) REFERENCES harness_runs (id)
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS harness_turns_thread_role_id
            ON harness_turns (thread_id, role, id)
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS harness_runs (
                id TEXT PRIMARY KEY,
                thread_id TEXT,
                status TEXT NOT NULL,
                target_path TEXT NOT NULL,
                max_iterations INTEGER NOT NULL,
                timeout_seconds INTEGER NOT NULL,
                final_output TEXT,
                error TEXT,
                model_name TEXT,
                finalized_by_iteration_limit INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (thread_id) REFERENCES harness_threads (id)
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
        columns = connection.execute("PRAGMA table_info(harness_runs)").fetchall()
        column_names = {row[1] for row in columns}
        if "model_name" not in column_names:
            connection.execute("ALTER TABLE harness_runs ADD COLUMN model_name TEXT")
        if "thread_id" not in column_names:
            connection.execute("ALTER TABLE harness_runs ADD COLUMN thread_id TEXT")
        if "finalized_by_iteration_limit" not in column_names:
            connection.execute(
                "ALTER TABLE harness_runs ADD COLUMN finalized_by_iteration_limit INTEGER NOT NULL DEFAULT 0"
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
