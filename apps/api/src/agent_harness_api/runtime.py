from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .context import Context
from .events import EventEmitter
from .model import ModelProvider
from .store import RunStore
from .tools import ToolCall, ToolExecutor, ToolRegistry


@dataclass
class RunResult:
    run_id: str
    status: str
    output_text: str
    iterations: int
    finalized_by_iteration_limit: bool


class RunStopped(Exception):
    pass


class AgentRuntime:
    def __init__(
        self,
        model: ModelProvider,
        tool_registry: ToolRegistry,
        tool_executor: ToolExecutor,
        store: RunStore,
        event_emitter: EventEmitter | None = None,
        max_iterations: int = 12,
        timeout_seconds: int = 120,
        continuation_decider: Callable[[int], bool] | None = None,
        stop_requested: Callable[[], bool] | None = None,
        steering_provider: Callable[[], list[str]] | None = None,
    ) -> None:
        self.model = model
        self.model_name = getattr(model, "model_name", None)
        self.tool_registry = tool_registry
        self.tool_executor = tool_executor
        self.store = store
        self.events = event_emitter or EventEmitter()
        self.max_iterations = max_iterations
        self.timeout_seconds = timeout_seconds
        self.continuation_decider = continuation_decider
        self.stop_requested = stop_requested
        self.steering_provider = steering_provider

    def run(
        self,
        prompt: str,
        *,
        target_path: str | Path,
        run_id: str | None = None,
        thread_id: str | None = None,
        initial_context: Context | None = None,
        max_iterations: int | None = None,
        timeout_seconds: int | None = None,
    ) -> RunResult:
        resolved_target = Path(target_path).resolve()
        active_run_id = run_id or str(uuid.uuid4())
        iteration_limit = max_iterations or self.max_iterations
        timeout_limit = timeout_seconds or self.timeout_seconds
        started_at = time.monotonic()
        context = initial_context or Context()
        context.add_user(prompt)

        self.store.create_run(
            run_id=active_run_id,
            target_path=resolved_target,
            max_iterations=iteration_limit,
            timeout_seconds=timeout_limit,
            model_name=self.model_name,
            thread_id=thread_id,
        )
        self._emit(active_run_id, "context.updated", context=context.inspect())
        self.store.save_snapshot(active_run_id, 0, context.snapshot())

        iteration = 0
        warning_interval = iteration_limit
        warning_after = iteration_limit - 1
        try:
            while True:
                iteration += 1
                self._check_stop()
                self._apply_steering(active_run_id, iteration, context)
                if time.monotonic() - started_at > timeout_limit:
                    raise TimeoutError(f"Run exceeded {timeout_limit} seconds.")

                force_final_response = False
                completed_iterations = iteration - 1
                if completed_iterations == warning_after:
                    self._emit(
                        active_run_id,
                        "run.continuation_requested",
                        iteration=completed_iterations,
                        completed_iterations=completed_iterations,
                    )
                    wait_started = time.monotonic()
                    continue_run = (
                        self.continuation_decider(completed_iterations)
                        if self.continuation_decider
                        else False
                    )
                    started_at += time.monotonic() - wait_started
                    self._emit(
                        active_run_id,
                        "run.continuation_decided",
                        iteration=completed_iterations,
                        continue_run=continue_run,
                    )
                    if continue_run:
                        warning_after += warning_interval
                    else:
                        force_final_response = True

                self._check_stop()

                self._emit(active_run_id, "turn.started", iteration=iteration)
                self._emit(
                    active_run_id,
                    "model.started",
                    iteration=iteration,
                    model_name=self.model_name,
                )
                response = self.model.complete(
                    context,
                    final_response=force_final_response,
                )

                if force_final_response and response.tool_calls:
                    if not response.output_text:
                        raise RuntimeError("Final iteration must return an output message.")
                    response.tool_calls = []

                for delta in response.deltas:
                    self._emit(
                        active_run_id,
                        "model.delta",
                        iteration=iteration,
                        delta=delta,
                    )

                model_completed_payload: dict[str, object] = {
                    "iteration": iteration,
                    "tool_calls": [call.as_dict() for call in response.tool_calls],
                }
                if response.output_text:
                    model_completed_payload["output_text"] = response.output_text

                self._emit(
                    active_run_id,
                    "model.completed",
                    **model_completed_payload,
                )

                if not response.output_text and not response.tool_calls:
                    raise RuntimeError(
                        "Model returned an empty response; neither text nor tool calls were produced."
                    )

                if response.output_text:
                    context.add_assistant(response.output_text)
                    self._emit(
                        active_run_id,
                        "context.updated",
                        iteration=iteration,
                        context=context.inspect(),
                    )

                self._check_stop()
                if self._apply_steering(active_run_id, iteration, context):
                    self._emit(
                        active_run_id,
                        "turn.completed",
                        iteration=iteration,
                        status="steering_received",
                    )
                    self.store.save_snapshot(active_run_id, iteration, context.snapshot())
                    continue

                if not response.tool_calls:
                    self._emit(
                        active_run_id,
                        "turn.completed",
                        iteration=iteration,
                        status="completed",
                    )
                    self.store.save_snapshot(active_run_id, iteration, context.snapshot())
                    finalized_by_iteration_limit = force_final_response
                    self.store.complete_run(
                        active_run_id,
                        response.output_text,
                        finalized_by_iteration_limit=finalized_by_iteration_limit,
                    )
                    return RunResult(
                        run_id=active_run_id,
                        status="completed",
                        output_text=response.output_text,
                        iterations=iteration,
                        finalized_by_iteration_limit=finalized_by_iteration_limit,
                    )

                for call in response.tool_calls:
                    self._check_stop()
                    self._execute_tool(
                        active_run_id,
                        iteration,
                        call,
                        resolved_target,
                        context,
                    )

                self._emit(
                    active_run_id,
                    "turn.completed",
                    iteration=iteration,
                    status="tool_results_available",
                )

        except RunStopped:
            output_text = next(
                (message.content for message in reversed(context.messages) if message.role == "assistant"),
                "",
            )
            self._emit(active_run_id, "turn.stopped", iteration=max(iteration, 1))
            self.store.save_snapshot(active_run_id, iteration, context.snapshot())
            self.store.stop_run(active_run_id, output_text)
            return RunResult(
                run_id=active_run_id,
                status="stopped",
                output_text=output_text,
                iterations=iteration,
                finalized_by_iteration_limit=False,
            )
        except Exception as exc:
            self._emit(active_run_id, "turn.failed", iteration=iteration or 1, error=str(exc))
            self.store.fail_run(active_run_id, str(exc))
            raise

    def _check_stop(self) -> None:
        if self.stop_requested and self.stop_requested():
            raise RunStopped()

    def _apply_steering(self, run_id: str, iteration: int, context: Context) -> bool:
        messages = self.steering_provider() if self.steering_provider else []
        if not messages:
            return False
        for content in messages:
            context.add_user(content)
            self._emit(run_id, "run.steered", iteration=iteration, content=content)
        self._emit(
            run_id,
            "context.updated",
            iteration=iteration,
            context=context.inspect(),
        )
        return True

    def resume(self, run_id: str) -> Context:
        snapshot = self.store.load_latest_snapshot(run_id)
        if snapshot is None:
            raise ValueError(f"No snapshot found for run {run_id}.")
        context = Context.from_snapshot(snapshot)
        pending = self.store.list_pending_tool_executions(run_id)
        if not pending:
            return context
        target_path = self.store.get_run_target(run_id)
        if target_path is None:
            raise ValueError(f"Run {run_id} does not exist.")
        for execution in pending:
            if execution["replay_policy"] == "never":
                payload = {
                    "run_id": run_id,
                    "iteration": execution["iteration"],
                    "tool_call": {
                        "id": execution["id"],
                        "name": execution["name"],
                        "arguments": execution["arguments"],
                    },
                    "reason": "The process stopped after execution started; side effects are unknown.",
                }
                self.store.mark_tool_execution_indeterminate(run_id, execution["id"], payload)
                if execution["status"] == "started":
                    self.events.emit("tool.indeterminate", **payload)
                raise RuntimeError(
                    f"Tool {execution['name']} ({execution['id']}) may have produced side effects; "
                    "automatic replay is unsafe."
                )
            call = ToolCall(
                id=execution["id"],
                name=execution["name"],
                arguments=execution["arguments"],
            )
            self._emit(
                run_id,
                "tool.replaying",
                iteration=execution["iteration"],
                tool_call=call.as_dict(),
                replay_policy=execution["replay_policy"],
            )
            self._execute_tool(
                run_id,
                execution["iteration"],
                call,
                target_path,
                context,
                already_started=True,
            )
        return context

    def _execute_tool(
        self,
        run_id: str,
        iteration: int,
        call: ToolCall,
        target_path: Path,
        context: Context,
        *,
        already_started: bool = False,
    ) -> None:
        tool_call = call.as_dict()
        started_payload = {
            "run_id": run_id,
            "iteration": iteration,
            "tool_call": tool_call,
        }
        if not already_started:
            self.store.start_tool_execution(
                run_id=run_id,
                iteration=iteration,
                tool_call=tool_call,
                replay_policy=self.tool_registry.get(call.name).replay_policy,
                event_payload=started_payload,
            )
            self.events.emit("tool.started", **started_payload)

        result = self.tool_executor.execute(call, target_path=target_path)
        context.add_tool_result(call, result)
        context_payload = {
            "run_id": run_id,
            "iteration": iteration,
            "context": context.inspect(),
        }
        result_payload = {
            "run_id": run_id,
            "iteration": iteration,
            "tool_call": tool_call,
            "result": result.as_dict(),
        }
        result_event = "tool.completed" if result.success else "tool.failed"
        self.store.finish_tool_execution(
            run_id=run_id,
            tool_call_id=call.id,
            iteration=iteration,
            result=result.as_dict(),
            messages=context.snapshot(),
            events=[("context.updated", context_payload), (result_event, result_payload)],
        )
        self.events.emit("context.updated", **context_payload)
        self.events.emit(result_event, **result_payload)

    def _emit(self, run_id: str, event_type: str, **payload: object) -> None:
        durable_payload = {"run_id": run_id, **payload}
        self.store.append_event(run_id, event_type, durable_payload)
        self.events.emit(event_type, **durable_payload)
