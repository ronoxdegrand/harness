

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import {
  AlertTriangle,
  Check,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react";

import { Button, Input } from "@/components/ui";

import { SHORTCUT_LABEL } from "@/appShared";

import type { useAppController } from "@/useAppController";

type AppController = ReturnType<typeof useAppController>;

export function SettingsDialog({ controller }: { controller: AppController }) {
  const {
    desktop,
    setApiKey,
    setSarvamApiKey,
    setMaxIterations,
    setTimeoutMinutes,
    setSendOnEnter,
    setMidRunEnterAction,
    setUiScale,
    setAppearance,
    status,
    settingsOpen,
    setSettingsOpen,
    apiKeyDraft,
    setApiKeyDraft,
    sarvamApiKeyDraft,
    setSarvamApiKeyDraft,
    maxIterationsDraft,
    setMaxIterationsDraft,
    maxIterationsError,
    setMaxIterationsError,
    timeoutMinutesDraft,
    setTimeoutMinutesDraft,
    timeoutMinutesError,
    setTimeoutMinutesError,
    sendOnEnterDraft,
    setSendOnEnterDraft,
    midRunEnterActionDraft,
    setMidRunEnterActionDraft,
    uiScaleDraft,
    setUiScaleDraft,
    appearanceDraft,
    setAppearanceDraft,
    updateState,
    setUpdateState,
    updateCooldownActive,
    appVersion,
    openSettings,
    updateReady,
    updateBusy,
    updateButtonLabel,
    updateTooltip,
    restartToUpdate,
    settingsDirty,
  } = controller;
  return (
    <>
      <DialogPrimitive.Root
        open={settingsOpen}
        onOpenChange={(open) => {
          if (open) openSettings();
          else setSettingsOpen(false);
        }}
      >
        <DialogPrimitive.Trigger
          render={
            <Button
              aria-label="Settings"
              className="size-10 bg-card"
              size="icon-lg"
              type="button"
              variant="outline"
            >
              <Settings2 aria-hidden="true" className="size-4" />
            </Button>
          }
        />
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop
            className="fixed inset-0 z-[60] bg-black/25 backdrop-blur-[1px]"
            onClick={() => setSettingsOpen(false)}
          />
          <DialogPrimitive.Viewport className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center p-4">
            <DialogPrimitive.Popup className="pointer-events-auto max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xl outline-none">
              <form
                className="flex max-h-[calc(100vh-2rem)] flex-col"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  const iterationWarning = Number(maxIterationsDraft);
                  if (
                    !maxIterationsDraft.trim()
                    || !Number.isInteger(iterationWarning)
                    || iterationWarning < 1
                    || iterationWarning > 50
                  ) {
                    setMaxIterationsError("Enter a whole number from 1 to 50.");
                    return;
                  }
                  const timeWarning = Number(timeoutMinutesDraft);
                  if (
                    !timeoutMinutesDraft.trim()
                    || !Number.isInteger(timeWarning)
                    || timeWarning < 1
                    || timeWarning > 1440
                  ) {
                    setTimeoutMinutesError("Enter a whole number from 1 to 1440.");
                    return;
                  }
                  setApiKey(apiKeyDraft);
                  setSarvamApiKey(sarvamApiKeyDraft);
                  setMaxIterations(iterationWarning);
                  setTimeoutMinutes(timeWarning);
                  setSendOnEnter(sendOnEnterDraft);
                  setMidRunEnterAction(midRunEnterActionDraft);
                  setUiScale(uiScaleDraft);
                  setAppearance(appearanceDraft);
                  void desktop?.setScale(uiScaleDraft);
                  void desktop?.setAppearance(appearanceDraft);
                }}
              >
                <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-muted/30 px-5 py-4">
                  <DialogPrimitive.Title className="text-base font-semibold">Settings</DialogPrimitive.Title>
                  <DialogPrimitive.Description className="sr-only">Configure Harness settings.</DialogPrimitive.Description>
                  <div className="inline-flex h-8 shrink-0 items-stretch overflow-hidden rounded-lg border bg-background text-xs" data-tooltip={updateTooltip}>
                    <span className="inline-flex items-center border-r border-brand-border bg-brand-muted px-2.5 font-mono font-semibold text-brand">
                      v{appVersion}
                    </span>
                    {desktop ? (
                      <Button
                        aria-busy={updateBusy}
                        className={`h-full rounded-none px-2.5 disabled:opacity-100 ${updateState.status === "error" && updateCooldownActive ? "text-destructive" : updateState.status === "up-to-date" || updateState.status === "unavailable" ? "text-muted-foreground" : ""}`}
                        disabled={updateBusy || updateState.status === "unavailable" || (!updateReady && updateCooldownActive)}
                        size="sm"
                        type="button"
                        variant={updateReady ? "affirmative" : "ghost"}
                        onClick={() => {
                          if (updateReady) restartToUpdate();
                          else {
                            setUpdateState((state) => ({ ...state, status: "checking" }));
                            void desktop.checkForUpdates().then(setUpdateState).catch((reason) => setUpdateState({ status: "error", message: String(reason) }));
                          }
                        }}
                      >
                        {updateBusy
                          ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                          : updateState.status === "up-to-date" && updateCooldownActive
                            ? <Check aria-hidden="true" className="size-3.5" />
                            : updateState.status === "error" && updateCooldownActive
                              ? <AlertTriangle aria-hidden="true" className="size-3.5" />
                              : <RefreshCw aria-hidden="true" className="size-3.5" />}
                        <span aria-live="polite">{updateButtonLabel}</span>
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
                  <section className="rounded-xl border bg-muted/20 p-4">
                    <div className="mb-3">
                      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Providers</h3>
                      <p className="mt-1 text-xs text-muted-foreground">Keys stay on this device.</p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block space-y-1.5 text-xs font-medium">
                        <span>Gemini API key</span>
                        <Input
                          autoFocus
                          autoComplete="off"
                          placeholder="Enter Gemini key"
                          type="password"
                          value={apiKeyDraft}
                          onChange={(event) => setApiKeyDraft(event.target.value)}
                        />
                      </label>
                      <label className="block space-y-1.5 text-xs font-medium">
                        <span>Sarvam API key</span>
                        <Input
                          autoComplete="off"
                          placeholder="Enter Sarvam key"
                          type="password"
                          value={sarvamApiKeyDraft}
                          onChange={(event) => setSarvamApiKeyDraft(event.target.value)}
                        />
                      </label>
                    </div>
                  </section>

                  <section className="rounded-xl border bg-muted/20 p-4">
                    <div className="mb-3">
                      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Runs</h3>
                      <p className="mt-1 text-xs text-muted-foreground">Choose when Harness pauses to ask whether it should continue.</p>
                    </div>
                    <div className="grid gap-3 min-[480px]:grid-cols-2">
                      <div>
                        <label className="block space-y-1.5 text-xs font-medium" htmlFor="iteration-warning">
                          <span>Iteration warning</span>
                          <Input
                            id="iteration-warning"
                            aria-describedby={maxIterationsError ? "iteration-warning-error" : undefined}
                            aria-invalid={Boolean(maxIterationsError)}
                            max={50}
                            min={1}
                            required
                            type="number"
                            value={maxIterationsDraft}
                            onChange={(event) => {
                              setMaxIterationsDraft(event.target.value);
                              setMaxIterationsError("");
                            }}
                          />
                        </label>
                        {maxIterationsError ? (
                          <p className="mt-1.5 text-xs text-destructive" id="iteration-warning-error">
                            {maxIterationsError}
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <label className="block space-y-1.5 text-xs font-medium" htmlFor="time-warning">
                          <span>Run time warning (minutes)</span>
                          <Input
                            id="time-warning"
                            aria-describedby={timeoutMinutesError ? "time-warning-error" : undefined}
                            aria-invalid={Boolean(timeoutMinutesError)}
                            max={1440}
                            min={1}
                            required
                            type="number"
                            value={timeoutMinutesDraft}
                            onChange={(event) => {
                              setTimeoutMinutesDraft(event.target.value);
                              setTimeoutMinutesError("");
                            }}
                          />
                        </label>
                        {timeoutMinutesError ? (
                          <p className="mt-1.5 text-xs text-destructive" id="time-warning-error">
                            {timeoutMinutesError}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border bg-muted/20 p-4">
                    <div className="mb-3">
                      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Appearance</h3>
                      <p className="mt-1 text-xs text-muted-foreground">Adjust the interface for this device.</p>
                    </div>
                    <div className={`grid gap-4 ${desktop ? "sm:grid-cols-[minmax(0,1fr)_11rem]" : ""}`}>
                      <div className="space-y-2 text-xs font-medium">
                        <span>Theme</span>
                        <div className="grid grid-cols-3 gap-0.5 rounded-lg border bg-card p-1" role="group" aria-label="Theme">
                          {(["light", "dark", "system"] as const).map((option) => (
                            <Button
                              aria-pressed={appearanceDraft === option}
                              className="capitalize"
                              key={option}
                              type="button"
                              variant={appearanceDraft === option ? "default" : "ghost"}
                              onClick={() => setAppearanceDraft(option)}
                            >
                              {option}
                            </Button>
                          ))}
                        </div>
                      </div>
                      {desktop ? (
                        <div className="space-y-2 text-xs font-medium">
                          <span>Interface scale</span>
                          <div className="grid grid-cols-[36px_minmax(0,1fr)_36px] gap-0.5 rounded-lg border bg-card p-1" role="group" aria-label="Interface scale">
                        <Button
                          aria-label="Zoom out"
                              className="size-9"
                          disabled={uiScaleDraft <= 0.5}
                              size="icon-sm"
                          type="button"
                          variant="ghost"
                          onClick={() => setUiScaleDraft((scale) => Math.max(scale - 0.1, 0.5))}
                        >
                          <Minus aria-hidden="true" className="size-4" />
                        </Button>
                            <div className="flex h-9 items-center justify-center font-mono text-xs">
                          {Math.round(uiScaleDraft * 100)}%
                        </div>
                        <Button
                          aria-label="Zoom in"
                              className="size-9"
                          disabled={uiScaleDraft >= 2}
                              size="icon-sm"
                          type="button"
                          variant="ghost"
                          onClick={() => setUiScaleDraft((scale) => Math.min(scale + 0.1, 2))}
                        >
                          <Plus aria-hidden="true" className="size-4" />
                        </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </section>

                  <section className="rounded-xl border bg-muted/20 p-4">
                    <div className="mb-4">
                      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Composer</h3>
                      <p className="mt-1 text-xs text-muted-foreground">Set the primary keyboard action before and during a run.</p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2 text-xs font-medium">
                        <span>Send message</span>
                        <div className="grid grid-cols-2 gap-0.5 rounded-lg border bg-card p-1" role="group" aria-label="Message input shortcut">
                      <Button
                        aria-pressed={sendOnEnterDraft}
                              className="h-auto flex-col gap-1 px-2 py-2.5"
                        type="button"
                        variant={sendOnEnterDraft ? "default" : "ghost"}
                        onClick={() => setSendOnEnterDraft(true)}
                      >
                              <span className="flex items-center gap-1">
                                {!sendOnEnterDraft && (
                                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">Shift</kbd>
                                )}
                                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">Enter</kbd>
                              </span>
                              <span>Send</span>
                      </Button>
                      <Button
                        aria-pressed={!sendOnEnterDraft}
                              className="h-auto flex-col gap-1 px-2 py-2.5"
                        type="button"
                        variant={sendOnEnterDraft ? "ghost" : "default"}
                        onClick={() => setSendOnEnterDraft(false)}
                      >
                              <span className="flex items-center gap-1">
                                {sendOnEnterDraft && (
                                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">Shift</kbd>
                                )}
                                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">Enter</kbd>
                              </span>
                              <span>New line</span>
                      </Button>
                        </div>
                    </div>
                      <div className="space-y-2 text-xs font-medium">
                        <span>Enter during a run</span>
                        <div className="grid grid-cols-2 gap-0.5 rounded-lg border bg-card p-1" role="group" aria-label="Mid-run Enter action">
                      {(["queue", "steer"] as const).map((action) => (
                        <Button
                          aria-pressed={midRunEnterActionDraft === action}
                          className="h-auto flex-col gap-1 px-2 py-2.5 capitalize"
                          key={action}
                          type="button"
                          variant={midRunEnterActionDraft === action ? "default" : "ghost"}
                          onClick={() => setMidRunEnterActionDraft(action)}
                        >
                          <span className="flex items-center gap-1">
                            {midRunEnterActionDraft === action ? (
                              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] normal-case text-foreground">Enter</kbd>
                            ) : (
                              <>
                                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] normal-case text-foreground">{SHORTCUT_LABEL}</kbd>
                                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] normal-case text-foreground">Enter</kbd>
                              </>
                                    )}
                                  </span>
                                  <span>{action}</span>
                                </Button>
                              ))}
                            </div>
                              </div>
                            </div>
                          </section>
                          </div>
                        <div className="flex min-h-16 shrink-0 items-center gap-3 border-t bg-muted/20 px-5 py-3">
                          {settingsDirty ? (
                            <span className="text-xs font-medium text-warning" role="status">
                              Changes not saved yet
                            </span>
                          ) : null}
                          <Button className="ml-auto" type="button" variant="ghost" onClick={() => setSettingsOpen(false)}>Cancel</Button>
                          <Button type="submit" variant="affirmative">Save changes</Button>
                        </div>
                      </form>
                    </DialogPrimitive.Popup>
                  </DialogPrimitive.Viewport>
                </DialogPrimitive.Portal>
              </DialogPrimitive.Root>
    </>
  );
}
