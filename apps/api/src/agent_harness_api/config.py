from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_MODEL = "gemini-3-flash"


class Settings(BaseSettings):
    app_name: str = "AI Agent Harness API"
    app_env: str = "development"
    workspace_root: Path = Path(__file__).resolve().parents[4]
    sqlite_path: Path = Path(__file__).resolve().parents[2] / "data" / "app.db"
    gemini_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("GEMINI_API_KEY", "HARNESS_GEMINI_API_KEY"),
    )
    model_config = SettingsConfigDict(
        env_prefix="HARNESS_",
        env_file=Path(__file__).resolve().parents[4] / ".env",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
