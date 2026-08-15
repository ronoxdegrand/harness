from __future__ import annotations

import json
from typing import Any

import httpx

from .context import Context
from .model import ModelProvider, ModelResponse
from .tools import ToolCall, ToolResult


class GeminiModelProvider(ModelProvider):
    def __init__(
        self,
        *,
        api_key: str | None,
        model_name: str,
        tool_registry: Any,
    ) -> None:
        self.api_key = api_key
        self.model_name = model_name
        self.tool_registry = tool_registry

        if not self.api_key:
            raise ValueError(
                "GEMINI_API_KEY is not set. Add it to your environment or .env file before running the app."
            )

    def complete(self, context: Context) -> ModelResponse:
        prompt = next(
            (message.content for message in context.messages if message.role == "user"),
            "",
        )
        if not prompt:
            return ModelResponse(output_text="")

        payload = self._build_payload(prompt, context.messages)
        response = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{self.model_name}:generateContent",
            params={"key": self.api_key},
            json=payload,
            timeout=60,
        )
        response.raise_for_status()
        data = response.json()

        text = self._extract_text(data)
        tool_calls = self._extract_tool_calls(data)

        if tool_calls:
            return ModelResponse(
                output_text=text,
                tool_calls=tool_calls,
                deltas=[text] if text else [],
            )

        return ModelResponse(output_text=text, deltas=[text] if text else [])

    def _build_payload(self, prompt: str, messages: list[Any]) -> dict[str, Any]:
        contents: list[dict[str, Any]] = []
        for message in messages:
            role = message.role
            if role == "user":
                contents.append({"role": "user", "parts": [{"text": message.content}]})
            elif role == "assistant":
                contents.append({"role": "model", "parts": [{"text": message.content}]})
            elif role == "tool":
                tool_result = ToolResult(**json.loads(message.content))
                contents.append(
                    {
                        "role": "user",
                        "parts": [
                            {
                                "text": (
                                    f"Tool result for {message.name}: "
                                    f"{json.dumps(tool_result.as_dict(), default=str)}"
                                )
                            }
                        ],
                    }
                )

        contents.append({"role": "user", "parts": [{"text": prompt}]})
        return {
            "system_instruction": {
                "parts": [
                    {
                        "text": (
                            "You are an autonomous coding agent. Use the available tools to inspect the repository, "
                            "execute tests, and answer the user's task. "
                            "When the task requires repo inspection or command execution, call a tool directly instead of "
                            "describing the action. Prefer structured function calls for file reads, searches, and shell commands. "
                            "Only respond with plain text when no tool call is needed or after tool results have been collected."
                        )
                    }
                ]
            },
            "tools": [
                {
                    "functionDeclarations": [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": self._convert_schema(tool.input_schema),
                        }
                        for tool in self.tool_registry._tools.values()
                    ]
                }
            ],
            "contents": contents,
            "generationConfig": {
                "temperature": 0.2,
            },
        }

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
                        id=f"call-{len(tool_calls) + 1}", name=tool_name, arguments=args
                    )
                )

        return tool_calls
