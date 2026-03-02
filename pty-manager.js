import { resolveNativePath } from './findcc.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { chmodSync, statSync } from 'node:fs';
import { platform, arch } from 'node:os';

let ptyProcess = null;
let dataListeners = [];
let exitListeners = [];
let lastExitCode = null;
let outputBuffer = '';
const MAX_BUFFER = 200000;

function fixSpawnHelperPermissions() {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const os = platform();
    const cpu = arch();
    const helperPath = join(__dirname, 'node_modules', 'node-pty', 'prebuilds', `${os}-${cpu}`, 'spawn-helper');
    const stat = statSync(helperPath);
    if (!(stat.mode & 0o111)) {
      chmodSync(helperPath, stat.mode | 0o755);
    }
  } catch {}
}

export async function spawnClaude(proxyPort, cwd) {
  if (ptyProcess) {
    throw new Error('PTY process already running');
  }

  const ptyMod = await import('node-pty');
  const pty = ptyMod.default || ptyMod;

  fixSpawnHelperPermissions();

  const claudePath = resolveNativePath();
  if (!claudePath) {
    throw new Error('claude not found');
  }

  const env = { ...process.env };
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  env.CCV_PROXY_MODE = '1'; // 告诉 interceptor.js 不要再启动 server

  const settingsJson = JSON.stringify({
    env: { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL }
  });

  const args = ['--settings', settingsJson];

  lastExitCode = null;
  outputBuffer = '';

  ptyProcess = pty.spawn(claudePath, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd || process.cwd(),
    env,
  });

  ptyProcess.onData((data) => {
    outputBuffer += data;
    if (outputBuffer.length > MAX_BUFFER) {
      outputBuffer = outputBuffer.slice(-MAX_BUFFER);
    }
    for (const cb of dataListeners) {
      try { cb(data); } catch {}
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    lastExitCode = exitCode;
    ptyProcess = null;
    for (const cb of exitListeners) {
      try { cb(exitCode); } catch {}
    }
  });

  return ptyProcess;
}

export function writeToPty(data) {
  if (ptyProcess) {
    ptyProcess.write(data);
  }
}

export function resizePty(cols, rows) {
  if (ptyProcess) {
    try { ptyProcess.resize(cols, rows); } catch {}
  }
}

export function killPty() {
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch {}
    ptyProcess = null;
  }
}

export function onPtyData(cb) {
  dataListeners.push(cb);
  return () => {
    dataListeners = dataListeners.filter(l => l !== cb);
  };
}

export function onPtyExit(cb) {
  exitListeners.push(cb);
  return () => {
    exitListeners = exitListeners.filter(l => l !== cb);
  };
}

export function getPtyState() {
  return {
    running: !!ptyProcess,
    exitCode: lastExitCode,
  };
}

export function getOutputBuffer() {
  return outputBuffer;
}
