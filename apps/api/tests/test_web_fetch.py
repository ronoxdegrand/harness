from pathlib import Path
from unittest.mock import patch

from agent_harness_api.tools import ToolCall, ToolExecutor, build_default_tool_registry
from agent_harness_api.web_fetch import fetch_public_page


def test_fetch_url_rejects_local_and_non_https_addresses(tmp_path: Path) -> None:
    executor = ToolExecutor(build_default_tool_registry())
    for url in ("http://docs.example.com", "https://localhost/help", "https://127.0.0.1/help"):
        result = executor.execute(
            ToolCall(id="fetch", name="fetch_url", arguments={"url": url}),
            target_path=tmp_path,
        )
        assert result.success is False


def test_fetch_url_returns_a_citable_source(tmp_path: Path) -> None:
    executor = ToolExecutor(build_default_tool_registry())
    with patch("agent_harness_api.tools.fetch_public_page", return_value=("https://docs.example.com/page", "Documentation", False)):
        result = executor.execute(
            ToolCall(id="fetch", name="fetch_url", arguments={"url": "https://docs.example.com/page"}),
            target_path=tmp_path,
        )
    assert result.success is True
    assert result.output == "Documentation"
    assert result.metadata["url"] == "https://docs.example.com/page"


def test_fetch_public_page_reads_text_without_markup() -> None:
    class FakeResponse:
        status_code = 200
        headers = {"content-type": "text/html"}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def iter_bytes(self):
            yield b"<html><style>hidden</style><p>Reasoning effort: low, high.</p></html>"

    with patch("agent_harness_api.web_fetch.socket.getaddrinfo", return_value=[(None, None, None, None, ("8.8.8.8", 443))]):
        with patch("agent_harness_api.web_fetch.httpx.stream", return_value=FakeResponse()):
            url, content, truncated = fetch_public_page("https://docs.example.com/page")

    assert url == "https://docs.example.com/page"
    assert content == "Reasoning effort: low, high."
    assert truncated is False


def test_fetch_public_page_can_find_text_beyond_the_preview() -> None:
    class FakeResponse:
        status_code = 200
        headers = {"content-type": "text/plain"}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def iter_bytes(self):
            yield ("introduction " * 1500 + "reasoning_effort: low or high").encode()

    with patch("agent_harness_api.web_fetch.socket.getaddrinfo", return_value=[(None, None, None, None, ("8.8.8.8", 443))]):
        with patch("agent_harness_api.web_fetch.httpx.stream", return_value=FakeResponse()):
            _, content, _ = fetch_public_page("https://docs.example.com/page", "reasoning_effort")

    assert "reasoning_effort: low or high" in content
    assert len(content) < 16_000
