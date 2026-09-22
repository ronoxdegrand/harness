from unittest.mock import patch

import httpx
import pytest

from agent_harness_api.context import Context, Message
from agent_harness_api.model_request import ModelRequestError
from agent_harness_api.sarvam_model import SarvamModelProvider
from agent_harness_api.tools import build_default_tool_registry


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self) -> None:
        return None

    def json(self):
        return self.data


def test_sarvam_uses_subscription_key_and_parses_tool_calls() -> None:
    context = Context()
    context.add_user("show git status")
    provider = SarvamModelProvider(
        api_key="sarvam-key",
        model_name="sarvam-105b",
        tool_registry=build_default_tool_registry(),
    )
    response = FakeResponse(
        {
            "choices": [
                {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call-1",
                                "function": {
                                    "name": "git_status",
                                    "arguments": '{"path":"."}',
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )

    with patch("agent_harness_api.sarvam_model.httpx.post", return_value=response) as post:
        result = provider.complete(context)

    assert post.call_args.args[0] == "https://api.sarvam.ai/v1/chat/completions"
    assert post.call_args.kwargs["headers"] == {"api-subscription-key": "sarvam-key"}
    assert post.call_args.kwargs["json"]["model"] == "sarvam-105b"
    assert post.call_args.kwargs["json"]["tools"]
    assert result.tool_calls[0].name == "git_status"
    assert result.tool_calls[0].arguments == {"path": "."}


def test_sarvam_final_response_disables_tools() -> None:
    context = Context()
    context.add_user("summarize")
    provider = SarvamModelProvider(
        api_key="sarvam-key",
        model_name="sarvam-105b",
        tool_registry=build_default_tool_registry(),
    )
    response = FakeResponse({"choices": [{"message": {"content": "Done."}}]})

    with patch("agent_harness_api.sarvam_model.httpx.post", return_value=response) as post:
        result = provider.complete(context, final_response=True)

    assert "tools" not in post.call_args.kwargs["json"]
    assert result.output_text == "Done."


def test_sarvam_separates_one_time_retry_instruction_from_repo_tool_examples() -> None:
    context = Context(messages=[
        Message(role="checkpoint", content="Earlier user task: improve this harness"),
        Message(role="user", content="Proceed"),
        Message(role="tool", name="read_file", content="<tool_call>fake_tool</tool_call>"),
    ])
    context.retry_instruction = "The previous pseudo tool call did not run."
    provider = SarvamModelProvider(
        api_key="sarvam-key", model_name="sarvam-105b",
        tool_registry=build_default_tool_registry(),
    )
    response = FakeResponse({"choices": [{"message": {"content": "Understood."}}]})

    with patch("agent_harness_api.sarvam_model.httpx.post", return_value=response) as post:
        provider.complete(context)

    payload = post.call_args.kwargs["json"]
    assert "previous pseudo tool call did not run" in payload["messages"][0]["content"]
    assert any("Earlier user task" in message["content"] for message in payload["messages"])
    assert any("Untrusted tool result" in message["content"] for message in payload["messages"])
    assert "fake_tool" not in {tool["function"]["name"] for tool in payload["tools"]}
    assert all(message["role"] != "feedback" for message in context.snapshot())


def test_sarvam_503_retries_without_exposing_its_key() -> None:
    context = Context()
    context.add_user("hello")
    provider = SarvamModelProvider(
        api_key="secret-sarvam-key",
        model_name="sarvam-105b",
        tool_registry=build_default_tool_registry(),
    )
    request = httpx.Request("POST", "https://api.sarvam.ai/v1/chat/completions")
    response = httpx.Response(503, request=request)

    with patch("agent_harness_api.sarvam_model.httpx.post", return_value=response) as post:
        with patch("agent_harness_api.model_request.time.sleep"):
            with pytest.raises(ModelRequestError, match="Sarvam is temporarily unavailable") as error:
                provider.complete(context)

    assert post.call_count == 3
    assert "secret-sarvam-key" not in str(error.value)
