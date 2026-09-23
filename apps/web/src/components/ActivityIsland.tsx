import type { PointerEvent as ReactPointerEvent, RefObject, Dispatch, SetStateAction } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { CopyButton } from "@/components/AppPrimitives";
import { DEFAULT_ACTIVITY_WIDTH, MIN_ACTIVITY_WIDTH, formatTimestamp, showInActivity, type RuntimeEvent } from "@/appShared";

type EventGroup = { iteration: number | null; createdAt?: string; events: RuntimeEvent[] };
type ActivityIslandProps = {
  resizable: boolean;
  eventGroups: EventGroup[];
  activityRunId: string | null;
  collapsedActivityGroups: Record<string, boolean>;
  setCollapsedActivityGroups: Dispatch<SetStateAction<Record<string, boolean>>>;
  activityScrollRef: RefObject<HTMLDivElement | null>;
  setActivityWidth: Dispatch<SetStateAction<number>>;
  onResizeCancel: () => void;
  startResize: (panel: "activity", event: ReactPointerEvent<HTMLDivElement>) => void;
  resizePanel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onOpenEditedFile: (path: string) => void;
};

export function ActivityIsland({
  resizable, eventGroups, activityRunId, collapsedActivityGroups, setCollapsedActivityGroups,
  activityScrollRef, setActivityWidth, onResizeCancel, startResize, resizePanel, onOpenEditedFile,
}: ActivityIslandProps) {
  return (
    <aside
      aria-label="Activity"
      className={`activity-island relative flex min-h-0 w-full flex-col rounded-xl border bg-sidebar shadow-sm ${
        resizable ? "h-full" : "my-3"
      }`}
      style={resizable ? { minWidth: `${MIN_ACTIVITY_WIDTH}px` } : undefined}
    >
      {resizable ? (
        <div
          aria-label="Resize activity"
          className="group absolute inset-y-0 -right-1 z-30 hidden w-2 cursor-col-resize touch-none lg:block"
          role="separator"
          onDoubleClick={() => setActivityWidth(DEFAULT_ACTIVITY_WIDTH)}
          onPointerCancel={onResizeCancel}
          onPointerDown={(event) => startResize("activity", event)}
          onPointerMove={resizePanel}
          onPointerUp={onResizeCancel}
        >
          <span className="absolute inset-y-0 left-1/2 w-px bg-transparent group-hover:bg-border" />
        </div>
      ) : null}
      <div
        className={`space-y-4 rounded-xl p-3 ${
          resizable ? "min-h-0 flex-1 overflow-y-auto" : "overflow-visible"
        }`}
        ref={activityScrollRef}
      >
        {eventGroups.length ? (
          eventGroups.map((group, groupIndex) => {
            const displayedEvents = group.events.filter(showInActivity);
            const groupKey = `${activityRunId ?? "all"}-${group.iteration ?? "initialization"}-${groupIndex}`;
            const groupCollapsed = collapsedActivityGroups[groupKey] === true;
            const iterationModel = group.events.find(
              (runtimeEvent) => runtimeEvent.type === "model.started",
            )?.payload.model_name;
            const iterationFinished = group.events.some(
              (runtimeEvent) =>
                runtimeEvent.type === "turn.completed" || runtimeEvent.type === "turn.failed",
            );

            return (
              <section
                className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0"
                key={`${group.iteration}-${groupIndex}`}
              >
                <div className="flex items-center justify-between gap-2 px-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="shrink-0 text-xs font-semibold">
                      {group.iteration === null ? "Initialization" : `Iteration ${group.iteration}`}
                    </p>
                    {typeof iterationModel === "string" && iterationModel ? (
                      <Badge className="h-5 min-w-0 max-w-40 truncate rounded-sm px-1.5 text-xs" data-tooltip={iterationModel}>
                        {iterationModel}
                      </Badge>
                    ) : null}
                    <Button
                      aria-expanded={!groupCollapsed}
                      aria-controls={`activity-events-${groupIndex}`}
                      className="h-5 shrink-0 gap-1 rounded-sm bg-secondary px-1.5 text-xs text-secondary-foreground hover:bg-secondary/80"
                      size="xs"
                      type="button"
                      variant="ghost"
                      onClick={() => setCollapsedActivityGroups((current) => ({
                        ...current,
                        [groupKey]: !groupCollapsed,
                      }))}
                    >
                      {displayedEvents.length
                        ? `${displayedEvents.length} ${displayedEvents.length === 1 ? "event" : "events"}`
                        : iterationFinished ? "Finished" : "In progress"}
                      {groupCollapsed ? (
                        <ChevronDown aria-hidden="true" className="size-3" />
                      ) : (
                        <ChevronUp aria-hidden="true" className="size-3" />
                      )}
                    </Button>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {group.createdAt ? (
                      <time className="text-xs text-muted-foreground" dateTime={group.createdAt}>
                        {formatTimestamp(group.createdAt)}
                      </time>
                    ) : null}
                    <CopyButton
                      className="!size-6"
                      content={JSON.stringify(group.events, null, 2)}
                      label={group.iteration === null
                        ? "Copy initialization activity"
                        : `Copy iteration ${group.iteration} activity`}
                    />
                  </div>
                </div>
                {!groupCollapsed ? (
                  <div className="space-y-2" id={`activity-events-${groupIndex}`}>
                {displayedEvents.map((runtimeEvent, eventIndex) => {
                  const isToolEvent = runtimeEvent.type.startsWith("tool.");
                  const isFailedEvent = runtimeEvent.type.endsWith(".failed");
                  const toolCall = runtimeEvent.payload.tool_call as
                    | { name?: string; arguments?: Record<string, unknown> }
                    | undefined;
                  const result = runtimeEvent.payload.result as
                    | { output?: string; error?: string }
                    | undefined;
                  const { iteration: _, run_id: __, ...eventPayload } = runtimeEvent.payload;
                  const editedPath = runtimeEvent.type === "tool.completed"
                    && (toolCall?.name === "write_file" || toolCall?.name === "patch")
                    && typeof toolCall.arguments?.path === "string"
                    ? toolCall.arguments.path : null;

                  if (runtimeEvent.type === "context.updated") {
                    return (
                      <Card className="rounded-lg p-3 text-sm shadow-none" key={`${runtimeEvent.type}-${eventIndex}`}>
                        <details>
                          <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            Context updated
                          </summary>
                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
                            {JSON.stringify(eventPayload, null, 2)}
                          </pre>
                        </details>
                      </Card>
                    );
                  }

                  return (
                    <Card
                      key={`${runtimeEvent.type}-${eventIndex}`}
                      className={`rounded-lg p-3 text-sm shadow-none ${
                        isFailedEvent
                          ? "border-destructive/30 bg-destructive/5"
                          : runtimeEvent.type === "tool.completed"
                            ? "border-success-border bg-success-muted"
                            : "bg-card"
                      }`}
                    >
                      <details>
                      <summary className={`cursor-pointer text-[10px] font-semibold uppercase tracking-[0.12em] ${
                        isFailedEvent
                          ? "text-destructive"
                          : runtimeEvent.type === "tool.completed"
                            ? "text-success"
                            : "text-muted-foreground"
                      }`}>
                        {runtimeEvent.type.replaceAll(".", " ")}
                        {isToolEvent && toolCall?.name ? (
                          <span className="ml-1.5 font-mono normal-case tracking-normal text-foreground">· {toolCall.name}</span>
                        ) : null}
                      </summary>

                      {isToolEvent ? (
                        <div className="mt-2 space-y-2">
                          <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
                            {JSON.stringify(toolCall?.arguments ?? {}, null, 2)}
                          </pre>
                          {result?.output ? (
                            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                              {String(result.output).slice(0, 1200)}
                            </pre>
                          ) : null}
                          {result?.error ? (
                            <p className="text-xs text-destructive">{String(result.error)}</p>
                          ) : null}
                          {editedPath ? (
                            <Button
                              className="h-6 px-2 text-xs"
                              size="xs"
                              type="button"
                              variant="outline"
                              onClick={() => onOpenEditedFile(editedPath)}
                            >
                              View diff
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
                          {JSON.stringify(eventPayload, null, 2)}
                        </pre>
                      )}
                      </details>
                    </Card>
                  );
                })}
                  </div>
                ) : null}
              </section>
            );
          })
        ) : (
          <p className="px-2 py-8 text-center text-sm leading-6 text-muted-foreground">
            Tool calls, model events, and run details will appear here.
          </p>
        )}
      </div>
    </aside>
  );
}
