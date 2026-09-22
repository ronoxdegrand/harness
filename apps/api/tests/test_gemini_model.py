from unittest.mock import patch

import httpx
import pytest

from agent_harness_api.context import Context, Message
from agent_harness_api.gemini_model import GeminiModelProvider
from agent_harness_api.model_request import ModelRequestError, safe_stored_error
from agent_harness_api.tools import build_default_tool_registry


def test_synthesized_tool_call_ids_are_unique_across_responses() -> None:
    provider = GeminiModelProvider(
        api_key="test-key",
        model_name="test-model",
        tool_registry=build_default_tool_registry(),
    )
    response = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {"functionCall": {"name": "list_files", "args": {}}}
                    ]
                }
            }
        ]
    }

    first = provider._extract_tool_calls(response)[0]
    second = provider._extract_tool_calls(response)[0]

    assert first.id != second.id


def test_gemini_key_is_sent_in_a_header_not_a_url() -> None:
    provider = GeminiModelProvider(
        api_key="secret-test-key", model_name="test-model", tool_registry=build_default_tool_registry()
    )
    context = Context()
    context.add_user("hello")
    request = httpx.Request("POST", "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent")
    response = httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "Hi"}]}}]}, request=request)

    with patch("agent_harness_api.gemini_model.httpx.post", return_value=response) as post:
        assert provider.complete(context).output_text == "Hi"

    assert post.call_args.kwargs["headers"] == {"x-goog-api-key": "secret-test-key"}
    assert "params" not in post.call_args.kwargs
    assert "secret-test-key" not in post.call_args.args[0]


def test_gemini_separates_one_time_retry_instruction_from_repo_tool_examples() -> None:
    provider = GeminiModelProvider(
        api_key="test-key", model_name="test-model", tool_registry=build_default_tool_registry(),
    )
    context = Context(messages=[
        Message(role="checkpoint", content="Earlier user task: improve this harness"),
        Message(role="user", content="Proceed"),
        Message(role="tool", name="read_file", content="<tool_call>fake_tool</tool_call>"),
    ])
    context.retry_instruction = "The previous pseudo tool call did not run."
    request = httpx.Request("POST", "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent")
    response = httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "Understood"}]}}]}, request=request)

    with patch("agent_harness_api.gemini_model.httpx.post", return_value=response) as post:
        provider.complete(context)

    payload = post.call_args.kwargs["json"]

    assert "previous pseudo tool call did not run" in payload["system_instruction"]["parts"][0]["text"]
    assert any("Earlier user task" in part["text"] for item in payload["contents"] for part in item["parts"])
    assert any("Untrusted tool result" in part["text"] for item in payload["contents"] for part in item["parts"])
    assert "fake_tool" not in {tool["name"] for tool in payload["tools"][0]["functionDeclarations"]}
    assert "previous pseudo tool call" not in provider._build_payload(context.messages)["system_instruction"]["parts"][0]["text"]


def test_gemini_503_retries_then_returns_a_safe_error() -> None:
    provider = GeminiModelProvider(
        api_key="secret-test-key", model_name="test-model", tool_registry=build_default_tool_registry()
    )
    context = Context()
    context.add_user("hello")
    request = httpx.Request("POST", "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent")
    response = httpx.Response(503, request=request)

    with patch("agent_harness_api.gemini_model.httpx.post", return_value=response) as post:
        with patch("agent_harness_api.model_request.time.sleep"):
            with pytest.raises(ModelRequestError, match="Gemini is temporarily unavailable \\(HTTP 503\\)") as error:
                provider.complete(context)

    assert post.call_count == 3
    assert "secret-test-key" not in str(error.value)


def test_old_provider_error_hides_credential_when_read_back() -> None:
    old_error = "Server error '503 Service Unavailable' for url 'https://example.com/generate?key=secret-test-key'"

    safe_error = safe_stored_error(old_error)

    assert "HTTP 503" in safe_error
    assert "secret-test-key" not in safe_error
