import json
import sqlite3
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agent_harness_api.context import Context
from agent_harness_api.config import get_settings
from agent_harness_api.db import initialize_database
from agent_harness_api.events import EventEmitter, RuntimeEvent
from agent_harness_api.model import ModelResponse
from agent_harness_api.runtime import AgentRuntime
from agent_harness_api.store import RunStore
from agent_harness_api.tools import ToolCall, ToolExecutor, ToolResult, build_default_tool_registry


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


class SteeringModelProvider:
    def __init__(self) -> None:
        self.calls = 0

    def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
        self.calls += 1
        if self.calls == 1:
            return ModelResponse(output_text="Initial direction")
        assert any(
            message.role == "user" and message.content == "Focus on the API"
            for message in context.messages
        )
        assert any(
            message.role == "user" and message.content == "Keep the tests focused"
            for message in context.messages
        )
        return ModelResponse(output_text="Steered result")


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


def test_model_exception_is_sanitized_before_persistence(tmp_path: Path, monkeypatch) -> None:
    class FailingModel:
        def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
            raise RuntimeError("provider URL contains secret-test-key")

    database_path = tmp_path / "failed_model.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()
    events: list[RuntimeEvent] = []
    emitter = EventEmitter()
    emitter.subscribe(events.append)
    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=FailingModel(),
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=RunStore(database_path),
        event_emitter=emitter,
    )

    with pytest.raises(RuntimeError, match="model request failed unexpectedly"):
        runtime.run("hello", target_path=tmp_path)

    with sqlite3.connect(database_path) as connection:
        stored_error = connection.execute("SELECT error FROM harness_runs").fetchone()[0]
    assert "secret-test-key" not in stored_error
    assert "secret-test-key" not in str(next(event for event in events if event.type == "turn.failed").payload)


def test_runtime_stops_before_starting_more_work(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(tmp_path / "stopped.db"))
    get_settings.cache_clear()
    initialize_database()
    captured_events: list[RuntimeEvent] = []
    emitter = EventEmitter()
    emitter.subscribe(captured_events.append)
    registry = build_default_tool_registry()
    model = SteeringModelProvider()
    runtime = AgentRuntime(
        model=model,
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=RunStore(),
        event_emitter=emitter,
        stop_requested=lambda: True,
    )

    result = runtime.run("inspect", target_path=tmp_path)

    assert result.status == "stopped"
    assert model.calls == 0
    assert "turn.stopped" in [event.type for event in captured_events]


def test_runtime_applies_steering_before_finishing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(tmp_path / "steered.db"))
    get_settings.cache_clear()
    initialize_database()
    captured_events: list[RuntimeEvent] = []
    emitter = EventEmitter()
    emitter.subscribe(captured_events.append)
    registry = build_default_tool_registry()
    model = SteeringModelProvider()
    polls = 0

    def take_steering() -> list[str]:
        nonlocal polls
        polls += 1
        return ["Focus on the API", "Keep the tests focused"] if polls == 2 else []

    runtime = AgentRuntime(
        model=model,
        tool_registry=registry,
        tool_executor=ToolExecutor(registry),
        store=RunStore(),
        event_emitter=emitter,
        steering_provider=take_steering,
    )

    result = runtime.run("inspect", target_path=tmp_path)

    assert result.output_text == "Steered result"
    assert result.iterations == 2
    assert [event.type for event in captured_events].count("run.steered") == 2


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


def test_iteration_warning_repeats_after_each_full_interval(
    tmp_path: Path, monkeypatch
) -> None:
    database_path = tmp_path / "continuation.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()

    decisions = iter([True, True, False])
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
        max_iterations=8,
        continuation_decider=decide,
    )

    result = runtime.run("keep inspecting", target_path=tmp_path)

    assert warnings == [7, 15, 23]
    assert model.final_response_flags == [False] * 23 + [True]
    assert result.iterations == 24
    assert result.finalized_by_iteration_limit is True


def test_repeated_identical_tool_failures_remain_visible_to_model(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "repeated-failure.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()

    class RepeatingModel:
        def __init__(self) -> None:
            self.calls = 0

        def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
            self.calls += 1
            if self.calls == 4:
                assert sum(message.role == "tool" for message in context.messages) == 3
                assert context.retry_instruction is None
                return ModelResponse(output_text="The file could not be read after repeated attempts.")
            return ModelResponse(tool_calls=[
                ToolCall(id=f"missing-{self.calls}", name="read_file", arguments={"path": "missing.txt"})
            ])

    model = RepeatingModel()
    pauses: list[tuple[str, int, dict[str, object]]] = []

    def decide(reason: str, iteration: int, details: dict[str, object]) -> bool:
        pauses.append((reason, iteration, details))
        return False

    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=model, tool_registry=registry, tool_executor=ToolExecutor(registry),
        store=RunStore(database_path), progress_decider=decide,
    )

    result = runtime.run("read the missing file", target_path=tmp_path)

    assert result.status == "completed"
    assert result.finalized_by_iteration_limit is False
    assert model.calls == 4
    assert pauses == []
    assert "repeated attempts" in result.output_text


def test_emergency_time_ceiling_offers_a_final_response(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "time-ceiling.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()
    clock = [0.0]

    class SlowModel:
        def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
            if final_response:
                return ModelResponse(output_text="Here is what I found so far.")
            clock[0] = 31.0
            return ModelResponse(tool_calls=[ToolCall(id="list", name="list_files")])

    pauses: list[str] = []

    def decide(reason: str, iteration: int, details: dict[str, object]) -> bool:
        pauses.append(reason)
        return False

    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=SlowModel(), tool_registry=registry, tool_executor=ToolExecutor(registry),
        store=RunStore(database_path), timeout_seconds=30, progress_decider=decide,
    )

    with patch("agent_harness_api.runtime.time", SimpleNamespace(monotonic=lambda: clock[0])):
        result = runtime.run("inspect", target_path=tmp_path)

    assert result.status == "completed"
    assert result.finalized_by_iteration_limit is False
    assert result.output_text == "Here is what I found so far."
    assert pauses == ["time_limit"]


def test_continuing_after_time_ceiling_resets_the_window(tmp_path: Path, monkeypatch) -> None:
    database_path = tmp_path / "continued-time-ceiling.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()
    clock = [0.0]

    class ContinuingModel:
        def __init__(self) -> None:
            self.calls = 0

        def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
            self.calls += 1
            if self.calls == 1:
                clock[0] = 31.0
                return ModelResponse(tool_calls=[ToolCall(id="list", name="list_files")])
            return ModelResponse(output_text="Done after continuing.")

    pauses: list[str] = []

    def decide(reason: str, iteration: int, details: dict[str, object]) -> bool:
        pauses.append(reason)
        return True

    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=ContinuingModel(), tool_registry=registry, tool_executor=ToolExecutor(registry),
        store=RunStore(database_path), timeout_seconds=30, progress_decider=decide,
    )

    with patch("agent_harness_api.runtime.time", SimpleNamespace(monotonic=lambda: clock[0])):
        result = runtime.run("inspect", target_path=tmp_path)

    assert result.output_text == "Done after continuing."
    assert result.finalized_by_iteration_limit is False
    assert pauses == ["time_limit"]


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
                "expandable": False,
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
                "expandable": True,
            },
        ],
    }


def test_context_truncates_a_message_larger_than_the_budget() -> None:
    context = Context(token_budget=2)
    context.add_user("123456789")

    assert context.messages[0].content == "12345678"
    assert context.inspect()["messages"][0]["truncated"] is True


def test_context_compaction_keeps_user_task_and_successful_edits_without_source_text() -> None:
    context = Context(token_budget=512)
    context.add_user("Build the harness so repository tool examples stay data")
    context.add_tool_result(
        ToolCall(id="edit", name="patch"),
        ToolResult(success=True, output="", metadata={"path": "src/agent.py"}),
    )
    context.add_user("Proceed")
    context.add_tool_result(
        ToolCall(id="read", name="read_file"),
        ToolResult(success=True, output="<tool_call>patch<arg_key>path</arg_key>" * 200),
    )
    context.add_assistant("Reading source")

    result = context.compact_if_needed()

    assert result is not None
    assert result["after_tokens"] < result["before_tokens"]
    checkpoint = context.snapshot()[0]
    assert checkpoint["role"] == "checkpoint"
    assert "Build the harness" in checkpoint["content"]
    assert "src/agent.py" in checkpoint["content"]
    assert "<tool_call>" not in checkpoint["content"]
    assert any(message.role == "user" and message.content == "Proceed" for message in context.messages)

    context.add_tool_result(
        ToolCall(id="read-again", name="read_file"),
        ToolResult(success=True, output="untrusted source " * 200),
    )
    assert context.compact_if_needed() is not None
    assert "Build the harness" in context.snapshot()[0]["content"]


def test_restoring_a_snapshot_drops_legacy_feedback() -> None:
    context = Context.from_snapshot([
        {"role": "user", "content": "Inspect the repository"},
        {"role": "feedback", "content": "An old correction"},
    ])

    assert [message.role for message in context.messages] == ["user"]
    assert context.retry_instruction is None


def test_runtime_retries_unstructured_tool_markup_as_a_structured_call(tmp_path: Path, monkeypatch) -> None:
    class MalformedThenPatched:
        calls = 0

        def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
            self.calls += 1
            if self.calls == 1:
                return ModelResponse(output_text=(
                    "<tool_call>patch<arg_key>path</arg_key><arg_value>agent.py</arg_value></tool_call>"
                ))
            if self.calls == 2:
                assert context.retry_instruction is not None
                assert "No tool ran" in context.retry_instruction
                assert all(message["role"] != "feedback" for message in context.snapshot())
                return ModelResponse(tool_calls=[ToolCall(
                    id="real-patch", name="patch", arguments={
                        "path": "agent.py", "old_string": "status = 'old'", "new_string": "status = 'new'",
                    },
                )])
            assert context.retry_instruction is None
            return ModelResponse(output_text="Updated agent.py.")

    (tmp_path / "agent.py").write_text("status = 'old'\n", encoding="utf-8")
    database_path = tmp_path / "invalid_tool_call.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()
    events: list[RuntimeEvent] = []
    emitter = EventEmitter()
    emitter.subscribe(events.append)
    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=MalformedThenPatched(), tool_registry=registry,
        tool_executor=ToolExecutor(registry), store=RunStore(database_path), event_emitter=emitter,
    )

    result = runtime.run("Update agent.py", target_path=tmp_path)

    assert result.status == "completed"
    assert (tmp_path / "agent.py").read_text(encoding="utf-8") == "status = 'new'\n"
    assert sum(event.type == "model.invalid_tool_call" for event in events) == 1
    assert sum(event.type == "tool.completed" for event in events) == 1


def test_repo_tool_examples_are_data_not_calls(tmp_path: Path, monkeypatch) -> None:
    class ReadsHarnessSource:
        calls = 0

        def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
            self.calls += 1
            if self.calls == 1:
                return ModelResponse(tool_calls=[ToolCall(
                    id="read-example", name="read_file", arguments={"path": "harness.txt"},
                )])
            assert any("<tool_call>patch" in message.content for message in context.messages if message.role == "tool")
            return ModelResponse(output_text="The file contains a tool-call example.")

    source = "This harness documents <tool_call>patch<arg_key>path</arg_key>.\n"
    (tmp_path / "harness.txt").write_text(source, encoding="utf-8")
    database_path = tmp_path / "nested_harness.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()
    events: list[RuntimeEvent] = []
    emitter = EventEmitter()
    emitter.subscribe(events.append)
    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=ReadsHarnessSource(), tool_registry=registry,
        tool_executor=ToolExecutor(registry), store=RunStore(database_path), event_emitter=emitter,
    )

    result = runtime.run("Explain the example", target_path=tmp_path)

    assert result.status == "completed"
    assert (tmp_path / "harness.txt").read_text(encoding="utf-8") == source
    assert all(event.type != "model.invalid_tool_call" for event in events)


def test_repeated_unstructured_tool_markup_fails_without_editing(tmp_path: Path, monkeypatch) -> None:
    class AlwaysMalformed:
        def complete(self, context: Context, *, final_response: bool = False) -> ModelResponse:
            return ModelResponse(output_text="<tool_call>patch<arg_key>path</arg_key></tool_call>")

    path = tmp_path / "agent.py"
    path.write_text("original\n", encoding="utf-8")
    database_path = tmp_path / "malformed.db"
    monkeypatch.setenv("HARNESS_SQLITE_PATH", str(database_path))
    get_settings.cache_clear()
    initialize_database()
    registry = build_default_tool_registry()
    runtime = AgentRuntime(
        model=AlwaysMalformed(), tool_registry=registry,
        tool_executor=ToolExecutor(registry), store=RunStore(database_path),
    )

    with pytest.raises(RuntimeError, match="no tool ran"):
        runtime.run("Update agent.py", target_path=tmp_path)

    assert path.read_text(encoding="utf-8") == "original\n"
