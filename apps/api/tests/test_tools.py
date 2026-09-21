import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from agent_harness_api.tools import ToolCall, ToolExecutor, build_default_tool_registry


def _create_repo(repo_path: Path) -> None:
    repo_path.mkdir(parents=True, exist_ok=True)
    (repo_path / "src").mkdir()
    (repo_path / "src" / "math_utils.py").write_text(
        "def subtract(a: int, b: int) -> int:\n    return a + b\n",
        encoding="utf-8",
    )
    (repo_path / "tests").mkdir()
    (repo_path / "tests" / "test_math_utils.py").write_text(
        "from src.math_utils import subtract\n\n\ndef test_subtract() -> None:\n    assert subtract(5, 2) == 3\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "init"], cwd=repo_path, check=True, capture_output=True)
    subprocess.run(["git", "add", "."], cwd=repo_path, check=True, capture_output=True)
    subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
        cwd=repo_path,
        check=True,
        capture_output=True,
    )


def test_tool_registry_exposes_metadata_and_schemas() -> None:
    registry = build_default_tool_registry()

    tool_names = registry.list()
    definitions = registry.definitions()

    assert "read_file" in tool_names
    assert "write_file" in tool_names
    assert "git_status" in tool_names
    assert "git_log" in tool_names
    assert "fetch_url" in tool_names
    assert {"git_refresh", "git_switch", "git_sync", "git_commit", "git_stage", "git_unstage", "git_discard"} <= set(tool_names)
    assert any(tool["name"] == "shell" for tool in definitions)
    assert registry.get("write_file").input_schema["required"] == ["path", "content"]
    assert registry.get("git_diff").input_schema["properties"]["staged"]["type"] == "boolean"


def test_filesystem_tools_respect_workspace_root(tmp_path: Path) -> None:
    executor = ToolExecutor(build_default_tool_registry())
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".env").write_text("SECRET=value", encoding="utf-8")
    (workspace / ".cache").mkdir()
    (workspace / ".cache" / "state.json").write_text("{}", encoding="utf-8")

    write_result = executor.execute(
        ToolCall(
            id="write",
            name="write_file",
            arguments={"path": "notes/todo.txt", "content": "keep within root"},
        ),
        target_path=workspace,
    )
    read_result = executor.execute(
        ToolCall(id="read", name="read_file", arguments={"path": "notes/todo.txt"}),
        target_path=workspace,
    )
    list_result = executor.execute(
        ToolCall(id="list", name="list_files", arguments={"path": ".", "limit": 10}),
        target_path=workspace,
    )
    hidden_list_result = executor.execute(
        ToolCall(
            id="list-hidden",
            name="list_files",
            arguments={"path": ".", "limit": 10, "include_hidden": True},
        ),
        target_path=workspace,
    )
    escape_result = executor.execute(
        ToolCall(
            id="escape",
            name="write_file",
            arguments={"path": "../outside.txt", "content": "nope"},
        ),
        target_path=workspace,
    )

    assert write_result.success is True
    assert read_result.output == "keep within root"
    assert "notes/todo.txt" in list_result.output
    assert ".env" not in list_result.output
    assert ".cache/state.json" not in list_result.output
    assert ".env" in hidden_list_result.output
    assert ".cache/state.json" in hidden_list_result.output
    assert escape_result.success is False
    assert "escapes the workspace root" in (escape_result.error or "")


def test_read_file_pages_by_line_and_character_offset(tmp_path: Path) -> None:
    content = "".join(f"line {number}\n" for number in range(250))
    (tmp_path / "large.txt").write_text(content, encoding="utf-8")
    executor = ToolExecutor(build_default_tool_registry())

    first = executor.execute(ToolCall(id="read-1", name="read_file", arguments={"path": "large.txt"}), target_path=tmp_path)
    second = executor.execute(
        ToolCall(id="read-2", name="read_file", arguments={"path": "large.txt", "offset": first.metadata["next_offset"]}),
        target_path=tmp_path,
    )

    assert first.output.count("\n") == 200
    assert first.metadata["truncated"] is True
    assert second.metadata["truncated"] is False
    assert first.output + second.output == content

    (tmp_path / "single-line.txt").write_text("x" * 20_000, encoding="utf-8")
    first_line = executor.execute(
        ToolCall(id="long-1", name="read_file", arguments={"path": "single-line.txt"}), target_path=tmp_path,
    )
    second_line = executor.execute(
        ToolCall(id="long-2", name="read_file", arguments={"path": "single-line.txt", "offset": first_line.metadata["next_offset"]}),
        target_path=tmp_path,
    )
    assert first_line.output + second_line.output == "x" * 20_000


def test_shell_output_is_bounded_and_git_diff_can_be_paged(tmp_path: Path) -> None:
    executor = ToolExecutor(build_default_tool_registry())
    output = "x" * 20_000
    completed = subprocess.CompletedProcess(args=["command"], returncode=0, stdout=output, stderr="")

    with patch("agent_harness_api.tools._run_command", return_value=completed):
        shell_result = executor.execute(
            ToolCall(id="shell", name="shell", arguments={"command": "command"}), target_path=tmp_path,
        )
        first_diff = executor.execute(ToolCall(id="diff-1", name="git_diff"), target_path=tmp_path)
        second_diff = executor.execute(
            ToolCall(id="diff-2", name="git_diff", arguments={"offset": first_diff.metadata["next_offset"]}),
            target_path=tmp_path,
        )

    assert len(shell_result.output) == 16_000
    assert shell_result.metadata["truncated"] is True
    assert "next_offset" not in shell_result.metadata
    assert first_diff.output + second_diff.output == output
    assert second_diff.metadata["truncated"] is False


def test_list_files_skips_generated_files_and_backups(tmp_path: Path) -> None:
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    (tmp_path / ".gitignore").write_text(
        "node_modules/\ndist/\nbuild/\nrelease/\n__pycache__/\nvenv/\nbackups/\n*.db*\n*.pyc\n",
        encoding="utf-8",
    )
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("pass", encoding="utf-8")
    for directory in ("node_modules", "dist", "build", "release", "__pycache__", "venv", "backups"):
        (tmp_path / directory).mkdir()
        (tmp_path / directory / "generated.txt").write_text("generated", encoding="utf-8")
    (tmp_path / "app.db.backup-20260921").write_text("backup", encoding="utf-8")
    (tmp_path / "app.db").write_text("database", encoding="utf-8")
    (tmp_path / "app.pyc").write_text("cache", encoding="utf-8")

    result = ToolExecutor(build_default_tool_registry()).execute(
        ToolCall(id="list", name="list_files"), target_path=tmp_path,
    )

    assert result.output == "src/app.py"
    assert result.metadata["count"] == 1

    included = ToolExecutor(build_default_tool_registry()).execute(
        ToolCall(id="all", name="list_files", arguments={"include_ignored": True}),
        target_path=tmp_path,
    )
    assert "node_modules/generated.txt" in included.output


def test_list_files_keeps_tracked_source_in_an_ignored_directory(tmp_path: Path) -> None:
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    (tmp_path / ".gitignore").write_text("build/\n", encoding="utf-8")
    (tmp_path / "build").mkdir()
    (tmp_path / "build" / "handwritten.py").write_text("source", encoding="utf-8")
    subprocess.run(["git", "add", "-f", "build/handwritten.py"], cwd=tmp_path, check=True, capture_output=True)

    result = ToolExecutor(build_default_tool_registry()).execute(
        ToolCall(id="list", name="list_files"), target_path=tmp_path,
    )

    assert result.output == "build/handwritten.py"


def test_search_and_shell_tools_support_repo_inspection(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    _create_repo(workspace)
    executor = ToolExecutor(build_default_tool_registry())

    search_result = executor.execute(
        ToolCall(
            id="search",
            name="search_files",
            arguments={"query": "subtract", "path": "src", "limit": 5},
        ),
        target_path=workspace,
    )
    regex_result = executor.execute(
        ToolCall(
            id="regex",
            name="search_files",
            arguments={"query": r"return a \+ b", "path": "src", "regex": True, "limit": 5},
        ),
        target_path=workspace,
    )
    shell_result = executor.execute(
        ToolCall(
            id="shell",
            name="shell",
            arguments={
                "command": f'"{sys.executable}" -c "print(\'hello from shell\')"',
                "working_directory": "src",
                "timeout_seconds": 10,
            },
        ),
        target_path=workspace,
    )
    shell_escape = executor.execute(
        ToolCall(
            id="shell-escape",
            name="shell",
            arguments={"command": "echo blocked", "working_directory": ".."},
        ),
        target_path=workspace,
    )

    assert "src/math_utils.py:1:def subtract" in search_result.output
    assert "src/math_utils.py:2:return a + b" in regex_result.output
    assert shell_result.success is True
    assert "hello from shell" in shell_result.output
    assert shell_escape.success is False
    assert "escapes the workspace root" in (shell_escape.error or "")


def test_search_skips_generated_and_hidden_files(tmp_path: Path) -> None:
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    (tmp_path / ".gitignore").write_text("node_modules/\n.tmp/\n", encoding="utf-8")
    (tmp_path / ".tmp").mkdir()
    (tmp_path / ".tmp" / "build.txt").write_text("needle in build", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET=needle", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "package.js").write_text("needle in package", encoding="utf-8")
    (tmp_path / "source.py").write_text("needle in source", encoding="utf-8")

    result = ToolExecutor(build_default_tool_registry()).execute(
        ToolCall(id="search", name="search_files", arguments={"query": "needle"}),
        target_path=tmp_path,
    )

    assert result.success is True
    assert result.output == "source.py:1:needle in source"


def test_git_tools_and_repo_workflow(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    _create_repo(workspace)
    executor = ToolExecutor(build_default_tool_registry())

    failing_test = executor.execute(
        ToolCall(
            id="test-fail",
            name="shell",
            arguments={
                "command": f'"{sys.executable}" -m pytest -q',
                "timeout_seconds": 30,
            },
        ),
        target_path=workspace,
    )
    write_result = executor.execute(
        ToolCall(
            id="fix",
            name="write_file",
            arguments={
                "path": "src/math_utils.py",
                "content": "def subtract(a: int, b: int) -> int:\n    return a - b\n\n",
            },
        ),
        target_path=workspace,
    )
    passing_test = executor.execute(
        ToolCall(
            id="test-pass",
            name="shell",
            arguments={
                "command": f'"{sys.executable}" -m pytest -q',
                "timeout_seconds": 30,
            },
        ),
        target_path=workspace,
    )
    status_result = executor.execute(
        ToolCall(id="status", name="git_status", arguments={}),
        target_path=workspace,
    )
    log_result = executor.execute(
        ToolCall(id="log", name="git_log", arguments={"limit": 10}),
        target_path=workspace,
    )
    diff_result = executor.execute(
        ToolCall(id="diff", name="git_diff", arguments={"path": "src/math_utils.py"}),
        target_path=workspace,
    )
    blank_path_diff = executor.execute(
        ToolCall(id="blank-diff", name="git_diff", arguments={"path": ""}),
        target_path=workspace,
    )
    blank_path_status = executor.execute(
        ToolCall(id="blank-status", name="git_status", arguments={"path": " "}),
        target_path=workspace,
    )
    subprocess.run(
        ["git", "add", "src/math_utils.py"], cwd=workspace, check=True, capture_output=True
    )
    staged_diff = executor.execute(
        ToolCall(
            id="staged-diff",
            name="git_diff",
            arguments={"path": "", "staged": True},
        ),
        target_path=workspace,
    )
    unstaged_diff = executor.execute(
        ToolCall(id="unstaged-diff", name="git_diff", arguments={"path": ""}),
        target_path=workspace,
    )

    assert failing_test.success is False
    assert "assert subtract(5, 2) == 3" in failing_test.output
    assert write_result.success is True
    assert passing_test.success is True
    assert "1 passed" in passing_test.output
    assert "M src/math_utils.py" in status_result.output
    history = json.loads(log_result.output)
    assert log_result.success is True
    assert history[0]["subject"] == "init"
    assert history[0]["short_hash"]
    assert "-    return a + b" in diff_result.output
    assert "+    return a - b" in diff_result.output
    assert blank_path_diff.success is True
    assert "src/math_utils.py" in blank_path_diff.output
    assert blank_path_status.success is True
    assert "src/math_utils.py" in staged_diff.output
    assert "-    return a + b" in staged_diff.output
    assert unstaged_diff.output == ""


def test_first_class_git_tools_match_ui_actions(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    _create_repo(workspace)
    executor = ToolExecutor(build_default_tool_registry())
    original_branch = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=workspace,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    subprocess.run(["git", "branch", "alternate"], cwd=workspace, check=True, capture_output=True)
    tracked = workspace / "src" / "math_utils.py"
    original_content = tracked.read_text(encoding="utf-8")
    tracked.write_text("changed\n", encoding="utf-8")

    staged = executor.execute(
        ToolCall(id="stage", name="git_stage", arguments={"paths": ["src/math_utils.py"]}),
        target_path=workspace,
    )
    unstaged = executor.execute(
        ToolCall(id="unstage", name="git_unstage", arguments={"paths": ["src/math_utils.py"]}),
        target_path=workspace,
    )
    discarded = executor.execute(
        ToolCall(id="discard", name="git_discard", arguments={"paths": ["src/math_utils.py"]}),
        target_path=workspace,
    )
    switched = executor.execute(
        ToolCall(id="switch", name="git_switch", arguments={"branch": "alternate"}),
        target_path=workspace,
    )
    refreshed = executor.execute(
        ToolCall(id="refresh", name="git_refresh", arguments={}),
        target_path=workspace,
    )

    assert staged.success is True
    assert any(item["path"] == "src/math_utils.py" for item in json.loads(staged.output)["staged"])
    assert unstaged.success is True
    assert discarded.success is True
    assert tracked.read_text(encoding="utf-8") == original_content
    assert switched.success is True
    assert json.loads(switched.output)["branch"] == "alternate"
    assert json.loads(refreshed.output)["branch"] == "alternate"
    assert original_branch != "alternate"
