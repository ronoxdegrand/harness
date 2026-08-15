from agent_harness_api.config import get_settings


def test_settings_reads_gemini_api_key_from_env(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    get_settings.cache_clear()

    settings = get_settings()

    assert settings.gemini_api_key == "test-key"
