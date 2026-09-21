from __future__ import annotations

from dataclasses import dataclass

from .model import ModelProvider
from .tools import ToolRegistry


@dataclass(frozen=True)
class ModelSpec:
    id: str
    provider: str
    selectable: bool = True


MODELS = (
    ModelSpec("gemini-3.5-flash", "gemini"),
    ModelSpec("gemini-3.5-flash-lite", "gemini"),
    ModelSpec("sarvam-105b", "sarvam"),
    ModelSpec("gemini-3-flash", "gemini", selectable=False),
)
def model_spec(model_name: str) -> ModelSpec:
    for spec in MODELS:
        if spec.id == model_name:
            return spec
    raise ValueError(f"Unsupported model: {model_name}")


def build_model_provider(
    model_name: str, registry: ToolRegistry, *, gemini_api_key: str | None, sarvam_api_key: str | None,
) -> ModelProvider:
    spec = model_spec(model_name)
    if spec.provider == "gemini":
        from .gemini_model import GeminiModelProvider

        return GeminiModelProvider(api_key=gemini_api_key, model_name=model_name, tool_registry=registry)

    from .sarvam_model import SarvamModelProvider

    return SarvamModelProvider(api_key=sarvam_api_key, model_name=model_name, tool_registry=registry)
