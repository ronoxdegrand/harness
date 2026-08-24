from __future__ import annotations

import json
from typing import Any

import httpx

from .context import Context
from .model import ModelProvider, ModelResponse, system_prompt
from .tools import ToolCall


class SarvamModelProvider(ModelProvider):
    def __init__(self, *, api_key: str | None, model_name: str, tool_registry: Any) -> None:
        if not api_key:
            raise ValueError(
                "SARVAM_API_KEY is not set. Add it in Settings or to your environment before running the app."
            )
        self.api_key = api_key
        self.model_name = model_name
        self.tool_registry = tool_registry

    def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
        if not any(message.role == "user" for message in context.messages):
            return ModelResponse(output_text="")

        messages = [{"role": "system", "content": system_prompt(final_response)}]
        for message in context.messages:
            if message.role in {"user", "assistant"}:
                messages.append({"role": message.role, "content": message.content})
            elif message.role == "tool":
                messages.append(
                    {
                        "role": "user",
                        "content": f"Tool result for {message.name}: {message.content}",
                    }
                )

        payload: dict[str, Any] = {
            "model": self.model_name,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": 4096,
        }
        if not final_response:
            payload["tools"] = [
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
            payload["tool_choice"] = "auto"

        response = httpx.post(
            "https://api.sarvam.ai/v1/chat/completions",
            headers={"api-subscription-key": self.api_key},
            json=payload,
            timeout=120,
        )
        response.raise_for_status()
        choices = response.json().get("choices") or []
        if not choices:
            return ModelResponse()
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
        )
