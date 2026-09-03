'use strict';

/**
 * 开关层：skills / MCP 的启用与禁用（可逆）。
 *
 * Skills（gaal 语义 = 声明式，无 enabled 字段）：
 *   禁用 = 把 skill 目录移动到备份区 + 从 gaal.yaml 移除声明并记录
 *   启用 = 移回原位 + 恢复声明
 *
 * MCP：
 *   软开关（agent 配置支持 enabled/enable 字段，如 codex / zcode）= 直接改字段
 *   硬开关（claude mcp.json 等不支持字段的）= 从配置文件移除条目并备份 + 移除 gaal.yaml 声明
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const conf = require('./config');
const { writeFileAtomic } = require('./atomic');

const STORE_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'gaal-studio',
);
const STORE_FILE = path.join(STORE_DIR, 'disabled.json');
const SKILL_BACKUP_DIR = path.join(STORE_DIR, 'disabled-skills');

/** 配置文件中已有或支持 enabled/enable 字段的 agent（软开关） */
const SOFT_AGENTS = new Set(['codex', 'zcode']);

/* ───────────── disabled store ───────────── */

function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { skills: j.skills || {}, mcps: j.mcps || {} };
  } catch {
    return { skills: {}, mcps: {} };
  }
}

function saveStore(s) {
  writeFileAtomic(STORE_FILE, JSON.stringify(s, null, 2));
}

function shortHash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/* ───────────── gaal.yaml 声明的移除 / 恢复 ───────────── */

/** source 是否为路径形态（相对/绝对），而非 owner/repo 仓库简写 */
function isPathLike(source) {
  const s = String(source);
  return (
    path.isAbsolute(s) ||
    /^[a-z]:[\\/]/i.test(s) ||
    s.startsWith('~') ||
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('.\\') ||
    s.startsWith('..\\')
  );
}

/**
 * 依据 skill 安装位置决定声明所在的 gaal.yaml：
 * 项目内 → 项目级配置，否则 → 用户级配置（global:true 装用户目录，global:false 装项目目录）。
 */
function skillConfigFiles(abs, projectDir, userConfig) {
  const projRoot = projectDir ? path.resolve(projectDir) : null;
  const inProject = !!(projRoot && (abs === projRoot || abs.startsWith(projRoot + path.sep)));
  const projFile = projRoot ? path.join(projRoot, 'gaal.yaml') : null;
  const file = inProject ? projFile : userConfig;
  return { files: file && fs.existsSync(file) ? [file] : [], inProject };
}

/** MCP 声明按 scope 选择 gaal.yaml：project → 项目级，global → 用户级 */
function mcpConfigFiles(scope, projectDir, userConfig) {
  const projFile = projectDir ? path.join(path.resolve(projectDir), 'gaal.yaml') : null;
  const file = scope === 'project' ? projFile : userConfig;
  return file && fs.existsSync(file) ? [file] : [];
}

/**
 * 找到与 skill 目录关联的 skills 声明并移除，返回 [{file, entry}]。
 * 匹配规则：
 *   1) source 归一化后与目录完整路径一致 → 无条件命中；
 *   2) 绝对路径 source 只按完整路径匹配（避免误删其他同名目录的声明）；
 *   3) 简写/相对 source 按末段目录名匹配，且仅限同一作用域
 *      （global:true 装在用户目录，global:false 装在项目目录）。
 */
function removeSkillDeclarations(skillAbs, inProject, files) {
  const name = path.basename(skillAbs).toLowerCase();
  const norm = skillAbs.replace(/\\/g, '/').toLowerCase();
  const removed = [];
  for (const f of files) {
    const match = (s) => {
      if (!s || !s.source) return false;
      const src = String(s.source).replace(/\\/g, '/');
      if (src.toLowerCase() === norm) return true;
      if (path.isAbsolute(String(s.source)) || /^[a-z]:[\\/]/i.test(String(s.source))) return false;
      if (inProject === (s.global === true)) return false;
      const last = (src.split('/').filter(Boolean).pop() || '').toLowerCase();
      return !!last && last === name;
    };
    for (const entry of conf.removeListItems(f, 'skills', match).removed) {
      removed.push({ file: f, entry });
    }
  }
  return removed;
}

/** 找到与 MCP 名称关联的 mcps 声明并移除 */
function removeMcpDeclarations(name, files) {
  const removed = [];
  for (const f of files) {
    for (const entry of conf.removeListItems(f, 'mcps', (m) => m && m.name === name).removed) {
      removed.push({ file: f, entry });
    }
  }
  return removed;
}

function restoreDeclarations(listKey, decls) {
  for (const d of decls || []) {
    try {
      const match =
        listKey === 'skills'
          ? (s) => s && s.source === d.entry.source
          : (m) => m && m.name === d.entry.name;
      conf.upsertListItem(d.file, listKey, match, d.entry);
    } catch {
      /* 文件可能已被移动，忽略 */
    }
  }
}

/* ───────────── Skills 开关 ───────────── */

/**
 * @param {{agent:string, skillPath:string, enabled:boolean, projectDir?:string, userConfig?:string}} p
 */
function toggleSkill(p) {
  const store = loadStore();
  const abs = path.resolve(p.skillPath);
  const key = `${p.agent}|${abs}`.toLowerCase();

  if (!p.enabled) {
    if (store.skills[key]) return { ok: true, alreadyDisabled: true };
    if (!fs.existsSync(abs)) throw new Error(`目录不存在: ${abs}`);
    const dirName = path.basename(abs);
    let mode, backup = null, linkTarget = null;

    // 符号链接（Trae / Zencoder 常见）：只删链接本身，记录目标以便重建
    let st = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = null;
    }
    if (st && st.isSymbolicLink()) {
      linkTarget = fs.readlinkSync(abs);
      fs.unlinkSync(abs);
      mode = 'unlink-link';
    } else {
      backup = path.join(SKILL_BACKUP_DIR, p.agent, `${dirName}-${shortHash(abs)}`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.cpSync(abs, backup, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(abs, { recursive: true, force: true });
      mode = 'move';
    }

    const { files, inProject } = skillConfigFiles(abs, p.projectDir, p.userConfig);
    const declarations = removeSkillDeclarations(abs, inProject, files);
    store.skills[key] = {
      agent: p.agent,
      name: dirName,
      original: abs,
      backup,
      link_target: linkTarget,
      declarations,
      at: new Date().toISOString(),
    };
    saveStore(store);
    return { ok: true, enabled: false, mode, backup, link_target: linkTarget, declarationsRemoved: declarations.length };
  }

  const rec = store.skills[key];
  if (fs.existsSync(abs)) {
    if (!rec) return { ok: true, alreadyEnabled: true };
    // 目录已被手动重建：只恢复声明并清除禁用记录，否则声明式 agent 仍然看不到它
    restoreDeclarations('skills', rec.declarations);
    delete store.skills[key];
    saveStore(store);
    return { ok: true, enabled: true, mode: 'declarations-restored' };
  }
  if (!rec) throw new Error('未找到该 skill 的禁用记录，无法启用');
  fs.mkdirSync(path.dirname(rec.original), { recursive: true });
  if (rec.link_target) {
    // 用 junction 重建目录链接（Windows 下无需管理员权限）
    fs.symlinkSync(rec.link_target, rec.original, 'junction');
  } else {
    if (!rec.backup || !fs.existsSync(rec.backup)) throw new Error('备份已丢失，无法恢复');
    fs.cpSync(rec.backup, rec.original, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(rec.backup, { recursive: true, force: true });
  }
  restoreDeclarations('skills', rec.declarations);
  delete store.skills[key];
  saveStore(store);
  return { ok: true, enabled: true, mode: 'restore' };
}

/* ───────────── MCP 开关 ───────────── */

/** TOML 文本级修改 enabled 字段，保留注释与原有换行风格 */
function setTomlEnabled(file, name, enabled) {
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sec = `[mcp_servers.${name}]`;
  const si = lines.findIndex((l) => l.trim() === sec);
  if (si < 0) throw new Error(`未找到配置节: ${sec}`);
  let ei = -1;
  for (let i = si + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('[')) break;
    if (/^enabled\s*=/.test(t)) {
      ei = i;
      break;
    }
  }
  if (ei >= 0) lines[ei] = `enabled = ${enabled}`;
  else lines.splice(si + 1, 0, `enabled = ${enabled}`);
  writeFileAtomic(file, lines.join(eol));
}

/**
 * 找到 JSON 里的 MCP 容器块，返回 [{ path, block }]。
 * path 为容器的键路径（'mcpServers' | 'mcp.servers' | 'mcp'），供恢复时定位。
 */
function findJsonBlocks(obj) {
  const out = [];
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    out.push({ path: 'mcpServers', block: obj.mcpServers });
  }
  if (obj['mcp.servers'] && typeof obj['mcp.servers'] === 'object') {
    out.push({ path: 'mcp.servers', block: obj['mcp.servers'] });
  }
  if (obj.mcp && typeof obj.mcp === 'object' && !Array.isArray(obj.mcp)) {
    if (obj.mcp.servers && typeof obj.mcp.servers === 'object') out.push({ path: 'mcp.servers', block: obj.mcp.servers });
    else out.push({ path: 'mcp', block: obj.mcp });
  }
  return out;
}

/** 按 findJsonBlocks 记录的键路径取出（或创建）容器块 */
function jsonContainer(obj, p) {
  if (p === 'mcpServers') {
    if (!obj.mcpServers || typeof obj.mcpServers !== 'object' || Array.isArray(obj.mcpServers)) obj.mcpServers = {};
    return obj.mcpServers;
  }
  if (p === 'mcp') {
    if (!obj.mcp || typeof obj.mcp !== 'object' || Array.isArray(obj.mcp)) obj.mcp = {};
    return obj.mcp;
  }
  if (p === 'mcp.servers') {
    // 与发现层读取顺序一致：嵌套 mcp.servers 优先，其次扁平键 "mcp.servers"
    if (obj.mcp && typeof obj.mcp === 'object' && !Array.isArray(obj.mcp) && obj.mcp.servers && typeof obj.mcp.servers === 'object') {
      return obj.mcp.servers;
    }
    if (obj['mcp.servers'] && typeof obj['mcp.servers'] === 'object') return obj['mcp.servers'];
    if (!obj.mcp || typeof obj.mcp !== 'object' || Array.isArray(obj.mcp)) obj.mcp = {};
    if (!obj.mcp.servers || typeof obj.mcp.servers !== 'object') obj.mcp.servers = {};
    return obj.mcp.servers;
  }
  return null;
}

/**
 * @param {{agent:string, name:string, scope:string, enabled:boolean, file:string, projectDir?:string, userConfig?:string}} p
 */
function toggleMcp(p) {
  const { file, name } = p;
  if (!file || !fs.existsSync(file)) throw new Error('MCP 配置文件不存在');
  const ext = path.extname(file).toLowerCase();
  const store = loadStore();
  const key = `${p.agent}|${p.scope}|${name}`.toLowerCase();
  const files = mcpConfigFiles(p.scope, p.projectDir, p.userConfig);

  if (ext === '.toml') {
    setTomlEnabled(file, name, p.enabled);
    return { ok: true, mode: 'soft', enabled: p.enabled, file };
  }
  if (ext === '.yaml' || ext === '.yml') {
    throw new Error('YAML 布局的 MCP 暂不支持开关，请手动编辑');
  }

  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blocks = findJsonBlocks(obj);
  const found = blocks.find((b) => b.block && b.block[name]) || null;
  const block = found ? found.block : null;
  const softCapable = SOFT_AGENTS.has(p.agent);

  if (!p.enabled) {
    if (!block) {
      if (store.mcps[key]) return { ok: true, alreadyDisabled: true };
      throw new Error(`配置中未找到 MCP: ${name}`);
    }
    const entry = block[name];
    if (softCapable || 'enabled' in entry || 'enable' in entry) {
      const field = 'enable' in entry ? 'enable' : 'enabled';
      entry[field] = false;
      writeFileAtomic(file, JSON.stringify(obj, null, 2));
      return { ok: true, mode: 'soft', enabled: false, file };
    }
    // 硬开关：移除条目并备份（记录容器键路径，恢复时写回原容器）
    delete block[name];
    writeFileAtomic(file, JSON.stringify(obj, null, 2));
    const declarations = removeMcpDeclarations(name, files);
    store.mcps[key] = {
      agent: p.agent,
      scope: p.scope,
      name,
      file,
      blockKey: found.path,
      entry,
      declarations,
      at: new Date().toISOString(),
    };
    saveStore(store);
    return { ok: true, mode: 'hard', enabled: false, file, declarationsRemoved: declarations.length };
  }

  // 启用
  if (block) {
    const entry = block[name];
    const field = 'enable' in entry ? 'enable' : 'enabled';
    if (softCapable || field in entry) {
      entry[field] = true;
      writeFileAtomic(file, JSON.stringify(obj, null, 2));
      return { ok: true, mode: 'soft', enabled: true, file };
    }
    return { ok: true, alreadyEnabled: true };
  }
  const rec = store.mcps[key];
  if (!rec) throw new Error('未找到该 MCP 的禁用记录，无法启用');
  const o2 = JSON.parse(fs.readFileSync(rec.file, 'utf8'));
  const container = jsonContainer(o2, rec.blockKey) || findJsonBlocks(o2)[0]?.block || (o2.mcpServers = {});
  container[name] = rec.entry;
  writeFileAtomic(rec.file, JSON.stringify(o2, null, 2));
  restoreDeclarations('mcps', rec.declarations);
  delete store.mcps[key];
  saveStore(store);
  return { ok: true, mode: 'restore', enabled: true, file: rec.file };
}

/** 列出所有被禁用的项（供前端展示） */
function disabledList() {
  const s = loadStore();
  return {
    skills: Object.entries(s.skills).map(([k, v]) => ({ key: k, ...v })),
    mcps: Object.entries(s.mcps).map(([k, v]) => ({ key: k, ...v })),
  };
}

module.exports = { toggleSkill, toggleMcp, disabledList, loadStore };
