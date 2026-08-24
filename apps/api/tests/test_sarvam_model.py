from unittest.mock import patch

from agent_harness_api.context import Context
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
