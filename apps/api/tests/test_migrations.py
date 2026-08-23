import sqlite3
from pathlib import Path

import pytest

import agent_harness_api.db as database
from agent_harness_api.config import get_settings


@pytest.fixture
def database_path(tmp_path: Path, monkeypatch) -> Path:
    path = tmp_path / "app.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(path))
    get_settings.cache_clear()
    yield path
    get_settings.cache_clear()


def test_migrations_are_ordered_and_versioned(database_path: Path) -> None:
    database.initialize_database()

    with sqlite3.connect(database_path) as connection:
        rows = connection.execute(
            "SELECT version, name FROM harness_schema_migrations ORDER BY version"
        ).fetchall()

    assert rows == [(version, name) for version, name, _ in database.MIGRATIONS]


def test_existing_database_is_backed_up_before_migration(database_path: Path) -> None:
    database.initialize_database()
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "DELETE FROM harness_schema_migrations WHERE version = ?",
            (database.LATEST_SCHEMA_VERSION,),
        )
        connection.commit()

    database.initialize_database()

    backups = list(database_path.parent.glob(f"{database_path.name}.backup-*"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as backup:
        assert backup.execute(
            "SELECT MAX(version) FROM harness_schema_migrations"
        ).fetchone()[0] == 3


def test_failed_migration_rolls_back_and_keeps_backup(
    database_path: Path, monkeypatch
) -> None:
    database.initialize_database()
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "DELETE FROM harness_schema_migrations WHERE version = ?",
            (database.LATEST_SCHEMA_VERSION,),
        )
        connection.commit()

    def fail(_connection: sqlite3.Connection) -> None:
        raise RuntimeError("broken migration")

    version, name, _ = database.MIGRATIONS[-1]
    monkeypatch.setattr(database, "MIGRATIONS", (*database.MIGRATIONS[:-1], (version, name, fail)))
    with pytest.raises(database.MigrationError, match="no changes were committed"):
        database.initialize_database()

    with sqlite3.connect(database_path) as connection:
        versions = [
            row[0]
            for row in connection.execute(
                "SELECT version FROM harness_schema_migrations ORDER BY version"
            )
        ]
    assert versions == [1, 2, 3]
    assert list(database_path.parent.glob(f"{database_path.name}.backup-*"))


def test_newer_schema_is_rejected(database_path: Path) -> None:
    database.initialize_database()
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "INSERT INTO harness_schema_migrations (version, name) VALUES (?, 'future')",
            (database.LATEST_SCHEMA_VERSION + 1,),
        )
        connection.commit()

    with pytest.raises(database.SchemaCompatibilityError):
        database.initialize_database()
