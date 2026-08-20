import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from agent_harness_api.config import get_settings
from agent_harness_api.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(tmp_path / "app.db"))
    get_settings.cache_clear()
    with TestClient(app) as client:
        yield client
    get_settings.cache_clear()


def test_health_endpoint(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "AI Agent Harness API",
        "environment": "development",
    }


def test_database_health_endpoint(client: TestClient) -> None:
    response = client.get("/health/db")

    assert response.status_code == 200
    assert response.json()["engine"] == "sqlite"
    assert response.json()["exists"] is True


def test_http_endpoints_reject_unsupported_routes_and_methods(client: TestClient) -> None:
    assert client.post("/health").status_code == 405
    assert client.get("/missing").status_code == 404


def test_auth_token_protects_http_endpoints(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(tmp_path / "auth.db"))
    monkeypatch.setenv("HARNESS_AUTH_TOKEN", "launch-secret")
    get_settings.cache_clear()
    with TestClient(app) as client:
        assert client.get("/health").status_code == 401
        response = client.get(
            "/health/ready", headers={"authorization": "Bearer launch-secret"}
        )
        assert response.status_code == 200
        assert response.json()["status"] == "ready"
    get_settings.cache_clear()


def test_auth_token_protects_websockets(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(tmp_path / "auth-ws.db"))
    monkeypatch.setenv("HARNESS_AUTH_TOKEN", "launch-secret")
    get_settings.cache_clear()
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as rejected:
            with client.websocket_connect("/ws/run"):
                pass
        assert rejected.value.code == 1008
        with client.websocket_connect(
            "/ws/run", headers={"authorization": "Bearer launch-secret"}
        ) as websocket:
            assert websocket.receive_json()["kind"] == "session.ready"
    get_settings.cache_clear()
