from fastapi.testclient import TestClient

from agent_harness_api.main import app


def test_health_endpoint() -> None:
    client = TestClient(app)
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_database_health_endpoint() -> None:
    client = TestClient(app)
    response = client.get("/health/db")

    assert response.status_code == 200
    assert response.json()["engine"] == "sqlite"

