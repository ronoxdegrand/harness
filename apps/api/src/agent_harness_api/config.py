from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_MODEL = "gemini-3-flash"


class Settings(BaseSettings):
    app_name: str = "AI Agent Harness API"
    app_env: str = "development"
    app_version: str = "0.1.8"
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=0, le=65535)
    auth_token: str | None = None
    workspace_root: Path = Path(__file__).resolve().parents[4]
    sqlite_path: Path = Path(__file__).resolve().parents[2] / "data" / "app.db"
    web_dist_path: Path | None = None
    gemini_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("GEMINI_API_KEY", "HARNESS_GEMINI_API_KEY"),
    )
    model_config = SettingsConfigDict(
        env_prefix="HARNESS_",
        env_file=Path(__file__).resolve().parents[4] / ".env",
        extra="ignore",
    )

    @field_validator("sqlite_path")
    @classmethod
    def sqlite_path_must_be_absolute(cls, value: Path) -> Path:
        if not value.is_absolute():
            raise ValueError("HARNESS_SQLITE_PATH must be absolute.")
        return value

    @model_validator(mode="after")
    def production_must_use_loopback(self) -> "Settings":
        if self.app_env == "production" and self.host != "127.0.0.1":
            raise ValueError("Production must bind to 127.0.0.1.")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
