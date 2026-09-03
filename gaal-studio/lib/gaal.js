'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 定位 gaal 可执行文件：环境变量 > 用户 bin > PATH 常见目录 */
function findGaalBinary() {
  const candidates = [
    process.env.GAAL_BIN,
    path.join(os.homedir(), 'bin', 'gaal.exe'),
    path.join(os.homedir(), 'bin', 'gaal'),
    path.join('C:', 'Program Files', 'Go', 'bin', 'gaal.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'gaal', 'gaal.exe'),
    '/usr/local/bin/gaal',
    path.join(os.homedir(), '.local', 'bin', 'gaal'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }

  // 回退：让系统 PATH 解析
  return 'gaal';
}

const GAAL_BIN = findGaalBinary();

/**
 * 执行 gaal 命令。
 * @param {string[]} args 参数列表
 * @param {{cwd?: string, timeout?: number}} opts
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function runGaal(args, opts = {}) {
  const { cwd = process.cwd(), timeout = 180000 } = opts;
  return new Promise((resolve) => {
    execFile(
      GAAL_BIN,
      ['--no-banner', ...args],
      { cwd, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          error: err ? err.message : null,
        });
      },
    );
  });
}

/** 执行并解析 JSON 输出（gaal 在 -o json 下会抑制 banner） */
async function runGaalJson(args, opts) {
  const r = await runGaal(args, opts);
  const text = r.stdout.trim();
  if (!text) {
    return { data: null, raw: r, parseError: r.stderr || r.error || 'empty output' };
  }
  // 容错：从第一个 { 开始截取，防止意外前缀
  const start = text.indexOf('{');
  try {
    return { data: JSON.parse(start >= 0 ? text.slice(start) : text), raw: r, parseError: null };
  } catch (e) {
    return { data: null, raw: r, parseError: e.message };
  }
}

function version() {
  return runGaalJson(['version', '-o', 'json']).then(async (v) => {
    if (v.data) return v.data;
    const r = await runGaal(['version']);
    return { version: (r.stdout.match(/v\d+\.\d+\.\d+/) || ['unknown'])[0], binary: GAAL_BIN };
  });
}

function agents() {
  return runGaalJson(['agents', '-o', 'json']);
}

function audit() {
  return runGaalJson(['audit', '-o', 'json']);
}

function status(cwd) {
  return runGaalJson(['status', '-o', 'json'], { cwd });
}

function doctor(cwd) {
  return runGaal(['doctor'], { cwd });
}

/**
 * 触发同步。
 * @param {{dryRun?:boolean, prune?:boolean, force?:boolean, cwd?:string}} opts
 */
async function sync(opts = {}) {
  const args = buildSyncArgs(opts);
  // 大仓库克隆可能很慢，超时放宽到 10 分钟
  const r = await runGaal(args, { cwd: opts.cwd, timeout: 600000 });
  return { ...r, args, binary: GAAL_BIN };
}

function buildSyncArgs(opts = {}) {
  const args = ['sync'];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.prune) args.push('--prune');
  if (opts.force) args.push('--force');
  if (opts.config) args.push('--config', opts.config);
  return args;
}

/**
 * 执行 sync 并通过 onChunk 实时回调输出（面板同步页流式显示）。
 * @param {{dryRun?:boolean, prune?:boolean, force?:boolean, cwd?:string}} opts
 * @param {(text: string) => void} [onChunk]
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 */
function syncStream(opts = {}, onChunk) {
  const args = buildSyncArgs(opts);
  return new Promise((resolve) => {
    const child = spawn(GAAL_BIN, ['--no-banner', ...args], {
      cwd: opts.cwd || process.cwd(),
      timeout: 600000,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
      try {
        onChunk?.(c.toString());
      } catch {
        /* 回调异常不影响采集 */
      }
    });
    child.stderr.on('data', (c) => {
      stderr += c;
      try {
        onChunk?.(c.toString());
      } catch {
        /* ignore */
      }
    });
    child.on('error', (err) => resolve({ stdout, stderr: stderr + (err.message || ''), code: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: typeof code === 'number' ? code : 0 }));
  });
}

/**
 * 初始化项目配置。
 * @param {{cwd:string, importAll?:boolean, force?:boolean}} opts
 */
async function init(opts = {}) {
  const args = ['init', '--scope', 'project'];
  if (opts.importAll) args.push('--import-all');
  else args.push('--empty');
  if (opts.force) args.push('--force');
  const r = await runGaal(args, { cwd: opts.cwd });
  return { ...r, args, binary: GAAL_BIN };
}

module.exports = {
  GAAL_BIN,
  runGaal,
  runGaalJson,
  version,
  agents,
  audit,
  status,
  doctor,
  sync,
  syncStream,
  init,
};
