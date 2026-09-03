'use strict';

/**
 * MCP 发现层：gaal audit 不解析 TOML / 部分 JSON 布局，
 * 这里直接读取各 agent 的 MCP 配置文件并统一提取 server 条目。
 *
 * 支持格式：
 *  - JSON: { mcpServers: {...} }（claude / trae / windsurf / kilo / zencoder / augment / continue）
 *  - JSON: { mcp: {...} }（opencode）
 *  - JSON: { "mcp.servers": {...} }（VS Code 系：copilot / cline / roo）
 *  - TOML: [mcp_servers.name]（codex）
 *  - YAML: mcpServers: {...}（goose）
 */

const fs = require('node:fs');
const path = require('node:path');
const toml = require('@iarna/toml');
const yaml = require('js-yaml');

/** 从 server 定义对象里提取摘要 */
function summarizeServer(name, def, agent, scope, file) {
  const d = def && typeof def === 'object' ? def : {};
  const type = d.url || d.serverUrl || d.httpUrl
    ? (d.type || 'http')
    : d.command
      ? (d.type || 'stdio')
      : 'unknown';
  return {
    name,
    agent,
    scope, // global | project
    file,
    type,
    command: d.command || null,
    args: Array.isArray(d.args) ? d.args : null,
    url: d.url || d.serverUrl || d.httpUrl || null,
    env: d.env ? Object.keys(d.env) : null,
    enabled: d.enabled !== false && d.enable !== false,
    raw: d,
  };
}

function parseJsonMcp(text, agent, scope, file) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  const push = (block) => {
    if (block && typeof block === 'object') {
      for (const [name, def] of Object.entries(block)) {
        out.push(summarizeServer(name, def, agent, scope, file));
      }
    }
  };
  // { mcpServers: {...} }  —— claude / trae / windsurf 等
  push(j.mcpServers);
  // { "mcp.servers": {...} }  —— 扁平键（VS Code 系可能）
  push(j['mcp.servers']);
  // { mcp: { servers: {...} } }  —— zcode 嵌套结构
  if (j.mcp && typeof j.mcp === 'object') {
    if (j.mcp.servers && typeof j.mcp.servers === 'object') push(j.mcp.servers);
    else push(j.mcp); // { mcp: { name: def } }  —— opencode
  }
  return out;
}

function parseTomlMcp(text, agent, scope, file) {
  let j;
  try {
    j = toml.parse(text);
  } catch {
    return [];
  }
  const out = [];
  const block = j.mcp_servers || j.mcpServers;
  if (block && typeof block === 'object') {
    for (const [name, def] of Object.entries(block)) {
      out.push(summarizeServer(name, def, agent, scope, file));
    }
  }
  return out;
}

function parseYamlMcp(text, agent, scope, file) {
  let j;
  try {
    j = yaml.load(text);
  } catch {
    return [];
  }
  const out = [];
  const block = j && (j.mcpServers || j.mcp_servers);
  if (block && typeof block === 'object') {
    for (const [name, def] of Object.entries(block)) {
      out.push(summarizeServer(name, def, agent, scope, file));
    }
  }
  return out;
}

function parseFile(file, agent, scope) {
  if (!file || !fs.existsSync(file)) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (!text.trim()) return [];
  const ext = path.extname(file).toLowerCase();
  if (ext === '.toml') return parseTomlMcp(text, agent, scope, file);
  if (ext === '.yaml' || ext === '.yml') return parseYamlMcp(text, agent, scope, file);
  return parseJsonMcp(text, agent, scope, file);
}

/**
 * 扫描所有 agent 的全局 + 项目级 MCP 配置。
 * @param {Array} agents  gaal agents -o json 的 agents 数组
 * @param {string} projectDir 当前项目目录（扫描 project 级配置）
 */
function discoverMcps(agents, projectDir) {
  const results = [];
  // 按文件+名称去重：同一配置文件可能被 agent 注册表和下方兜底清单各扫一次，
  // 以先扫描到的（gaal 正式 agent）为准
  const seen = new Set();
  const collect = (m) => {
    const key = `${m.file}|${m.name}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push(m);
  };

  for (const a of agents) {
    // 全局
    if (a.global_mcp_config_file) {
      for (const m of parseFile(a.global_mcp_config_file, a.name, 'global')) collect(m);
    }
    // 项目级
    if (a.project_mcp_config_file && projectDir) {
      const pf = path.isAbsolute(a.project_mcp_config_file)
        ? a.project_mcp_config_file
        : path.join(projectDir, a.project_mcp_config_file);
      for (const m of parseFile(pf, a.name, 'project')) collect(m);
    }
  }

  // 额外兜底：常见位置（gaal registry 里 project_mcp_config_file 缺省时）
  if (projectDir) {
    const extras = [
      [path.join(projectDir, '.mcp.json'), 'claude-code'],
      [path.join(projectDir, '.vscode', 'mcp.json'), 'github-copilot'],
      [path.join(projectDir, '.cursor', 'mcp.json'), 'cursor'],
      [path.join(projectDir, '.trae', 'mcp.json'), 'trae'],
    ];
    for (const [f, agent] of extras) {
      for (const m of parseFile(f, agent, 'project')) collect(m);
    }
  }

  return results.sort((x, y) => x.agent.localeCompare(y.agent) || x.name.localeCompare(y.name));
}

module.exports = { discoverMcps, parseFile, parseTomlMcp, parseJsonMcp, parseYamlMcp };
