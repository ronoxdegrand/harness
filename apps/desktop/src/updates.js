function createUpdateController(updater, { enabled, onChange, cooldownMs = 30 * 60 * 1000, now = Date.now }) {
  let state = { status: enabled ? "idle" : "unavailable" };
  let pending;
  let retryAfter = 0;
  const publish = (next) => {
    state = retryAfter ? { ...next, retryAfter } : next;
    onChange(state);
  };

  if (enabled) {
    updater.autoDownload = true;
    updater.on("checking-for-update", () => publish({ status: "checking" }));
    updater.on("update-not-available", () => publish({ status: "up-to-date" }));
    updater.on("update-available", (info) => publish({ status: "downloading", version: info.version }));
    updater.on("update-downloaded", (info) => publish({ status: "ready", version: info.version }));
    updater.on("error", (error) => publish({ status: "error", message: error.message || String(error) }));
  }

  return {
    getState: () => state,
    check() {
      if (!enabled || state.status === "ready" || state.status === "downloading") return Promise.resolve(state);
      if (pending) return pending;
      if (now() < retryAfter) return Promise.resolve(state);
      retryAfter = cooldownMs > 0 ? now() + cooldownMs : 0;
      publish({ status: "checking" });
      pending = Promise.resolve().then(() => updater.checkForUpdates()).then((result) => {
        // Downloads finish after the check resolves; consume their rejection too.
        result?.downloadPromise?.catch((error) => publish({ status: "error", message: error.message || String(error) }));
        if (!result && state.status === "checking") publish({ status: "unavailable" });
        return state;
      }).catch((error) => {
        publish({ status: "error", message: error.message || String(error) });
        return state;
      }).finally(() => { pending = undefined; });
      return pending;
    },
  };
}

module.exports = { createUpdateController };
