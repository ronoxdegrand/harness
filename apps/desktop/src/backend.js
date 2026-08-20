const { spawn } = require("node:child_process");
const readline = require("node:readline");

async function waitForReady(baseUrl, token, expectedVersion, fetchImpl = fetch, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${baseUrl}/health/ready`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const status = await response.json();
        if (status.version !== expectedVersion) {
          throw new Error(`Backend version ${status.version} does not match app ${expectedVersion}.`);
        }
        return status;
      }
    } catch (error) {
      if (error.message.includes("does not match")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Backend did not become ready in time.");
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function killProcessTree(child, spawnImpl = spawn) {
  if (child.exitCode !== null || child.signalCode != null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).once("exit", resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function stopBackend(backend, fetchImpl = fetch, spawnImpl = spawn, requestTimeoutMs = 5000) {
  if (!backend || backend.child.exitCode !== null || backend.child.signalCode != null) return;
  try {
    await fetchImpl(`${backend.baseUrl}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${backend.token}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    // The bounded process-tree fallback handles an unresponsive sidecar.
  }
  if (!(await waitForExit(backend.child, 5000))) {
    await killProcessTree(backend.child, spawnImpl);
    if (!(await waitForExit(backend.child, 2000))) {
      throw new Error("Backend process tree did not stop.");
    }
  }
}

async function startBackend(options) {
  const child = (options.spawnImpl || spawn)(options.executable, options.args || [], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const listening = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Backend did not report a port in time.")), 10000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.event === "listening" && Number.isInteger(message.port)) {
          clearTimeout(timeout);
          lines.close();
          resolve(message);
        }
      } catch {
        // Uvicorn output is not part of the launcher protocol.
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Backend exited before readiness with code ${code}.`));
    });
  });

  const address = await listening;
  const backend = {
    child,
    token: options.token,
    baseUrl: `http://${address.host}:${address.port}`,
  };
  try {
    await waitForReady(
      backend.baseUrl,
      backend.token,
      options.version,
      options.fetchImpl,
      options.readyTimeoutMs,
    );
  } catch (error) {
    await (options.killImpl || killProcessTree)(child, options.spawnImpl || spawn);
    throw error;
  }
  return backend;
}

module.exports = { startBackend, stopBackend, waitForReady };
