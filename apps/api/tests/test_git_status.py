import subprocess
from pathlib import Path

from agent_harness_api.git_status import discard_git_changes, read_git_status, update_git_index


def _git(path: Path, *arguments: str) -> None:
    subprocess.run(["git", *arguments], cwd=path, check=True, capture_output=True)


def test_git_status_groups_staged_modified_and_untracked_files(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    (tmp_path / "staged.txt").write_text("original\n")
    (tmp_path / "modified.txt").write_text("original\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")

    (tmp_path / "staged.txt").write_text("staged\n")
    _git(tmp_path, "add", "staged.txt")
    (tmp_path / "modified.txt").write_text("modified\n")
    (tmp_path / "untracked.txt").write_text("new\n")

    status = read_git_status(tmp_path)

    assert status["is_repository"] is True
    assert status["root"] == str(tmp_path)
    assert status["branch"]
    assert status["staged"] == [{"path": "staged.txt", "status": "M "}]
    assert status["modified"] == [{"path": "modified.txt", "status": " M"}]
    assert status["untracked"] == [{"path": "untracked.txt", "status": "??"}]


def test_git_status_reports_a_non_repository(tmp_path: Path) -> None:
    assert read_git_status(tmp_path) == {
        "is_repository": False,
        "root": None,
        "branch": None,
        "staged": [],
        "modified": [],
        "untracked": [],
        "error": None,
    }


def test_git_index_can_stage_and_unstage_individual_files_or_all(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    (tmp_path / "tracked.txt").write_text("original\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")
    (tmp_path / "tracked.txt").write_text("modified\n")
    (tmp_path / "new.txt").write_text("new\n")

    status = update_git_index(tmp_path, ["tracked.txt"], stage=True)
    assert [item["path"] for item in status["staged"]] == ["tracked.txt"]
    assert [item["path"] for item in status["untracked"]] == ["new.txt"]

    status = update_git_index(tmp_path, [], stage=True)
    assert {item["path"] for item in status["staged"]} == {"new.txt", "tracked.txt"}

    status = update_git_index(tmp_path, ["tracked.txt"], stage=False)
    assert [item["path"] for item in status["modified"]] == ["tracked.txt"]

    status = update_git_index(tmp_path, [], stage=False)
    assert status["staged"] == []


def test_git_index_can_unstage_files_before_the_first_commit(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    (tmp_path / "first.txt").write_text("first\n")

    assert update_git_index(tmp_path, [], stage=True)["staged"]
    status = update_git_index(tmp_path, [], stage=False)

    assert status["staged"] == []
    assert status["untracked"] == [{"path": "first.txt", "status": "??"}]


def test_discard_restores_tracked_deletions_and_removes_untracked_files(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    restored = tmp_path / "restored.txt"
    restored.write_text("original\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")
    restored.unlink()
    untracked = tmp_path / "untracked.txt"
    untracked.write_text("temporary\n")

    status = discard_git_changes(tmp_path, ["restored.txt"])
    assert restored.read_text() == "original\n"
    assert [item["path"] for item in status["untracked"]] == ["untracked.txt"]

    status = discard_git_changes(tmp_path, [])
    assert not untracked.exists()
    assert status["modified"] == []
    assert status["untracked"] == []
