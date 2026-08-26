const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { setup, uvVersion } = require("../../../scripts/setup.js");

function fakeSpawn(handler) {
  const calls = [];
  return {
    calls,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return handler(command, args, options);
    },
  };
}

test("setup prefers an existing local uv installation", () => {
  const fake = fakeSpawn(() => ({ status: 0 }));
  const localUv = path.resolve(__dirname, "../../../.tools/uv/uv");
  assert.equal(setup({ platform: "darwin", spawnSync: fake.spawnSync, existsSync: () => true }), localUv);
  assert.deepEqual(fake.calls.map(({ command, args }) => [command, args]), [
    [localUv, ["--version"]],
    [localUv, ["sync", "--all-packages", "--all-groups", "--frozen"]],
  ]);
  assert.match(fake.calls[1].options.env.UV_CACHE_DIR, /\.tools[\\/]uv-cache$/);
  assert.match(fake.calls[1].options.env.UV_PYTHON_INSTALL_DIR, /\.tools[\\/]python$/);
});

test("setup uses uv from PATH when no local installation exists", () => {
  const fake = fakeSpawn(() => ({ status: 0 }));
  assert.equal(setup({ spawnSync: fake.spawnSync, existsSync: () => false }), "uv");
  assert.deepEqual(fake.calls.map(({ command, args }) => [command, args]), [
    ["uv", ["--version"]],
    ["uv", ["sync", "--all-packages", "--all-groups", "--frozen"]],
  ]);
  assert.match(fake.calls[1].options.env.UV_CACHE_DIR, /\.tools[\\/]uv-cache$/);
  assert.match(fake.calls[1].options.env.UV_PYTHON_INSTALL_DIR, /\.tools[\\/]python$/);
});

test("setup installs a pinned local uv on Windows without modifying PATH", () => {
  const localUv = path.resolve(__dirname, "../../../.tools/uv/uv.exe");
  const fake = fakeSpawn((command) => ({ status: command === "uv" ? 1 : 0 }));
  assert.equal(setup({ platform: "win32", spawnSync: fake.spawnSync, existsSync: () => false }), localUv);
  assert.deepEqual(fake.calls.map(({ command, args }) => [command, args]), [
    ["uv", ["--version"]],
    ["powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `irm https://astral.sh/uv/${uvVersion}/install.ps1 | iex`,
    ]],
    [localUv, ["--version"]],
    [localUv, ["sync", "--all-packages", "--all-groups", "--frozen"]],
  ]);
  assert.equal(fake.calls[1].options.env.UV_UNMANAGED_INSTALL, path.dirname(localUv));
});

test("setup installs a pinned local uv on macOS without modifying PATH", () => {
  const localUv = path.resolve(__dirname, "../../../.tools/uv/uv");
  const fake = fakeSpawn((command) => ({ status: command === "uv" ? 1 : 0 }));
  assert.equal(setup({ platform: "darwin", spawnSync: fake.spawnSync, existsSync: () => false }), localUv);
  assert.deepEqual(fake.calls.map(({ command, args }) => [command, args]), [
    ["uv", ["--version"]],
    ["sh", ["-c", `curl -LsSf https://astral.sh/uv/${uvVersion}/install.sh | sh`]],
    [localUv, ["--version"]],
    [localUv, ["sync", "--all-packages", "--all-groups", "--frozen"]],
  ]);
  assert.equal(fake.calls[1].options.env.UV_UNMANAGED_INSTALL, path.dirname(localUv));
});
