import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from .config import get_settings

LATEST_SCHEMA_VERSION = 3


class SchemaCompatibilityError(RuntimeError):
    pass


class MigrationError(RuntimeError):
    pass


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone() is not None


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}


def _migration_1(connection: sqlite3.Connection) -> None:
    for statement in (
        """CREATE TABLE IF NOT EXISTS harness_threads (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL,
            model_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""",
        """CREATE TABLE IF NOT EXISTS harness_runs (
            id TEXT PRIMARY KEY, thread_id TEXT, status TEXT NOT NULL, target_path TEXT NOT NULL,
            max_iterations INTEGER NOT NULL, timeout_seconds INTEGER NOT NULL, final_output TEXT,
            error TEXT, model_name TEXT, finalized_by_iteration_limit INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (thread_id) REFERENCES harness_threads (id)
        )""",
        """CREATE TABLE IF NOT EXISTS harness_turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, run_id TEXT,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL,
            model_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (thread_id) REFERENCES harness_threads (id),
            FOREIGN KEY (run_id) REFERENCES harness_runs (id)
        )""",
        """CREATE TABLE IF NOT EXISTS harness_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_type TEXT NOT NULL,
            payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (run_id) REFERENCES harness_runs (id)
        )""",
        """CREATE TABLE IF NOT EXISTS harness_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, iteration INTEGER NOT NULL,
            messages TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (run_id) REFERENCES harness_runs (id)
        )""",
    ):
        connection.execute(statement)


def _migration_2(connection: sqlite3.Connection) -> None:
    run_columns = _columns(connection, "harness_runs")
    if "model_name" not in run_columns:
        connection.execute("ALTER TABLE harness_runs ADD COLUMN model_name TEXT")
    if "thread_id" not in run_columns:
        connection.execute("ALTER TABLE harness_runs ADD COLUMN thread_id TEXT")
    if "finalized_by_iteration_limit" not in run_columns:
        connection.execute(
            "ALTER TABLE harness_runs ADD COLUMN finalized_by_iteration_limit INTEGER NOT NULL DEFAULT 0"
        )
    if "model_name" not in _columns(connection, "harness_turns"):
        connection.execute("ALTER TABLE harness_turns ADD COLUMN model_name TEXT")


def _migration_3(connection: sqlite3.Connection) -> None:
    connection.execute(
        "CREATE INDEX IF NOT EXISTS harness_turns_thread_role_id "
        "ON harness_turns (thread_id, role, id)"
    )


MIGRATIONS: tuple[tuple[int, str, Callable[[sqlite3.Connection], None]], ...] = (
    (1, "initial_schema", _migration_1),
    (2, "run_and_turn_metadata", _migration_2),
    (3, "turn_lookup_index", _migration_3),
)


def get_database_path() -> Path:
    return get_settings().sqlite_path


def _applied_migrations(connection: sqlite3.Connection) -> list[tuple[int, str]]:
    if not _table_exists(connection, "harness_schema_migrations"):
        return []
    rows = connection.execute(
        "SELECT version, name FROM harness_schema_migrations ORDER BY version"
    ).fetchall()
    versions = [row[0] for row in rows]
    if versions != list(range(1, len(rows) + 1)):
        raise SchemaCompatibilityError("Database migration history is not contiguous.")
    expected_names = {version: name for version, name, _ in MIGRATIONS}
    if any(expected_names.get(version) != name for version, name in rows):
        raise SchemaCompatibilityError("Database migration history does not match this app.")
    if versions and versions[-1] > LATEST_SCHEMA_VERSION:
        raise SchemaCompatibilityError(
            f"Database schema {versions[-1]} is newer than supported schema {LATEST_SCHEMA_VERSION}."
        )
    return rows


def _validate_schema(connection: sqlite3.Connection) -> None:
    required = {
        "harness_threads": {"id", "title", "workspace_path", "model_name"},
        "harness_runs": {"id", "thread_id", "model_name", "finalized_by_iteration_limit"},
        "harness_turns": {"id", "thread_id", "run_id", "role", "content", "model_name"},
        "harness_events": {"id", "run_id", "event_type", "payload"},
        "harness_snapshots": {"id", "run_id", "iteration", "messages"},
    }
    for table, columns in required.items():
        if not _table_exists(connection, table) or not columns.issubset(_columns(connection, table)):
            raise SchemaCompatibilityError(f"Database schema is missing required fields in {table}.")


def initialize_database() -> Path:
    db_path = get_database_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    existed = db_path.exists() and db_path.stat().st_size > 0
    backup_path: Path | None = None

    try:
        with sqlite3.connect(db_path, timeout=10) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise SchemaCompatibilityError("Database integrity check failed.")
            applied = _applied_migrations(connection)
            pending = MIGRATIONS[len(applied) :]
            if existed and pending:
                timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
                backup_path = db_path.with_name(f"{db_path.name}.backup-{timestamp}")
                with sqlite3.connect(backup_path) as backup:
                    connection.backup(backup)

            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS harness_schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            for version, name, migration in pending:
                migration(connection)
                connection.execute(
                    "INSERT INTO harness_schema_migrations (version, name) VALUES (?, ?)",
                    (version, name),
                )
            _validate_schema(connection)
            connection.commit()
    except SchemaCompatibilityError:
        raise
    except Exception as exc:
        backup = f" Backup: {backup_path}." if backup_path else ""
        raise MigrationError(f"Database migration failed; no changes were committed.{backup}") from exc

    return db_path


def database_status() -> dict[str, str | bool | int]:
    db_path = get_database_path()
    version = 0
    if db_path.exists():
        with sqlite3.connect(db_path) as connection:
            applied = _applied_migrations(connection)
            version = applied[-1][0] if applied else 0
    return {
        "engine": "sqlite",
        "path": str(db_path),
        "exists": db_path.exists(),
        "schema_version": version,
        "supported_schema_version": LATEST_SCHEMA_VERSION,
    }
