import subprocess
from pathlib import Path

import pytest

from agent_harness_api.git_status import (
    GitBranchSwitchError,
    commit_git_changes,
    discard_git_changes,
    read_commit_message_diff,
    read_git_file_diff,
    read_git_status,
    sync_git_branch,
    switch_git_branch,
    update_git_index,
)


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
    assert status["upstream"] is None
    assert status["ahead"] == 0
    assert status["behind"] == 0
    assert status["branch"] in status["branches"]
    assert status["staged"] == [{"path": "staged.txt", "status": "M "}]
    assert status["modified"] == [{"path": "modified.txt", "status": " M"}]
    assert status["untracked"] == [{"path": "untracked.txt", "status": "??"}]


def test_git_file_diff_reads_staged_worktree_and_untracked_versions(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("original\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")

    tracked.write_text("staged version\n")
    _git(tmp_path, "add", "tracked.txt")
    tracked.write_text("working version\n")
    (tmp_path / "new.txt").write_text("new content\n")

    staged = read_git_file_diff(tmp_path, "tracked.txt", staged=True)
    working = read_git_file_diff(tmp_path, "tracked.txt", staged=False)
    untracked = read_git_file_diff(tmp_path, "new.txt", staged=False)

    assert "staged version" in staged["patch"]
    assert "working version" not in staged["patch"]
    assert "working version" in working["patch"]
    assert "new content" in untracked["patch"]
    assert staged["binary"] is False


def test_git_file_diff_rejects_files_outside_the_requested_change_group(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    (tmp_path / "new.txt").write_text("new\n")

    with pytest.raises(ValueError, match="selected Git change group"):
        read_git_file_diff(tmp_path, "new.txt", staged=True)


def test_git_file_diff_does_not_mistake_binary_marker_text_for_a_binary_file(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    source = tmp_path / "source.py"
    source.write_text('value = "Binary files " in patch or "GIT binary patch" in patch\n')

    diff = read_git_file_diff(tmp_path, "source.py", staged=False)

    assert diff["binary"] is False
    assert "Binary files" in diff["patch"]


def test_git_file_diff_detects_an_actual_binary_file(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    binary = tmp_path / "image.bin"
    binary.write_bytes(b"\x00old content")

    diff = read_git_file_diff(tmp_path, "image.bin", staged=False)

    assert diff["binary"] is True


def test_git_status_reports_a_non_repository(tmp_path: Path) -> None:
    assert read_git_status(tmp_path) == {
        "is_repository": False,
        "root": None,
        "branch": None,
        "upstream": None,
        "ahead": 0,
        "behind": 0,
        "branches": [],
        "staged": [],
        "modified": [],
        "untracked": [],
        "local_commits": [],
        "local_commits_truncated": False,
        "base_commit": None,
        "error": None,
        "fetch_error": None,
    }


def test_git_status_reports_commits_to_push_and_pull(tmp_path: Path) -> None:
    remote = tmp_path / "remote.git"
    repository = tmp_path / "repository"
    other = tmp_path / "other"
    remote.mkdir()
    repository.mkdir()
    _git(remote, "init", "--bare")
    _git(repository, "init")
    _git(repository, "config", "user.name", "Test")
    _git(repository, "config", "user.email", "test@example.com")
    (repository / "shared.txt").write_text("initial\n")
    _git(repository, "add", ".")
    _git(repository, "commit", "-m", "initial")
    _git(repository, "remote", "add", "origin", str(remote))
    _git(repository, "push", "--set-upstream", "origin", "HEAD")

    subprocess.run(["git", "clone", str(remote), str(other)], check=True, capture_output=True)
    _git(other, "config", "user.name", "Test")
    _git(other, "config", "user.email", "test@example.com")
    (other / "remote.txt").write_text("remote\n")
    _git(other, "add", ".")
    _git(other, "commit", "-m", "remote")
    _git(other, "push")

    (repository / "local.txt").write_text("local\n")
    _git(repository, "add", ".")
    _git(repository, "commit", "-m", "local")
    _git(repository, "fetch")

    status = read_git_status(repository)

    assert status["upstream"].startswith("origin/")
    assert status["ahead"] == 1
    assert status["behind"] == 1
    assert [commit["subject"] for commit in status["local_commits"]] == ["local"]
    assert status["base_commit"]["subject"] == "initial"

    synchronized = sync_git_branch(repository)
    assert synchronized["ahead"] == 0
    assert synchronized["behind"] == 0
    assert synchronized["local_commits"] == []


def test_git_status_infers_local_commits_from_other_branches_without_upstream(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    (tmp_path / "shared.txt").write_text("initial\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "shared base")
    _git(tmp_path, "switch", "-c", "feature")
    (tmp_path / "first.txt").write_text("first\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "first local")
    (tmp_path / "second.txt").write_text("second\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "second local")

    status = read_git_status(tmp_path)

    assert status["upstream"] is None
    assert [commit["subject"] for commit in status["local_commits"]] == [
        "second local",
        "first local",
    ]
    assert status["base_commit"]["subject"] == "shared base"


def test_git_status_still_returns_local_changes_when_remote_fetch_fails(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("initial\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")
    _git(tmp_path, "remote", "add", "origin", str(tmp_path / "missing-remote.git"))
    tracked.write_text("local change\n")

    status = read_git_status(tmp_path, fetch_remote=True)

    assert status["is_repository"] is True
    assert status["modified"] == [{"path": "tracked.txt", "status": " M"}]
    assert status["fetch_error"]


def test_git_can_switch_between_local_branches(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    (tmp_path / "tracked.txt").write_text("initial\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")
    original_branch = read_git_status(tmp_path)["branch"]
    _git(tmp_path, "branch", "alternate")

    status = switch_git_branch(tmp_path, "alternate")

    assert status["branch"] == "alternate"
    assert set(status["branches"]) == {original_branch, "alternate"}


def test_git_branch_switch_explains_when_local_changes_would_be_overwritten(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("initial\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")
    original_branch = read_git_status(tmp_path)["branch"]
    _git(tmp_path, "switch", "-c", "alternate")
    tracked.write_text("alternate\n")
    _git(tmp_path, "commit", "-am", "alternate")
    _git(tmp_path, "switch", original_branch)
    tracked.write_text("local change\n")

    with pytest.raises(GitBranchSwitchError, match="Local changes would be overwritten") as caught:
        switch_git_branch(tmp_path, "alternate")

    assert caught.value.files == ["tracked.txt"]
    assert caught.value.can_force is True

    status = switch_git_branch(tmp_path, "alternate", force=True)
    assert status["branch"] == "alternate"
    assert tracked.read_text() == "alternate\n"


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


def test_commit_message_diff_falls_back_to_unstaged_and_untracked_changes(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("original\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")
    tracked.write_text("modified content\n")
    (tmp_path / "new.txt").write_text("new content\n")

    details = read_commit_message_diff(tmp_path)

    assert "modified content" in details
    assert "new.txt" in details
    assert "new content" in details


def test_git_can_commit_staged_changes(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.com")
    (tmp_path / "tracked.txt").write_text("initial\n")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")
    (tmp_path / "tracked.txt").write_text("changed\n")
    _git(tmp_path, "add", ".")

    status = commit_git_changes(tmp_path, "  update   tracked file  ")

    assert status["staged"] == []
    assert status["modified"] == []
    assert status["local_commits"][0]["subject"] == "update tracked file"


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
