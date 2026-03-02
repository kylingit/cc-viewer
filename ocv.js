#!/usr/bin/env node

/**
 * OpenCode Viewer CLI
 * 独立的 opencode 监控工具入口
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { startViewer } from './opencode-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const isHelp = args.includes('--help') || args.includes('-h');
const isVersion = args.includes('--version') || args.includes('-v');

// 帮助信息
if (isHelp) {
  console.log(`
OpenCode Viewer - Real-time API monitoring for OpenCode

Usage:
  ocv [options]

Options:
  -h, --help      Show this help message
  -v, --version   Show version number

Description:
  OpenCode Viewer reads OpenCode's storage data and provides
  a web interface to monitor API requests and token usage.

Data Sources:
  - Messages: ~/.local/share/opencode/storage/message/
  - Database: ~/.local/share/opencode/opencode.db

Features:
  - Real-time message monitoring
  - Token usage statistics
  - Session management
  - API request visualization
`);
  process.exit(0);
}

// 版本信息
if (isVersion) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
    console.log(`ocv v${pkg.version}-opencode`);
  } catch {
    console.log('ocv v1.0.0-opencode');
  }
  process.exit(0);
}

// 检查 opencode 是否已安装
const OPENCODE_DATA_DIR = resolve(homedir(), '.local', 'share', 'opencode');
if (!existsSync(OPENCODE_DATA_DIR)) {
  console.error('Error: OpenCode data directory not found.');
  console.error('Expected location: ~/.local/share/opencode/');
  console.error('Please make sure OpenCode is installed and has been run at least once.');
  process.exit(1);
}

// 启动服务器
console.log('[OpenCode Viewer] Starting...');
console.log('[OpenCode Viewer] Data directory:', OPENCODE_DATA_DIR);

startViewer().then((srv) => {
  if (!srv) {
    console.error('[OpenCode Viewer] Failed to start server');
    process.exit(1);
  }
  
  const port = srv.address().port;
  console.log(`[OpenCode Viewer] Dashboard: http://127.0.0.1:${port}`);
  
  // 可选：自动打开浏览器
  // const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  // spawn(cmd, [`http://127.0.0.1:${port}`], { stdio: 'ignore' });
}).catch((err) => {
  console.error('[OpenCode Viewer] Error:', err.message);
  process.exit(1);
});

// 处理退出信号
process.on('SIGINT', () => {
  console.log('\n[OpenCode Viewer] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});