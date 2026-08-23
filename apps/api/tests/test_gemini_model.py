from agent_harness_api.gemini_model import GeminiModelProvider
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
