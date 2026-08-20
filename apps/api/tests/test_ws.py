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


def _receive_failure(websocket) -> dict[str, object]:
    failure = websocket.receive_json()
    assert failure["kind"] == "run.failed"
    return failure


def test_run_websocket_rejects_invalid_requests(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_WORKSPACE_ROOT", str(tmp_path))
    get_settings.cache_clear()

    invalid_requests = [
        ("not json", "Request must contain valid JSON."),
        ([], "Request must be a JSON object."),
        ({}, "Task is required to start a run."),
        ({"task": None}, "Task is required to start a run."),
        ({"task": "inspect", "workspace_path": 1}, "Workspace path must be a string."),
        ({"task": "inspect", "model_name": " "}, "Model name must be a non-empty string."),
        ({"task": "inspect", "api_key": " "}, "API key must be a non-empty string."),
        ({"task": "inspect", "max_iterations": 0}, "Max iterations must be an integer"),
        ({"task": "inspect", "max_iterations": 51}, "Max iterations must be an integer"),
        ({"task": "inspect", "max_iterations": "8"}, "Max iterations must be an integer"),
        ({"task": "inspect", "workspace_path": "../outside"}, "Workspace path escapes"),
        ({"task": "inspect", "workspace_path": "missing"}, "Workspace path does not exist"),
    ]

    with TestClient(app) as client:
        for request, expected_error in invalid_requests:
            with client.websocket_connect("/ws/run") as websocket:
                assert websocket.receive_json()["kind"] == "session.ready"
                if isinstance(request, str):
                    websocket.send_text(request)
                else:
                    websocket.send_json(request)
                failure = _receive_failure(websocket)
                assert expected_error in str(failure["error"])


def test_run_websocket_reports_missing_gemini_key(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_WORKSPACE_ROOT", str(tmp_path))
    get_settings.cache_clear()

    with patch(
        "agent_harness_api.ws.build_runtime",
        side_effect=ValueError("GEMINI_API_KEY is not set."),
    ):
        with TestClient(app) as client:
            with client.websocket_connect("/ws/run") as websocket:
                assert websocket.receive_json()["kind"] == "session.ready"
                websocket.send_json({"task": "inspect", "workspace_path": "."})
                failure = _receive_failure(websocket)

    assert "GEMINI_API_KEY is not set" in str(failure["error"])


def test_run_websocket_streams_runtime_events(tmp_path: Path, monkeypatch) -> None:
    workspace_root = tmp_path / "workspace"
    repo_path = workspace_root / "demo"
    _create_repo(repo_path)
    monkeypatch.setenv("HARNESS_WORKSPACE_ROOT", str(workspace_root))
    get_settings.cache_clear()

    call_count = {"value": 0}

    def fake_post(*args, **kwargs):
        call_count["value"] += 1
        assert kwargs["params"]["key"] == "ui-key"

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
                        "api_key": "ui-key",
                        "max_iterations": 4,
                    }
                )

                kinds: list[str] = []
                runtime_event_types: list[str] = []
                model_completed_payloads: list[dict[str, object]] = []
                final_payload: dict[str, object] | None = None

                while True:
                    message = websocket.receive_json()
                    kinds.append(message["kind"])
                    if message["kind"] == "runtime.event":
                        runtime_event_types.append(message["event"]["type"])
                        if message["event"]["type"] == "model.completed":
                            model_completed_payloads.append(message["event"]["payload"])
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
    assert model_completed_payloads
    assert "output_text" not in model_completed_payloads[0]
    assert final_payload is not None
    assert final_payload["status"] == "completed"
    assert final_payload["finalized_by_iteration_limit"] is False
