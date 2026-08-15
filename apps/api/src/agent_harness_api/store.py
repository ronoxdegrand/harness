from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from .db import get_database_path


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
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO harness_runs (
                    id,
                    status,
                    target_path,
                    max_iterations,
                    timeout_seconds,
                    model_name
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    "running",
                    str(target_path),
                    max_iterations,
                    timeout_seconds,
                    model_name,
                ),
            )
            connection.commit()

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

    def complete_run(self, run_id: str, output_text: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE harness_runs
                SET status = ?, final_output = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                ("completed", output_text, run_id),
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
