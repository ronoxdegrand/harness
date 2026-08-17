from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from .context import Context
from .events import EventEmitter
from .model import ModelProvider
from .store import RunStore
from .tools import ToolExecutor, ToolRegistry


@dataclass
class RunResult:
    run_id: str
    status: str
    output_text: str
    iterations: int
    finalized_by_iteration_limit: bool


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
    ) -> None:
        self.model = model
        self.model_name = getattr(model, "model_name", None)
        self.tool_registry = tool_registry
        self.tool_executor = tool_executor
        self.store = store
        self.events = event_emitter or EventEmitter()
        self.max_iterations = max_iterations
        self.timeout_seconds = timeout_seconds

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
        self.store.save_snapshot(active_run_id, 0, context.snapshot())

        try:
            for iteration in range(1, iteration_limit + 1):
                if time.monotonic() - started_at > timeout_limit:
                    raise TimeoutError(f"Run exceeded {timeout_limit} seconds.")

                self._emit(active_run_id, "turn.started", iteration=iteration)
                self._emit(
                    active_run_id,
                    "model.started",
                    iteration=iteration,
                    model_name=self.model_name,
                )
                response = self.model.complete(
                    context,
                    final_response=iteration == iteration_limit,
                )

                if iteration == iteration_limit and response.tool_calls:
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

                if not response.tool_calls:
                    self._emit(
                        active_run_id,
                        "turn.completed",
                        iteration=iteration,
                        status="completed",
                    )
                    self.store.save_snapshot(active_run_id, iteration, context.snapshot())
                    self.store.complete_run(active_run_id, response.output_text)
                    return RunResult(
                        run_id=active_run_id,
                        status="completed",
                        output_text=response.output_text,
                        iterations=iteration,
                        finalized_by_iteration_limit=iteration == iteration_limit,
                    )

                for call in response.tool_calls:
                    self._emit(
                        active_run_id,
                        "tool.started",
                        iteration=iteration,
                        tool_call=call.as_dict(),
                    )
                    result = self.tool_executor.execute(call, target_path=resolved_target)
                    context.add_tool_result(call, result)

                    event_type = "tool.completed" if result.success else "tool.failed"
                    self._emit(
                        active_run_id,
                        event_type,
                        iteration=iteration,
                        tool_call=call.as_dict(),
                        result=result.as_dict(),
                    )

                self.store.save_snapshot(active_run_id, iteration, context.snapshot())
                self._emit(
                    active_run_id,
                    "turn.completed",
                    iteration=iteration,
                    status="tool_results_available",
                )

            raise RuntimeError(f"Run exceeded max_iterations={iteration_limit}.")
        except Exception as exc:
            self._emit(active_run_id, "turn.failed", error=str(exc))
            self.store.fail_run(active_run_id, str(exc))
            raise

    def resume(self, run_id: str) -> Context:
        snapshot = self.store.load_latest_snapshot(run_id)
        if snapshot is None:
            raise ValueError(f"No snapshot found for run {run_id}.")
        return Context.from_snapshot(snapshot)

    def _emit(self, run_id: str, event_type: str, **payload: object) -> None:
        event = self.events.emit(event_type, run_id=run_id, **payload)
        self.store.append_event(run_id, event.type, event.payload)
