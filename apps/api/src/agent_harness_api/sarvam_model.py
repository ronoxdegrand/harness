from __future__ import annotations

import json
from typing import Any

import httpx

from .context import Context
from .model import ModelProvider, ModelResponse, prepare_model_input, safe_model_marker, token_usage
from .model_request import post_model_request
from .tools import ToolCall


class SarvamModelProvider(ModelProvider):
    def __init__(
        self, *, api_key: str | None, model_name: str, tool_registry: Any,
        max_output_tokens: int = 4096,
    ) -> None:
        if not api_key:
            raise ValueError(
                "SARVAM_API_KEY is not set. Add it in Settings or to your environment before running the app."
            )
        self.api_key = api_key
        self.model_name = model_name
        self.tool_registry = tool_registry
        self.max_output_tokens = max_output_tokens

    def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
        tool_definitions = [] if final_response else [
            {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool["description"],
                    "parameters": tool["input_schema"],
                },
            }
            for tool in self.tool_registry.definitions()
        ]
        prepared = prepare_model_input(
            context, tools=tool_definitions, output_tokens=self.max_output_tokens,
            final_response=final_response,
        )
        if prepared is None:
            return ModelResponse(output_text="")
        instruction, visible = prepared
        messages = [
            {"role": "system", "content": instruction},
            *({"role": message.role, "content": message.content} for message in visible),
        ]

        payload: dict[str, Any] = {
            "model": self.model_name,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": self.max_output_tokens,
        }
        if not final_response:
            payload["tools"] = tool_definitions
            payload["tool_choice"] = "auto"

        response = post_model_request(
            "Sarvam",
            "https://api.sarvam.ai/v1/chat/completions",
            headers={"api-subscription-key": self.api_key},
            json=payload,
            timeout=120,
        )
        data = response.json()
        choices = data.get("choices") or []
        diagnostics = {
            "response_id": safe_model_marker(data.get("id")),
            "usage": token_usage(data.get("usage"), {
                "input_tokens": "prompt_tokens", "output_tokens": "completion_tokens",
                "total_tokens": "total_tokens",
            }),
        }
        if not choices:
            return ModelResponse(**diagnostics)
        diagnostics["finish_reason"] = safe_model_marker(choices[0].get("finish_reason"))
        message = choices[0].get("message") or {}
        text = str(message.get("content") or "").strip()
        tool_calls = []
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            arguments = function.get("arguments") or {}
            if isinstance(arguments, str):
                arguments = json.loads(arguments)
            if not isinstance(arguments, dict):
                raise ValueError("Sarvam returned invalid tool arguments.")
            tool_calls.append(
                ToolCall(
                    id=str(call.get("id") or f"call-{len(tool_calls) + 1}"),
                    name=str(function.get("name") or ""),
                    arguments=arguments,
                )
            )
        return ModelResponse(
            output_text=text,
            tool_calls=tool_calls,
            deltas=[text] if text else [],
            **diagnostics,
        )
