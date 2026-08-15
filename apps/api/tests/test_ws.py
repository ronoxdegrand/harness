from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from agent_harness_api.config import get_settings
from agent_harness_api.main import app


def _create_repo(repo_path: Path) -> None:
    repo_path.mkdir(parents=True, exist_ok=True)
    (repo_path / "README.md").write_text("hello\n", encoding="utf-8")
    (repo_path / "tests").mkdir()
    (repo_path / "tests" / "test_ok.py").write_text(
        "def test_ok() -> None:\n    assert True\n",
        encoding="utf-8",
    )


def test_run_websocket_streams_runtime_events(tmp_path: Path, monkeypatch) -> None:
    workspace_root = tmp_path / "workspace"
    repo_path = workspace_root / "demo"
    _create_repo(repo_path)
    monkeypatch.setenv("HARNESS_WORKSPACE_ROOT", str(workspace_root))
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    get_settings.cache_clear()

    call_count = {"value": 0}

    def fake_post(*args, **kwargs):
        call_count["value"] += 1

        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                if call_count["value"] == 1:
                    return {
                        "candidates": [
                            {
                                "content": {
                                    "parts": [
                                        {
                                            "functionCall": {
                                                "name": "list_files",
                                                "args": {"path": ".", "limit": 200},
                                            }
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                return {
                    "candidates": [
                        {"content": {"parts": [{"text": "I inspected the repo and the tests pass."}]}}
                    ]
                }

        return FakeResponse()

    with patch("agent_harness_api.gemini_model.httpx.post", side_effect=fake_post):
        with TestClient(app) as client:
            with client.websocket_connect("/ws/run") as websocket:
                ready = websocket.receive_json()
                assert ready["kind"] == "session.ready"

                websocket.send_json(
                    {
                        "task": 'inspect the repo, search for "test_ok", run tests, and show git diff',
                        "workspace_path": "demo",
                    }
                )

                kinds: list[str] = []
                runtime_event_types: list[str] = []
                final_payload: dict[str, object] | None = None

                while True:
                    message = websocket.receive_json()
                    kinds.append(message["kind"])
                    if message["kind"] == "runtime.event":
                        runtime_event_types.append(message["event"]["type"])
                    if message["kind"] == "run.completed":
                        final_payload = message["payload"]
                    if message["kind"] == "run.finished":
                        break

    assert "runtime.event" in kinds
    assert "run.completed" in kinds
    assert "turn.started" in runtime_event_types
    assert "model.delta" in runtime_event_types
    assert "tool.started" in runtime_event_types
    assert "tool.completed" in runtime_event_types
    assert final_payload is not None
    assert final_payload["status"] == "completed"
