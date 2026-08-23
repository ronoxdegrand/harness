import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from agent_harness_api.context import Context
from agent_harness_api.config import get_settings
from agent_harness_api.db import initialize_database
from agent_harness_api.events import EventEmitter, RuntimeEvent
from agent_harness_api.model import ModelResponse
from agent_harness_api.runtime import AgentRuntime
from agent_harness_api.store import RunStore
from agent_harness_api.tools import ToolCall, ToolExecutor, build_default_tool_registry


class ScriptedModelProvider:
    def __init__(self, python_executable: str) -> None:
        self.python_executable = python_executable
        self.final_response_flags: list[bool] = []

    def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
        self.final_response_flags.append(final_response)
        if final_response:
            return ModelResponse(
                deltas=["Summarizing completion"],
                output_text="Fixed the subtraction bug and confirmed the test suite passes.",
            )

        tool_messages = [message for message in context.messages if message.role == "tool"]
        if not tool_messages:
            return ModelResponse(
                deltas=["Inspecting repository"],
                tool_calls=[
                    ToolCall(id="call-list", name="list_files", arguments={}),
                ],
            )

        if len(tool_messages) == 1:
            return ModelResponse(
                deltas=["Searching for the failing function"],
                tool_calls=[
                    ToolCall(
                        id="call-search",
                        name="search_files",
                        arguments={"query": "subtract", "limit": 10},
                    )
                ],
            )

        if len(tool_messages) == 2:
            return ModelResponse(
                deltas=["Reading implementation details"],
                tool_calls=[
                    ToolCall(
                        id="call-read",
                        name="read_file",
                        arguments={"path": "math_utils.py"},
                    )
                ],
            )

        if len(tool_messages) == 3:
            return ModelResponse(
                deltas=["Running tests before editing"],
                tool_calls=[
                    ToolCall(
                        id="call-test-fail",
                        name="shell",
                        arguments={
                            "command": f'"{self.python_executable}" -m pytest -q',
                            "timeout_seconds": 30,
                        },
                    )
                ],
            )

        if len(tool_messages) == 4:
            return ModelResponse(
                deltas=["Patching the bug"],
                tool_calls=[
                    ToolCall(
                        id="call-edit",
                        name="write_file",
                        arguments={
                            "path": "math_utils.py",
                            "content": "def subtract(a: int, b: int) -> int:\n    return a - b\n",
                        },
                    )
                ],
            )

        if len(tool_messages) == 5:
            return ModelResponse(
                deltas=["Inspecting the git diff"],
                tool_calls=[
                    ToolCall(
                        id="call-diff",
                        name="git_diff",
                        arguments={"path": "math_utils.py", "timeout_seconds": 30},
                    )
                ],
            )

        if len(tool_messages) == 6:
            return ModelResponse(
                deltas=["Re-running tests"],
                tool_calls=[
                    ToolCall(
                        id="call-test-pass",
                        name="shell",
                        arguments={
                            "command": f'"{self.python_executable}" -m pytest -q',
                            "timeout_seconds": 30,
                        },
                    )
                ],
            )

        return ModelResponse(tool_calls=[ToolCall(id="call-extra", name="list_files")])


class EmptyModelProvider:
    def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
        return ModelResponse()


class ContinuingModelProvider:
    def __init__(self) -> None:
        self.final_response_flags: list[bool] = []

    def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
        self.final_response_flags.append(final_response)
        if final_response:
            return ModelResponse(output_text="Stopped at the warning boundary.")
        return ModelResponse(
            tool_calls=[
                ToolCall(
                    id=f"call-{len(self.final_response_flags)}",
                    name="list_files",
                    arguments={},
                )
            ]
        )


def _write_broken_repo(repo_path: Path) -> None:
    repo_path.mkdir(parents=True, exist_ok=True)
    (repo_path / "math_utils.py").write_text(
        "def subtract(a: int, b: int) -> int:\n    return a + b\n",
        encoding="utf-8",
    )
    tests_dir = repo_path / "tests"
    tests_dir.mkdir()
    (tests_dir / "test_math_utils.py").write_text(
        "from math_utils import subtract\n\n\ndef test_subtract() -> None:\n    assert subtract(5, 2) == 3\n",
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


def test_runtime_fails_when_model_returns_no_text_or_tools(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "empty_model.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()

    captured_events: list[RuntimeEvent] = []
    emitter = EventEmitter()
    emitter.subscribe(captured_events.append)
    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=EmptyModelProvider(),
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=RunStore(database_path),
        event_emitter=emitter,
        max_iterations=2,
        timeout_seconds=30,
    )

    try:
        runtime.run("ask for anything", target_path=tmp_path)
        raise AssertionError("Expected a runtime error when the model produced an empty response.")
    except RuntimeError as exc:
        assert "empty response" in str(exc).lower()
    failure = next(event for event in captured_events if event.type == "turn.failed")
    assert failure.payload["iteration"] == 1


def test_agent_runtime_executes_single_agent_loop(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "runtime.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()

    broken_repo = tmp_path / "broken-repo"
    _write_broken_repo(broken_repo)

    captured_events: list[RuntimeEvent] = []
    emitter = EventEmitter()
    emitter.subscribe(captured_events.append)

    registry = build_default_tool_registry()
    model = ScriptedModelProvider(sys.executable)
    runtime = AgentRuntime(
        model=model,
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=RunStore(database_path),
        event_emitter=emitter,
        max_iterations=8,
        timeout_seconds=60,
    )

    result = runtime.run(
        "Inspect the repository, fix the bug, and confirm tests pass.",
        target_path=broken_repo,
    )

    assert result.status == "completed"
    assert "test suite passes" in result.output_text
    assert "return a - b" in (broken_repo / "math_utils.py").read_text(encoding="utf-8")
    assert model.final_response_flags == [False] * 7 + [True]
    assert result.finalized_by_iteration_limit is True

    event_types = [event.type for event in captured_events]
    assert "turn.started" in event_types
    assert "model.started" in event_types
    assert "model.delta" in event_types
    assert "model.completed" in event_types
    assert "tool.started" in event_types
    assert "tool.failed" in event_types
    assert "tool.completed" in event_types
    assert "turn.completed" in event_types
    assert "turn.failed" not in event_types

    tool_failures = [
        event
        for event in captured_events
        if event.type == "tool.failed"
        and event.payload["tool_call"]["id"] == "call-test-fail"
    ]
    assert tool_failures
    failure_result = tool_failures[0].payload["result"]
    assert failure_result["success"] is False
    assert "assert subtract(5, 2) == 3" in failure_result["output"]

    connection = sqlite3.connect(database_path)
    run_row = connection.execute(
        "SELECT status, final_output, finalized_by_iteration_limit FROM harness_runs WHERE id = ?",
        (result.run_id,),
    ).fetchone()
    event_count = connection.execute(
        "SELECT COUNT(*) FROM harness_events WHERE run_id = ?",
        (result.run_id,),
    ).fetchone()
    snapshot_count = connection.execute(
        "SELECT COUNT(*) FROM harness_snapshots WHERE run_id = ?",
        (result.run_id,),
    ).fetchone()
    connection.close()

    assert run_row == ("completed", result.output_text, 1)
    assert event_count is not None and event_count[0] > 0
    assert snapshot_count is not None and snapshot_count[0] >= 2


def test_iteration_warning_can_continue_for_another_full_interval(
    tmp_path: Path, monkeypatch
) -> None:
    database_path = tmp_path / "continuation.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()

    decisions = iter([True, False])
    warnings: list[int] = []

    def decide(iteration: int) -> bool:
        warnings.append(iteration)
        return next(decisions)

    registry = build_default_tool_registry()
    model = ContinuingModelProvider()
    runtime = AgentRuntime(
        model=model,
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=RunStore(database_path),
        max_iterations=3,
        continuation_decider=decide,
    )

    result = runtime.run("keep inspecting", target_path=tmp_path)

    assert warnings == [3, 6]
    assert model.final_response_flags == [False] * 5 + [True]
    assert result.iterations == 6
    assert result.finalized_by_iteration_limit is True


def test_runtime_resume_loads_latest_snapshot(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "resume.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()

    store = RunStore(database_path)
    store.create_run(
        run_id="resume-run",
        target_path=tmp_path,
        max_iterations=2,
        timeout_seconds=10,
    )
    snapshot = [{"role": "user", "content": "resume me", "name": None, "tool_call_id": None}]
    store.save_snapshot("resume-run", 1, snapshot)

    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=ScriptedModelProvider(sys.executable),
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=store,
    )

    context = runtime.resume("resume-run")
    assert json.loads(json.dumps(context.snapshot())) == snapshot


def test_resume_replays_a_safe_interrupted_tool(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "resume-safe.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()
    (tmp_path / "README.md").write_text("durable\n", encoding="utf-8")

    store = RunStore(database_path)
    store.create_run(
        run_id="safe-run",
        target_path=tmp_path,
        max_iterations=2,
        timeout_seconds=10,
    )
    store.save_snapshot(
        "safe-run",
        0,
        [{"role": "user", "content": "read", "name": None, "tool_call_id": None}],
    )
    call = {"id": "read-1", "name": "read_file", "arguments": {"path": "README.md"}}
    store.start_tool_execution(
        run_id="safe-run",
        iteration=1,
        tool_call=call,
        replay_policy="safe",
        event_payload={"run_id": "safe-run", "iteration": 1, "tool_call": call},
    )

    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=EmptyModelProvider(),
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=store,
    )
    context = runtime.resume("safe-run")

    assert context.snapshot()[-1]["tool_call_id"] == "read-1"
    assert "durable" in context.snapshot()[-1]["content"]
    with sqlite3.connect(database_path) as connection:
        status = connection.execute(
            "SELECT status FROM harness_tool_executions WHERE tool_call_id = 'read-1'"
        ).fetchone()
    assert status == ("completed",)


def test_resume_blocks_an_ambiguous_side_effect(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "resume-unsafe.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()

    store = RunStore(database_path)
    store.create_run(
        run_id="unsafe-run",
        target_path=tmp_path,
        max_iterations=2,
        timeout_seconds=10,
    )
    store.save_snapshot(
        "unsafe-run",
        0,
        [{"role": "user", "content": "run", "name": None, "tool_call_id": None}],
    )
    call = {"id": "shell-1", "name": "shell", "arguments": {"command": "echo hi"}}
    store.start_tool_execution(
        run_id="unsafe-run",
        iteration=1,
        tool_call=call,
        replay_policy="never",
        event_payload={"run_id": "unsafe-run", "iteration": 1, "tool_call": call},
    )
    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=EmptyModelProvider(),
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=store,
    )

    with pytest.raises(RuntimeError, match="automatic replay is unsafe"):
        runtime.resume("unsafe-run")
    with sqlite3.connect(database_path) as connection:
        status = connection.execute(
            "SELECT status FROM harness_tool_executions WHERE tool_call_id = 'shell-1'"
        ).fetchone()
    assert status == ("indeterminate",)


def test_context_keeps_the_newest_messages_within_budget() -> None:
    context = Context(token_budget=4)
    context.add_user("task")
    context.add_assistant("12345678901234567890")

    assert [message.content for message in context.messages] == ["task", "123456789012"]
    assert context.inspect() == {
        "token_budget": 4,
        "estimated_tokens": 4,
        "estimate_method": "message characters divided by 4",
        "messages": [
            {
                "index": 1,
                "role": "user",
                "name": None,
                "tokens": 1,
                "included": True,
                "pinned": True,
                "truncated": False,
                "preview": "task",
            },
            {
                "index": 2,
                "role": "assistant",
                "name": None,
                "tokens": 3,
                "included": True,
                "pinned": False,
                "truncated": True,
                "preview": "123456789012",
            },
        ],
    }


def test_context_truncates_a_message_larger_than_the_budget() -> None:
    context = Context(token_budget=2)
    context.add_user("123456789")

    assert context.messages[0].content == "12345678"
    assert context.inspect()["messages"][0]["truncated"] is True
