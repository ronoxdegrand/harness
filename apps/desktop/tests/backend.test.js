const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { startBackend, stopBackend, waitForReady } = require("../src/backend");

test("readiness requires the atomic app version and auth token", async () => {
  let authorization;
  await waitForReady("http://127.0.0.1:3210", "secret", "1.2.3", async (_url, options) => {
    authorization = options.headers.authorization;
    return { ok: true, json: async () => ({ status: "ready", version: "1.2.3" }) };
  });
  assert.equal(authorization, "Bearer secret");
});

test("startup waits for the reported port and backend readiness", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.pid = 123;
  const started = startBackend({
    executable: "sidecar",
    token: "secret",
    version: "1.2.3",
    spawnImpl: () => child,
    fetchImpl: async (url) => ({
      ok: url === "http://127.0.0.1:4567/health/ready",
      json: async () => ({ version: "1.2.3" }),
    }),
  });
  child.stdout.write('{"event":"listening","host":"127.0.0.1","port":4567}\n');
  const backend = await started;
  assert.equal(backend.baseUrl, "http://127.0.0.1:4567");
});

test("startup kills the sidecar when readiness fails", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.pid = 123;
  let killed = false;
  const started = startBackend({
    executable: "sidecar",
    token: "secret",
    version: "1.2.3",
    readyTimeoutMs: 1,
    spawnImpl: () => child,
    fetchImpl: async () => ({ ok: false }),
    killImpl: async () => {
      killed = true;
    },
  });
  child.stdout.write('{"event":"listening","host":"127.0.0.1","port":4567}\n');
  await assert.rejects(started, /ready in time/);
  assert.equal(killed, true);
});

test("shutdown requests graceful sidecar termination", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  const backend = { child, baseUrl: "http://127.0.0.1:4567", token: "secret" };
  let request;
  await stopBackend(backend, async (url, options) => {
    request = { url, options };
    child.exitCode = 0;
    child.emit("exit", 0);
    return { ok: true };
  });
  assert.equal(request.url, "http://127.0.0.1:4567/shutdown");
  assert.equal(request.options.headers.authorization, "Bearer secret");
});

test("shutdown bounds an unresponsive graceful request", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  await stopBackend(
    { child, baseUrl: "http://127.0.0.1:4567", token: "secret" },
    (_url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          child.exitCode = 0;
          child.emit("exit", 0);
          reject(signal.reason);
        });
      }),
    undefined,
    1,
  );
  assert.equal(child.exitCode, 0);
});

test("shutdown recognizes a sidecar already stopped by a signal", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = "SIGKILL";
  let requested = false;
  await stopBackend({ child }, async () => {
    requested = true;
  });
  assert.equal(requested, false);
});
