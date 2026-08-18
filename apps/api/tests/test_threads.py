import sqlite3
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from agent_harness_api.config import get_settings
from agent_harness_api.db import initialize_database
from agent_harness_api.main import app
from agent_harness_api.store import RunStore


def _receive_run(websocket) -> tuple[str, dict[str, object]]:
    opened = websocket.receive_json()
    assert opened["kind"] == "thread.opened"
    thread_id = opened["payload"]["thread"]["id"]

    while True:
        message = websocket.receive_json()
        if message["kind"] == "run.completed":
            completed = message["payload"]
        if message["kind"] == "run.finished":
            return thread_id, completed


def test_existing_turns_table_adds_model_name(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "legacy.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE harness_turns (
                id INTEGER PRIMARY KEY, thread_id TEXT, run_id TEXT, role TEXT,
                content TEXT, created_at TEXT
            )
            """
        )
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()

    initialize_database()

    with sqlite3.connect(database_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(harness_turns)")}
    assert "model_name" in columns


def test_thread_api_persists_across_app_sessions(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "threads.db"
    monkeypatch.setenv("HARNESS_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()

    with TestClient(app) as client:
        invalid = client.post("/threads", json={"workspace_path": "../outside"})
        assert invalid.status_code == 400

        created = client.post("/threads", json={"workspace_path": ".", "title": "First thread"})
        assert created.status_code == 200
        thread = created.json()["thread"]
        assert thread["title"] == "First thread"
        assert thread["created_at"]
        assert thread["updated_at"]
        assert created.json()["turns"] == []
        assert created.json()["events"] == []

        renamed = client.patch(f"/threads/{thread['id']}", json={"title": "Renamed thread"})
        assert renamed.status_code == 200
        assert renamed.json()["title"] == "Renamed thread"
        thread = renamed.json()
        assert client.patch(f"/threads/{thread['id']}", json={"title": " "}).status_code == 400
        assert client.patch("/threads/does-not-exist", json={"title": "Missing"}).status_code == 404

        titled_from_prompt = client.post(
            "/threads",
            json={"workspace_path": ".", "prompt": "x" * 90},
        )
        assert titled_from_prompt.json()["thread"]["title"] == f"{'x' * 77}..."

        listed = client.get("/threads")
        assert {item["id"] for item in listed.json()["threads"]} == {
            thread["id"],
            titled_from_prompt.json()["thread"]["id"],
        }
        RunStore().append_turn(thread_id=thread["id"], role="user", content="Newest prompt")
        assert client.get("/threads").json()["threads"][0]["id"] == thread["id"]

    get_settings.cache_clear()
    with TestClient(app) as client:
        reopened = client.get(f"/threads/{thread['id']}")
        assert reopened.status_code == 200
        assert reopened.json()["thread"] == thread
        assert client.get("/threads/does-not-exist").status_code == 404


def test_websocket_continues_a_persisted_thread(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "threads.db"
    monkeypatch.setenv("HARNESS_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    get_settings.cache_clear()

    def fake_post(*args, **kwargs):
        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"candidates": [{"content": {"parts": [{"text": "Saved response."}]}}]}

        return FakeResponse()

    with patch("agent_harness_api.gemini_model.httpx.post", side_effect=fake_post):
        with TestClient(app) as client:
            with client.websocket_connect("/ws/run") as websocket:
                assert websocket.receive_json()["kind"] == "session.ready"
                websocket.send_json(
                    {
                        "task": "First message",
                        "workspace_path": ".",
                        "model_name": "gemini-3-flash",
                    }
                )
                thread_id, first_run = _receive_run(websocket)

            with client.websocket_connect("/ws/run") as websocket:
                assert websocket.receive_json()["kind"] == "session.ready"
                websocket.send_json(
                    {
                        "task": "Second message",
                        "workspace_path": ".",
                        "thread_id": thread_id,
                        "model_name": "gemini-3.5-flash-lite",
                    }
                )
                reopened_thread_id, second_run = _receive_run(websocket)

            thread = client.get(f"/threads/{thread_id}").json()

    assert reopened_thread_id == thread_id
    assert first_run["thread_id"] == thread_id
    assert second_run["thread_id"] == thread_id
    assert [(turn["role"], turn["content"], turn["model_name"]) for turn in thread["turns"]] == [
        ("user", "First message", "gemini-3-flash"),
        ("assistant", "Saved response.", None),
        ("user", "Second message", "gemini-3.5-flash-lite"),
        ("assistant", "Saved response.", None),
    ]
    assert thread["thread"]["title"] == "First message"
    assert thread["thread"]["model_name"] == "gemini-3.5-flash-lite"
    assert thread["events"]

    connection = sqlite3.connect(database_path)
    runs = connection.execute(
        "SELECT thread_id, model_name FROM harness_runs ORDER BY rowid"
    ).fetchall()
    turn_models = connection.execute(
        "SELECT role, model_name FROM harness_turns ORDER BY id"
    ).fetchall()
    connection.close()
    assert runs == [
        (thread_id, "gemini-3-flash"),
        (thread_id, "gemini-3.5-flash-lite"),
    ]
    assert turn_models == [
        ("user", "gemini-3-flash"),
        ("assistant", None),
        ("user", "gemini-3.5-flash-lite"),
        ("assistant", None),
    ]
