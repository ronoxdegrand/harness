#!/usr/bin/env node

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const apiDir = path.join(repoRoot, 'apps', 'api');
const webDir = path.join(repoRoot, 'apps', 'web');
const venvPython = path.join(
  repoRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
);

function printUsage() {
  console.log('Usage: node scripts/dev.js <start-api|start-web|stop-api|stop-web|help>');
}

function runShell(command) {
  try {
    execSync(command, { stdio: 'ignore', shell: true });
  } catch {
    // Ignore failures from missing processes.
  }
}

function ensurePythonRuntime() {
  if (!fs.existsSync(venvPython)) {
    console.error(`Python venv not found at: ${venvPython}\nRun "npm run setup" first.`);
    process.exit(1);
  }
}

function startApi() {
  ensurePythonRuntime();

  const child = spawn(
    venvPython,
    ['-m', 'uvicorn', 'agent_harness_api.main:app', '--host', '127.0.0.1', '--port', '8000'],
    {
      cwd: apiDir,
      env: {
        ...process.env,
        PYTHONPATH: path.join(apiDir, 'src'),
      },
      stdio: 'inherit',
      shell: false,
    }
  );

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

function stopApi() {
  if (process.platform === 'win32') {
    runShell('taskkill /F /IM uvicorn.exe 2>nul');
    runShell('taskkill /F /IM python.exe 2>nul');
  } else {
    runShell('pkill -f "uvicorn agent_harness_api.main:app" || true');
    runShell('pkill -f "python.*uvicorn.*agent_harness_api.main:app" || true');
  }
}

function startWeb() {
  const child =
    process.platform === 'win32'
      ? spawn(process.env.comspec || 'cmd.exe', ['/d', '/s', '/c', 'npm run dev'], {
          cwd: webDir,
          stdio: 'inherit',
          shell: false,
        })
      : spawn('npm', ['run', 'dev'], {
          cwd: webDir,
          stdio: 'inherit',
          shell: false,
        });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

function stopWeb() {
  if (process.platform === 'win32') {
    runShell('for /f "tokens=2" %p in (\'tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2^>NUL ^| findstr /i "node.exe"\') do @taskkill /PID %p /F');
  } else {
    runShell('pkill -f "vite" || true');
  }
}

const command = process.argv[2] || 'help';

switch (command) {
  case 'start-api':
    startApi();
    break;
  case 'start-web':
    startWeb();
    break;
  case 'stop-api':
    stopApi();
    break;
  case 'stop-web':
    stopWeb();
    break;
  case 'help':
  case '--help':
  case '-h':
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
