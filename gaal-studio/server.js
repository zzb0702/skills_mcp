'use strict';

/**
 * gaal-studio — gaal 的可视化管理面板
 * 启动: node server.js  →  http://127.0.0.1:7788
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const gaal = require('./lib/gaal');
const conf = require('./lib/config');
const registry = require('./lib/registry');
const { writeFileAtomic } = require('./lib/atomic');
const { lineDiff } = require('./lib/diff');
const { discoverMcps } = require('./lib/mcp-discovery');
const { discoverSkills } = require('./lib/skill-discovery');
const { EXTRA_AGENTS } = require('./lib/extra-agents');
const toggle = require('./lib/toggle');

/** gaal 官方注册表 + 补充 agent（如 zcode），按 name 去重 */
function mergeAgents(list) {
  const names = new Set(list.map((a) => a.name));
  for (const x of EXTRA_AGENTS) {
    if (!names.has(x.name)) list.push(x);
  }
  return list.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
}

const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ───────────── DNS rebinding 防护 ─────────────
 * 默认只监听回环地址时，校验 Host 头必须指向本机，
 * 防止恶意网页把域名解析到 127.0.0.1 后借用户身份调用 API。
 * 显式以 0.0.0.0 / :: 监听（局域网使用）时不校验。
 */
const HOST_IS_LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

function hostAllowed(hostHeader) {
  const s = String(hostHeader || '').toLowerCase().trim();
  // 以实际监听端口为准（测试会用临时端口）
  const port = String(server.listening && server.address() ? server.address().port : PORT);
  const names = ['127.0.0.1', 'localhost', '[::1]', '::1', `${String(HOST).toLowerCase()}`];
  return names.some((n) => s === `${n}:${port}`);
}

/* 低于此版本的 gaal 未经过面板验证（agents/audit 的 JSON 字段可能缺失） */
const MIN_GAAL_VERSION = [0, 3, 0];

function parseVer(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function verCmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ───────────── 全局状态（内存） ───────────── */

const state = {
  /** 当前活动项目目录 */
  projectDir: process.cwd(),
  /** 最近使用的项目目录（最多 8 个） */
  recentDirs: [],
  /** 最近一次 sync 结果 */
  lastSync: null,
  /** 同步互斥锁：手动 sync、SSE sync、定时 sync 共用，避免并发 gaal 进程冲突 */
  syncBusy: false,
  /** 定时 sync 配置 */
  schedule: { enabled: false, intervalMin: 60, timer: null, lastRun: null, lastResult: null },
};

/** GitHub 仓库信息缓存（listRepoSkills，未认证 API 限额 60 次/小时） */
const repoInfoCache = new Map();
const REPO_INFO_TTL = 10 * 60 * 1000;

function loadSchedulePrefs() {
  try {
    const p = path.join(__dirname, 'studio.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.schedule) {
        state.schedule.enabled = !!j.schedule.enabled;
        state.schedule.intervalMin = Number(j.schedule.intervalMin) || 60;
      }
      if (j.projectDir && fs.existsSync(j.projectDir)) state.projectDir = j.projectDir;
      if (Array.isArray(j.recentDirs)) {
        state.recentDirs = j.recentDirs.filter((d) => typeof d === 'string' && fs.existsSync(d)).slice(0, 8);
      }
    }
  } catch {
    /* ignore */
  }
}

function saveSchedulePrefs() {
  writeFileAtomic(
    path.join(__dirname, 'studio.json'),
    JSON.stringify(
      {
        schedule: { enabled: state.schedule.enabled, intervalMin: state.schedule.intervalMin },
        projectDir: state.projectDir,
        recentDirs: state.recentDirs,
      },
      null,
      2,
    ),
  );
}

function applySchedule() {
  if (state.schedule.timer) {
    clearInterval(state.schedule.timer);
    state.schedule.timer = null;
  }
  if (!state.schedule.enabled) return;
  const ms = Math.max(1, state.schedule.intervalMin) * 60 * 1000;
  state.schedule.timer = setInterval(async () => {
    if (state.syncBusy) return; // 已有同步在跑（手动或定时），跳过本轮
    state.syncBusy = true;
    try {
      const r = await gaal.sync({ cwd: state.projectDir });
      state.schedule.lastRun = new Date().toISOString();
      state.schedule.lastResult = { code: r.code, stderr: r.stderr.slice(0, 2000) };
    } finally {
      state.syncBusy = false;
    }
  }, ms);
  state.schedule.timer.unref?.();
}

/* ───────────── 工具函数 ───────────── */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function fail(res, code, msg) {
  send(res, code, { error: msg });
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 2 * 1024 * 1024) throw new Error('body too large');
  }
  if (!data) return {};
  try {
    return JSON.parse(data);
  } catch {
    const e = new Error('请求体不是合法 JSON');
    e.status = 400;
    throw e;
  }
}

function safeDir(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
  return abs;
}

/** Windows 盘符列表（C:\ D:\ ...），非 Windows 返回空 */
function listDrives() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (let c = 67; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try {
      if (fs.existsSync(d)) out.push({ name: `${String.fromCharCode(c)}:`, path: d });
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 记录最近使用的项目目录（最多 8 个） */
function rememberProjectDir(dir) {
  state.recentDirs = [dir, ...(state.recentDirs || []).filter((x) => x !== dir)].slice(0, 8);
}

/** 规范 inline MCP 定义：args 兜底为数组，避免 null 落盘到 gaal.yaml */
function normalizeInline(inline) {
  const c = { ...inline };
  if (c.args == null) c.args = [];
  else if (!Array.isArray(c.args)) c.args = [String(c.args)];
  return c;
}

/* ───────────── API 路由 ───────────── */

const routes = {
  'GET /api/meta': async (req, res) => {
    const v = await gaal.version();
    const version = v.version || v;
    const pv = parseVer(typeof version === 'string' ? version : version?.version);
    send(res, 200, {
      binary: gaal.GAAL_BIN,
      version,
      compat: pv ? { ok: verCmp(pv, MIN_GAAL_VERSION) >= 0, min: MIN_GAAL_VERSION.join('.') } : { ok: true, unknown: true },
      projectDir: state.projectDir,
      home: os.homedir(),
      userConfig: conf.USER_CONFIG,
      platform: process.platform,
    });
  },

  'GET /api/agents': async (req, res) => {
    const { data, parseError } = await gaal.agents();
    if (!data) return fail(res, 502, parseError);
    data.agents = mergeAgents(data.agents || []);
    send(res, 200, data);
  },

  /** 增强版 audit：gaal 原生结果 + gaal 未扫描目录的补充（trae / zencoder / zcode 等） */
  'GET /api/audit': async (req, res) => {
    const { data, parseError } = await gaal.audit();
    if (!data) return fail(res, 502, parseError);

    const agents = mergeAgents((await gaal.agents()).data?.agents || []);
    // gaal 已报告过的 skill 目录，避免重复
    const skip = new Set(
      (data.skills || [])
        .filter((s) => s.path)
        .map((s) => {
          let p = String(s.path).replace(/\\/g, '/').replace(/\/+$/, '');
          if (/\/SKILL\.md$/i.test(p)) p = p.slice(0, -'/SKILL.md'.length);
          return `${s.agent || ''}|${p}`.toLowerCase();
        }),
    );
    const extra = discoverSkills(agents, state.projectDir, skip);

    // 把已禁用的 skill 以 enabled:false 合并回来，前端才能重新启用
    const dis = toggle.disabledList().skills;
    const disabledRows = dis
      .filter((d) => !skip.has(`${d.agent}|${String(d.original).replace(/\\/g, '/')}`.toLowerCase()))
      .map((d) => ({
        name: d.name,
        dir_name: d.name,
        agent: d.agent,
        source: /[/\\]\.[a-z-]+[/\\]skills[/\\]/i.test(d.original) ? 'global' : 'project',
        desc: '（已禁用，文件已备份）',
        path: String(d.original).replace(/\\/g, '/'),
        enabled: false,
        backup: d.backup ? String(d.backup).replace(/\\/g, '/') : null,
      }));

    data.skills = [...(data.skills || []), ...extra, ...disabledRows];
    data.agents = [...new Set([...(data.agents || []), ...extra.map((s) => s.agent), ...dis.map((d) => d.agent)])].sort();
    send(res, 200, data);
  },

  /** MCP 发现：直接解析各 agent 的 JSON/TOML/YAML 配置（补齐 gaal audit 的盲区，含 zcode） */
  'GET /api/mcps': async (req, res) => {
    const { data, parseError } = await gaal.agents();
    if (!data) return fail(res, 502, parseError);
    const list = discoverMcps(mergeAgents(data.agents || []), state.projectDir);

    // 硬禁用（已从配置文件移除条目）的 MCP 合并回来
    const seen = new Set(list.map((m) => `${m.agent}|${m.scope}|${m.name}`.toLowerCase()));
    for (const d of toggle.disabledList().mcps) {
      if (seen.has(`${d.agent}|${d.scope}|${d.name}`.toLowerCase())) continue;
      list.push({
        name: d.name,
        agent: d.agent,
        scope: d.scope,
        type: d.entry?.url ? 'http' : 'stdio',
        command: d.entry?.command || '',
        args: d.entry?.args || [],
        url: d.entry?.url || '',
        enabled: false,
        file: d.file,
        hardDisabled: true,
      });
    }
    send(res, 200, { mcps: list, projectDir: state.projectDir });
  },

  'GET /api/status': async (req, res) => {
    const { data, raw, parseError } = await gaal.status(state.projectDir);
    if (!data) {
      // 没有 gaal.yaml 时 status 可能报错，返回 unmanaged 视图
      return send(res, 200, { degraded: true, message: raw.stderr || parseError, audit: (await gaal.audit()).data });
    }
    send(res, 200, data);
  },

  'GET /api/config': async (req, res) => {
    const cfg = conf.readConfig(state.projectDir);
    send(res, 200, cfg);
  },

  'POST /api/config': async (req, res) => {
    const body = await readBody(req);
    if (typeof body.text !== 'string') return fail(res, 400, 'text required');
    try {
      const p = conf.writeConfig(state.projectDir, body.text);
      send(res, 200, { ok: true, path: p });
    } catch (e) {
      fail(res, 422, e.message);
    }
  },

  'GET /api/user-config': async (req, res) => {
    if (!fs.existsSync(conf.USER_CONFIG)) {
      return send(res, 200, { exists: false, path: conf.USER_CONFIG, text: '', data: null });
    }
    const text = fs.readFileSync(conf.USER_CONFIG, 'utf8');
    let data = null;
    let parseError = null;
    try {
      data = require('js-yaml').load(text);
    } catch (e) {
      parseError = e.message;
    }
    send(res, 200, { exists: true, path: conf.USER_CONFIG, text, data, parseError });
  },

  'POST /api/project/select': async (req, res) => {
    const body = await readBody(req);
    const dir = safeDir(body.path || '');
    if (!dir) return fail(res, 400, '目录不存在');
    state.projectDir = dir;
    rememberProjectDir(dir);
    saveSchedulePrefs();
    send(res, 200, { ok: true, projectDir: dir, hasConfig: fs.existsSync(conf.configPath(dir)) });
  },

  /** 一键初始化：在当前项目创建 gaal.yaml（mode: empty | import-all），随后自动 sync */
  'POST /api/project/init': async (req, res) => {
    const body = await readBody(req);
    const mode = body.mode === 'import-all' ? 'import-all' : 'empty';
    const file = conf.configPath(state.projectDir);
    if (fs.existsSync(file) && !body.force) {
      return fail(res, 409, 'gaal.yaml 已存在（如需覆盖请传 force）');
    }
    const r = await gaal.init({ cwd: state.projectDir, importAll: mode === 'import-all', force: !!body.force });
    if (r.code !== 0) {
      return fail(res, 500, `gaal init 失败：${(r.stderr || r.stdout || r.error || '').trim() || 'exit ' + r.code}`);
    }
    // 初始化成功后自动同步一次
    let syncResult = null;
    if (body.sync !== false) {
      const s = await gaal.sync({ cwd: state.projectDir });
      syncResult = { code: s.code, output: s.stdout, stderr: s.stderr };
      state.lastSync = { ...s, at: new Date().toISOString(), opts: { via: 'init' } };
    }
    send(res, 200, {
      ok: true,
      mode,
      path: file,
      initOutput: (r.stdout || '').trim(),
      sync: syncResult,
    });
  },

  'GET /api/fs/list': async (req, res, url) => {
    const dir = url.searchParams.get('path') || os.homedir();
    const abs = path.resolve(dir);
    try {
      const BLOCK = new Set(['Windows', 'Program Files', 'Program Files (x86)', 'Recovery', 'PerfLogs', 'System Volume Information', '$Recycle.Bin', '$RECYCLE.BIN']);
      const entries = fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((e) => {
          if (!e.isDirectory()) return false;
          if (BLOCK.has(e.name)) return false;
          if (e.name.startsWith('$')) return false; // $MfeDeepRem、$RECYCLE.BIN 等系统目录
          return true;
        })
        .map((e) => {
          const full = path.join(abs, e.name);
          return {
            name: e.name,
            path: full,
            hidden: e.name.startsWith('.'),
            hasConfig: fs.existsSync(path.join(full, 'gaal.yaml')),
          };
        })
        .sort(
          (a, b) =>
            Number(b.hasConfig) - Number(a.hasConfig) ||
            Number(b.name.toLowerCase() === 'projects') - Number(a.name.toLowerCase() === 'projects') ||
            a.name.localeCompare(b.name),
        );
      const parent = path.dirname(abs);
      const isRoot = parent === abs;
      // 盘符快捷切换行：始终提供；位于盘根时 parent 为 null
      send(res, 200, {
        current: abs,
        parent: isRoot ? null : parent,
        drives: listDrives(),
        recent: state.recentDirs,
        entries,
      });
    } catch (e) {
      fail(res, 400, e.message);
    }
  },

  'POST /api/sync': async (req, res) => {
    const body = await readBody(req);
    if (state.syncBusy) return fail(res, 409, '已有同步在进行中，请稍候');
    state.syncBusy = true;
    try {
      const r = await gaal.sync({
        cwd: state.projectDir,
        dryRun: !!body.dryRun,
        prune: !!body.prune,
        force: !!body.force,
      });
      state.lastSync = { ...r, at: new Date().toISOString(), opts: body };
      // gaal sync 退出码（实测）：0 = 成功（含带警告的同步），1 = completed with errors（真失败）
      send(res, 200, { ok: r.code === 0, output: r.stdout, stderr: r.stderr, code: r.code, args: r.args });
    } finally {
      state.syncBusy = false;
    }
  },

  /** 流式同步：SSE 实时推送 gaal 输出，最后发 done 事件 */
  'POST /api/sync/stream': async (req, res) => {
    const body = await readBody(req);
    if (state.syncBusy) return fail(res, 409, '已有同步在进行中，请稍候');
    state.syncBusy = true;
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      let clientGone = false;
      res.on('close', () => {
        clientGone = true;
      });
      const emit = (event, data) => {
        if (clientGone) return;
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          clientGone = true;
        }
      };
      const args = ['sync'];
      if (body.dryRun) args.push('--dry-run');
      if (body.prune) args.push('--prune');
      if (body.force) args.push('--force');
      emit('start', { args });
      const r = await gaal.syncStream(
        { cwd: state.projectDir, dryRun: !!body.dryRun, prune: !!body.prune, force: !!body.force },
        (text) => emit('output', { text }),
      );
      state.lastSync = { ...r, args, at: new Date().toISOString(), opts: body };
      emit('done', { ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, args });
      res.end();
    } finally {
      state.syncBusy = false;
    }
  },

  /** 轻量状态签名：前端轮询检测其他窗口/定时任务造成的数据变化 */
  'GET /api/state': async (req, res) => {
    let configMtime = null;
    try {
      const p = conf.configPath(state.projectDir);
      if (fs.existsSync(p)) configMtime = fs.statSync(p).mtimeMs;
    } catch {
      /* ignore */
    }
    send(res, 200, {
      projectDir: state.projectDir,
      lastSyncAt: (state.lastSync && state.lastSync.at) || null,
      scheduleLastRun: state.schedule.lastRun,
      configMtime,
    });
  },

  'GET /api/sync/last': async (req, res) => {
    send(res, 200, state.lastSync || { none: true });
  },

  'POST /api/doctor': async (req, res) => {
    const r = await gaal.doctor(state.projectDir);
    send(res, 200, { output: r.stdout, stderr: r.stderr, code: r.code });
  },

  'GET /api/schedule': async (req, res) => {
    send(res, 200, {
      enabled: state.schedule.enabled,
      intervalMin: state.schedule.intervalMin,
      lastRun: state.schedule.lastRun,
      lastResult: state.schedule.lastResult,
    });
  },

  'POST /api/schedule': async (req, res) => {
    const body = await readBody(req);
    state.schedule.enabled = !!body.enabled;
    if (body.intervalMin) state.schedule.intervalMin = Math.max(1, Number(body.intervalMin) || 60);
    saveSchedulePrefs();
    applySchedule();
    send(res, 200, { ok: true, enabled: state.schedule.enabled, intervalMin: state.schedule.intervalMin });
  },

  /** 把已扫描到的全局 skill 绑定到当前项目（写入项目 gaal.yaml，global:false） */
  'POST /api/deploy/skill': async (req, res) => {
    const body = await readBody(req);
    if (!body.source) return fail(res, 400, 'source required');
    // 防护：源已被禁用（移入备份区）时提前拦截，否则 gaal sync 会静默失败（exit=0 但不安装）
    if (!fs.existsSync(body.source)) {
      return fail(res, 400, `源 skill 目录不存在：${body.source}（可能已被全局禁用并移入备份区，请到 Skills 页重新启用后再部署）`);
    }
    const skill = {
      source: body.source,
      agents: body.agents && body.agents.length ? body.agents : ['*'],
      global: false,
    };
    if (body.select && body.select.length) skill.select = body.select;
    const r = conf.addSkill(state.projectDir, skill);
    send(res, 200, { ok: true, path: r.path, skill });
  },

  'DELETE /api/deploy/skill': async (req, res) => {
    const body = await readBody(req);
    const r = conf.removeSkill(state.projectDir, body.source);
    send(res, 200, { ok: true, path: r.path });
  },

  /** 把 MCP 部署到项目级 */
  'POST /api/deploy/mcp': async (req, res) => {
    const body = await readBody(req);
    if (!body.name) return fail(res, 400, 'name required');
    const mcp = {
      name: body.name,
      agents: body.agents && body.agents.length ? body.agents : ['*'],
      global: false,
    };
    if (body.inline) mcp.inline = normalizeInline(body.inline);
    if (body.source) mcp.source = body.source;
    if (!mcp.inline && !mcp.source) return fail(res, 400, 'inline or source required');
    const r = conf.addMcp(state.projectDir, mcp);
    send(res, 200, { ok: true, path: r.path, mcp });
  },

  'DELETE /api/deploy/mcp': async (req, res) => {
    const body = await readBody(req);
    const r = conf.removeMcp(state.projectDir, body.name);
    send(res, 200, { ok: true, path: r.path });
  },

  /* ───────── 部署预览（dryRun 计算 diff，不写盘） ───────── */

  'POST /api/preview/skill': async (req, res) => {
    const body = await readBody(req);
    if (!body.source) return fail(res, 400, 'source required');
    if (!fs.existsSync(body.source)) {
      return fail(res, 400, `源 skill 目录不存在：${body.source}（可能已被全局禁用并移入备份区，请到 Skills 页重新启用后再部署）`);
    }
    const skill = {
      source: body.source,
      agents: body.agents && body.agents.length ? body.agents : ['*'],
      global: false,
    };
    if (body.select && body.select.length) skill.select = body.select;
    const file = conf.configPath(state.projectDir);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const r = conf.upsertListItem(file, 'skills', (s) => s && s.source === skill.source, skill, { dryRun: true });
    send(res, 200, { exists: fs.existsSync(file), replaced: r.replaced, diff: lineDiff(before, r.text) });
  },

  'POST /api/preview/mcp': async (req, res) => {
    const body = await readBody(req);
    if (!body.name) return fail(res, 400, 'name required');
    const mcp = {
      name: body.name,
      agents: body.agents && body.agents.length ? body.agents : ['*'],
      global: false,
    };
    if (body.inline) mcp.inline = normalizeInline(body.inline);
    if (body.source) mcp.source = body.source;
    if (!mcp.inline && !mcp.source) return fail(res, 400, 'inline or source required');
    const file = conf.configPath(state.projectDir);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const r = conf.upsertListItem(file, 'mcps', (m) => m && m.name === mcp.name, mcp, { dryRun: true });
    send(res, 200, { exists: fs.existsSync(file), replaced: r.replaced, diff: lineDiff(before, r.text) });
  },

  'POST /api/preview/remove-skill': async (req, res) => {
    const body = await readBody(req);
    if (!body.source) return fail(res, 400, 'source required');
    const file = conf.configPath(state.projectDir);
    if (!fs.existsSync(file)) return send(res, 200, { removed: 0, diff: null });
    const before = fs.readFileSync(file, 'utf8');
    const r = conf.removeListItems(file, 'skills', (s) => s && s.source === body.source, { dryRun: true });
    send(res, 200, { removed: r.removed.length, diff: lineDiff(before, r.text) });
  },

  'POST /api/preview/remove-mcp': async (req, res) => {
    const body = await readBody(req);
    if (!body.name) return fail(res, 400, 'name required');
    const file = conf.configPath(state.projectDir);
    if (!fs.existsSync(file)) return send(res, 200, { removed: 0, diff: null });
    const before = fs.readFileSync(file, 'utf8');
    const r = conf.removeListItems(file, 'mcps', (m) => m && m.name === body.name, { dryRun: true });
    send(res, 200, { removed: r.removed.length, diff: lineDiff(before, r.text) });
  },

  /* ───────── 提升到全局（写入用户级 ~/.config/gaal/config.yaml） ───────── */

  'POST /api/promote/skill': async (req, res) => {
    const body = await readBody(req);
    if (!body.source) return fail(res, 400, 'source required');
    if (!fs.existsSync(body.source)) {
      return fail(res, 400, `源 skill 目录不存在：${body.source}（可能已被禁用并移入备份区，请先到 Skills 页启用）`);
    }
    const skill = {
      source: body.source,
      agents: body.agents && body.agents.length ? body.agents : ['*'],
      global: true,
    };
    const r = conf.addSkillToFile(conf.USER_CONFIG, skill);
    let removedFrom = null;
    let warning = null;
    if (body.removeFromProject) {
      const rm = conf.removeSkillFromFile(conf.configPath(state.projectDir), body.source);
      if (rm.removed.length) {
        removedFrom = rm.path;
      } else {
        warning = '项目 gaal.yaml 中未找到与该 source 完全一致的声明（可能以简写或相对路径记录），请手动确认';
      }
    }
    send(res, 200, { ok: true, path: r.path, skill, removedFrom, warning });
  },

  'POST /api/promote/mcp': async (req, res) => {
    const body = await readBody(req);
    if (!body.name) return fail(res, 400, 'name required');
    const mcp = {
      name: body.name,
      agents: body.agents && body.agents.length ? body.agents : ['*'],
      global: true,
    };
    if (body.inline) mcp.inline = normalizeInline(body.inline);
    if (body.source) mcp.source = body.source;
    if (!mcp.inline && !mcp.source) return fail(res, 400, 'inline or source required');
    const r = conf.addMcpToFile(conf.USER_CONFIG, mcp);
    let removedFrom = null;
    let warning = null;
    if (body.removeFromProject) {
      const rm = conf.removeMcpFromFile(conf.configPath(state.projectDir), body.name);
      if (rm.removed.length) {
        removedFrom = rm.path;
      } else {
        warning = '项目 gaal.yaml 中未找到同名 MCP 声明，请手动确认';
      }
    }
    send(res, 200, { ok: true, path: r.path, mcp, removedFrom, warning });
  },

  /* ───────── 开关（启用 / 禁用） ───────── */

  'POST /api/toggle/skill': async (req, res) => {
    const body = await readBody(req);
    if (!body.agent || !body.skillPath) return fail(res, 400, 'agent 和 skillPath 必填');
    try {
      const r = toggle.toggleSkill({
        agent: body.agent,
        skillPath: body.skillPath,
        enabled: !!body.enabled,
        projectDir: state.projectDir,
        userConfig: conf.USER_CONFIG,
      });
      send(res, 200, r);
    } catch (e) {
      fail(res, 400, e.message);
    }
  },

  'POST /api/toggle/mcp': async (req, res) => {
    const body = await readBody(req);
    if (!body.agent || !body.name || !body.file) return fail(res, 400, 'agent、name、file 必填');
    try {
      const r = toggle.toggleMcp({
        agent: body.agent,
        name: body.name,
        scope: body.scope || 'global',
        file: body.file,
        enabled: !!body.enabled,
        projectDir: state.projectDir,
        userConfig: conf.USER_CONFIG,
      });
      send(res, 200, r);
    } catch (e) {
      fail(res, 400, e.message);
    }
  },

  /** 已禁用清单 */
  'GET /api/disabled': async (req, res) => {
    send(res, 200, toggle.disabledList());
  },

  /** 从 GitHub URL 导入 skill */
  'POST /api/import/github': async (req, res) => {
    const body = await readBody(req);
    const parsed = registry.parseGitHub(body.input);
    if (!parsed) return fail(res, 400, '无法解析 GitHub 地址，请用 owner/repo 或完整 URL');
    let info = { skills: [], description: '', stars: 0, error: null };
    const cached = repoInfoCache.get(parsed.shorthand);
    if (cached && Date.now() - cached.at < REPO_INFO_TTL) {
      info = cached.info;
    } else {
      try {
        info = await registry.listRepoSkills(parsed.shorthand);
        repoInfoCache.set(parsed.shorthand, { at: Date.now(), info });
      } catch (e) {
        info.error = e.message;
      }
    }
    if (body.dryRun) {
      return send(res, 200, { ok: true, dryRun: true, detected: info });
    }
    const skill = { source: parsed.shorthand, agents: body.agents && body.agents.length ? body.agents : ['*'], global: false };
    const r = conf.addSkill(state.projectDir, skill);
    send(res, 200, { ok: true, path: r.path, skill, detected: info });
  },

  /** registry 搜索 */
  'GET /api/registry/search': async (req, res, url) => {
    const kw = url.searchParams.get('q') || '';
    if (!kw) return fail(res, 400, 'q required');
    const r = await registry.registrySearch(kw);
    send(res, 200, { ok: r.ok, output: r.stdout, stderr: r.stderr });
  },
};

/* ───────────── HTTP 服务 ───────────── */

const server = http.createServer(async (req, res) => {
  if (HOST_IS_LOOPBACK && !hostAllowed(req.headers.host)) {
    return fail(res, 403, '拒绝访问：Host 头不在允许列表（DNS rebinding 防护）');
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    const handler = routes[key];
    if (handler) return await handler(req, res, url);

    if (url.pathname.startsWith('/api/')) return fail(res, 404, `no route: ${key}`);

    // 静态文件（startsWith 需带路径分隔符，防止误匹配 public* 兄弟目录）
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const abs = path.join(PUBLIC_DIR, path.normalize(file));
    if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, 'forbidden');
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      return res.end(fs.readFileSync(abs));
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});

loadSchedulePrefs();
applySchedule();

/* 作为主进程运行时才监听端口；被测试 require 时由测试方自行 listen */
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`gaal-studio → http://${HOST}:${PORT}`);
    console.log(`gaal binary : ${gaal.GAAL_BIN}`);
    console.log(`project dir : ${state.projectDir}`);
    // 启动成功后自动打开面板（GAAL_STUDIO_NO_OPEN=1 关闭）
    if (process.platform === 'win32' && process.env.GAAL_STUDIO_NO_OPEN !== '1') {
      const openHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
      require('node:child_process')
        .spawn('cmd', ['/c', 'start', '', `http://${openHost}:${PORT}`], { detached: true, stdio: 'ignore', windowsHide: true })
        .unref();
    }
  });
}

module.exports = { server, state };
