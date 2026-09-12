const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdateController } = require("../src/updates");

function setup(checkForUpdates, enabled = true) {
  const updater = new EventEmitter();
  updater.checkForUpdates = checkForUpdates;
  const changes = [];
  const controller = createUpdateController(updater, { enabled, cooldownMs: 0, onChange: (state) => changes.push(state) });
  return { updater, controller, changes };
}

test("development builds do not contact the update server", async () => {
  const { controller } = setup(() => assert.fail("unexpected check"), false);
  assert.deepEqual(await controller.check(), { status: "unavailable" });
});

test("concurrent checks share a request and report no update", async () => {
  let resolve;
  let calls = 0;
  const { updater, controller } = setup(() => {
    calls++;
    return new Promise((done) => { resolve = done; });
  });
  const first = controller.check();
  assert.equal(controller.check(), first);
  await Promise.resolve();
  updater.emit("update-not-available");
  resolve({});
  assert.deepEqual(await first, { status: "up-to-date" });
  assert.equal(calls, 1);
});

test("available updates download and become ready without extra checks", async () => {
  let calls = 0;
  const { updater, controller } = setup(() => {
    calls++;
    updater.emit("update-available", { version: "0.7.0" });
    return { downloadPromise: Promise.resolve() };
  });
  assert.deepEqual(await controller.check(), { status: "downloading", version: "0.7.0" });
  await controller.check();
  updater.emit("update-downloaded", { version: "0.7.0" });
  assert.deepEqual(await controller.check(), { status: "ready", version: "0.7.0" });
  assert.equal(calls, 1);
});

test("failed checks can be retried", async () => {
  let calls = 0;
  const { updater, controller } = setup(() => {
    if (++calls === 1) throw new Error("Offline");
    updater.emit("update-not-available");
    return {};
  });
  assert.deepEqual(await controller.check(), { status: "error", message: "Offline" });
  assert.deepEqual(await controller.check(), { status: "up-to-date" });
});

test("download failures are consumed and reported", async () => {
  const { updater, controller } = setup(() => {
    updater.emit("update-available", { version: "0.7.0" });
    return { downloadPromise: Promise.reject(new Error("Download failed")) };
  });
  await controller.check();
  assert.deepEqual(controller.getState(), { status: "error", message: "Download failed" });
});

test("checks are throttled for 30 minutes, including after failures", async () => {
  let time = 1000;
  let calls = 0;
  const updater = new EventEmitter();
  updater.checkForUpdates = () => {
    calls++;
    throw new Error("Offline");
  };
  const controller = createUpdateController(updater, { enabled: true, now: () => time, onChange() {} });
  assert.deepEqual(await controller.check(), { status: "error", message: "Offline", retryAfter: 1801000 });
  for (let i = 0; i < 10; i++) await controller.check();
  time = 1800999;
  await controller.check();
  assert.equal(calls, 1);
  time = 1801000;
  await controller.check();
  assert.equal(calls, 2);
});
