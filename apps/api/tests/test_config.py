from pathlib import Path

import pytest
from pydantic import ValidationError

from agent_harness_api.config import Settings


def test_sqlite_path_must_be_absolute() -> None:
    with pytest.raises(ValidationError, match="must be absolute"):
        Settings(sqlite_path=Path("relative.db"), _env_file=None)


def test_production_must_bind_to_loopback(tmp_path: Path) -> None:
    with pytest.raises(ValidationError, match="127.0.0.1"):
        Settings(
            app_env="production",
            host="0.0.0.0",
            sqlite_path=tmp_path / "app.db",
            _env_file=None,
        )
