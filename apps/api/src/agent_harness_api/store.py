from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .db import get_database_path


def thread_title_from_prompt(prompt: str) -> str:
    title = " ".join(prompt.split())
    return title if len(title) <= 80 else f"{title[:77].rstrip()}..."


@dataclass
class Thread:
    id: str
    title: str
    workspace_path: str
    model_name: str
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


class RunStore:
    def __init__(self, database_path: Path | None = None) -> None:
        self.database_path = database_path or get_database_path()

    def create_run(
        self,
        *,
        run_id: str,
        target_path: Path,
        max_iterations: int,
        timeout_seconds: int,
        model_name: str | None = None,
        thread_id: str | None = None,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO harness_runs (
                    id,
                    thread_id,
                    status,
                    target_path,
                    max_iterations,
                    timeout_seconds,
                    model_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    thread_id,
                    "running",
                    str(target_path),
                    max_iterations,
                    timeout_seconds,
                    model_name,
                ),
            )
            connection.commit()

    def create_thread(
        self,
        *,
        workspace_path: Path,
        model_name: str,
        title: str,
    ) -> Thread:
        thread_id = str(uuid.uuid4())
        title = title.strip() or "Untitled thread"
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO harness_threads (id, title, workspace_path, model_name)
                VALUES (?, ?, ?, ?)
                """,
                (thread_id, title, str(workspace_path), model_name),
            )
            row = connection.execute(
                """
                SELECT id, title, workspace_path, model_name, created_at, updated_at
                FROM harness_threads WHERE id = ?
                """,
                (thread_id,),
            ).fetchone()
        return self._thread_from_row(row)

    def list_threads(self) -> list[Thread]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, title, workspace_path, model_name, created_at, updated_at
                FROM harness_threads
                ORDER BY COALESCE(
                    (
                        SELECT MAX(id) FROM harness_turns
                        WHERE thread_id = harness_threads.id AND role = 'user'
                    ),
                    0
                ) DESC, id DESC
                """
            ).fetchall()
        return [self._thread_from_row(row) for row in rows]

    def get_thread(self, thread_id: str) -> Thread | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, title, workspace_path, model_name, created_at, updated_at
                FROM harness_threads WHERE id = ?
                """,
                (thread_id,),
            ).fetchone()
        return self._thread_from_row(row) if row else None

    def rename_thread(self, thread_id: str, title: str) -> Thread | None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE harness_threads SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (title, thread_id),
            )
            row = connection.execute(
                """
                SELECT id, title, workspace_path, model_name, created_at, updated_at
                FROM harness_threads WHERE id = ?
                """,
                (thread_id,),
            ).fetchone()
            connection.commit()
        return self._thread_from_row(row) if row else None

    def delete_thread(self, thread_id: str) -> bool:
        with self._connect() as connection:
            run_ids = "SELECT id FROM harness_runs WHERE thread_id = ?"
            connection.execute(
                f"DELETE FROM harness_snapshots WHERE run_id IN ({run_ids})", (thread_id,)
            )
            connection.execute(
                f"DELETE FROM harness_events WHERE run_id IN ({run_ids})", (thread_id,)
            )
            connection.execute("DELETE FROM harness_turns WHERE thread_id = ?", (thread_id,))
            connection.execute("DELETE FROM harness_runs WHERE thread_id = ?", (thread_id,))
            deleted = connection.execute(
                "DELETE FROM harness_threads WHERE id = ?", (thread_id,)
            ).rowcount
            connection.commit()
        return bool(deleted)

    def append_turn(
        self,
        *,
        thread_id: str,
        role: str,
        content: str,
        run_id: str | None = None,
        model_name: str | None = None,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO harness_turns (thread_id, run_id, role, content, model_name)
                VALUES (?, ?, ?, ?, ?)
                """,
                (thread_id, run_id, role, content, model_name),
            )
            connection.execute(
                """
                UPDATE harness_threads
                SET updated_at = CURRENT_TIMESTAMP, model_name = COALESCE(?, model_name)
                WHERE id = ?
                """,
                (model_name, thread_id),
            )
            connection.commit()

    def list_turns(self, thread_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT harness_turns.id, harness_turns.run_id, harness_turns.role,
                       harness_turns.content, harness_turns.model_name, harness_turns.created_at,
                       COALESCE(harness_runs.finalized_by_iteration_limit, 0)
                FROM harness_turns
                LEFT JOIN harness_runs ON harness_runs.id = harness_turns.run_id
                WHERE harness_turns.thread_id = ? ORDER BY harness_turns.id
                """,
                (thread_id,),
            ).fetchall()
        return [
            {
                "id": row[0],
                "run_id": row[1],
                "role": row[2],
                "content": row[3],
                "model_name": row[4],
                "created_at": row[5],
                "finalized_by_iteration_limit": bool(row[6]),
            }
            for row in rows
        ]

    def list_thread_events(self, thread_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT harness_events.id, harness_events.run_id, harness_events.event_type,
                       harness_events.payload, harness_events.created_at
                FROM harness_events
                JOIN harness_runs ON harness_runs.id = harness_events.run_id
                WHERE harness_runs.thread_id = ?
                ORDER BY harness_events.id
                """,
                (thread_id,),
            ).fetchall()
        return [
            {
                "id": row[0],
                "run_id": row[1],
                "type": row[2],
                "payload": json.loads(row[3]),
                "created_at": row[4],
            }
            for row in rows
        ]

    def append_event(self, run_id: str, event_type: str, payload: dict[str, Any]) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO harness_events (run_id, event_type, payload)
                VALUES (?, ?, ?)
                """,
                (run_id, event_type, json.dumps(payload)),
            )
            connection.commit()

    def save_snapshot(
        self,
        run_id: str,
        iteration: int,
        messages: list[dict[str, Any]],
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO harness_snapshots (run_id, iteration, messages)
                VALUES (?, ?, ?)
                """,
                (run_id, iteration, json.dumps(messages)),
            )
            connection.commit()

    def complete_run(
        self, run_id: str, output_text: str, *, finalized_by_iteration_limit: bool
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE harness_runs
                SET status = ?, final_output = ?, finalized_by_iteration_limit = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                ("completed", output_text, finalized_by_iteration_limit, run_id),
            )
            connection.commit()

    def fail_run(self, run_id: str, error: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE harness_runs
                SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                ("failed", error, run_id),
            )
            connection.commit()

    def load_latest_snapshot(self, run_id: str) -> list[dict[str, Any]] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT messages
                FROM harness_snapshots
                WHERE run_id = ?
                ORDER BY iteration DESC, id DESC
                LIMIT 1
                """,
                (run_id,),
            ).fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def _connect(self) -> sqlite3.Connection:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        return sqlite3.connect(self.database_path)

    @staticmethod
    def _thread_from_row(row: tuple[str, str, str, str, str, str]) -> Thread:
        return Thread(
            id=row[0],
            title=row[1],
            workspace_path=row[2],
            model_name=row[3],
            created_at=row[4],
            updated_at=row[5],
        )
