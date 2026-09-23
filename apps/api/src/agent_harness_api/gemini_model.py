from __future__ import annotations

from typing import Any
from uuid import uuid4

import httpx

from .context import Context
from .model import ModelProvider, ModelResponse, prepare_model_input, safe_model_marker, system_prompt, token_usage
from .model_request import post_model_request
from .tools import ToolCall


class GeminiModelProvider(ModelProvider):
    def __init__(
        self,
        *,
        api_key: str | None,
        model_name: str,
        tool_registry: Any,
        max_output_tokens: int = 4096,
    ) -> None:
        self.api_key = api_key
        self.model_name = model_name
        self.tool_registry = tool_registry
        self.max_output_tokens = max_output_tokens

        if not self.api_key:
            raise ValueError(
                "GEMINI_API_KEY is not set. Add it to your environment or .env file before running the app."
            )

    def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
        declarations = [] if final_response else [
            {
                "name": tool.name,
                "description": tool.description,
                "parameters": self._convert_schema(tool.input_schema),
            }
            for tool in self.tool_registry._tools.values()
        ]
        prepared = prepare_model_input(
            context, tools=declarations, output_tokens=self.max_output_tokens,
            final_response=final_response,
        )
        if prepared is None:
            return ModelResponse(output_text="")
        instruction, messages = prepared
        payload = self._build_payload(
            messages, instruction=instruction, final_response=final_response, tool_declarations=declarations,
        )
        response = post_model_request(
            "Gemini",
            f"https://generativelanguage.googleapis.com/v1beta/models/{self.model_name}:generateContent",
            headers={"x-goog-api-key": self.api_key},
            json=payload,
            timeout=60,
        )
        data = response.json()

        text = self._extract_text(data)
        tool_calls = self._extract_tool_calls(data)
        candidates = data.get("candidates") or []
        finish_reason = safe_model_marker(candidates[0].get("finishReason")) if candidates else None
        diagnostics = {
            "finish_reason": finish_reason,
            "response_id": safe_model_marker(data.get("responseId")),
            "usage": token_usage(data.get("usageMetadata"), {
                "input_tokens": "promptTokenCount", "output_tokens": "candidatesTokenCount",
                "total_tokens": "totalTokenCount",
            }),
        }

        if tool_calls:
            return ModelResponse(
                output_text=text,
                tool_calls=tool_calls,
                deltas=[text] if text else [],
                **diagnostics,
            )

        return ModelResponse(output_text=text, deltas=[text] if text else [], **diagnostics)

    def _build_payload(
        self, messages: list[Any], *, instruction: str | None = None, final_response: bool = False,
        tool_declarations: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        contents = [
            {
                "role": "model" if message.role == "assistant" else "user",
                "parts": [{"text": message.content}],
            }
            for message in messages
        ]

        payload = {
            "system_instruction": {
                "parts": [{"text": instruction or system_prompt(final_response)}]
            },
            "contents": contents,
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": self.max_output_tokens,
            },
        }
        if not final_response:
            payload["tools"] = [
                {
                    "functionDeclarations": tool_declarations if tool_declarations is not None else [
                        {"name": tool.name, "description": tool.description,
                         "parameters": self._convert_schema(tool.input_schema)}
                        for tool in self.tool_registry._tools.values()
                    ],
                }
            ]
        return payload

    def _convert_schema(self, schema: dict[str, Any]) -> dict[str, Any]:
        if schema.get("type") == "object":
            return {
                "type": "OBJECT",
                "properties": {
                    key: self._convert_schema(value)
                    for key, value in schema.get("properties", {}).items()
                },
                "required": schema.get("required", []),
            }

        if schema.get("type") == "string":
            return {"type": "STRING"}
        if schema.get("type") == "integer":
            return {"type": "INTEGER"}
        if schema.get("type") == "boolean":
            return {"type": "BOOLEAN"}
        if schema.get("type") == "array":
            return {
                "type": "ARRAY",
                "items": self._convert_schema(schema.get("items", {})),
            }

        return {"type": "OBJECT"}

    def _extract_text(self, data: dict[str, Any]) -> str:
        candidates = data.get("candidates") or []
        if not candidates:
            return ""

        text_parts: list[str] = []
        for candidate in candidates:
            content = candidate.get("content") or {}
            for part in content.get("parts") or []:
                if "text" in part:
                    text_parts.append(part["text"])
        return "\n".join(text_parts).strip()

    def _extract_tool_calls(self, data: dict[str, Any]) -> list[ToolCall]:
        candidates = data.get("candidates") or []
        tool_calls: list[ToolCall] = []

        for candidate in candidates:
            content = candidate.get("content") or {}
            for part in content.get("parts") or []:
                if "functionCall" not in part:
                    continue
                call = part["functionCall"]
                tool_name = str(call.get("name") or "")
                args = call.get("args") or {}
                if not tool_name:
                    continue
                tool_calls.append(
                    ToolCall(
                        id=str(call.get("id") or f"call-{uuid4().hex}"),
                        name=tool_name,
                        arguments=args,
                    )
                )

        return tool_calls
