'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const yaml = require('js-yaml');
const { writeFileAtomic } = require('./atomic');

const USER_CONFIG = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'gaal',
  'config.yaml',
);

function configPath(projectDir) {
  return path.join(projectDir, 'gaal.yaml');
}

function readConfig(projectDir) {
  const p = configPath(projectDir);
  if (!fs.existsSync(p)) {
    return { exists: false, path: p, text: defaultTemplate(), data: null };
  }
  const text = fs.readFileSync(p, 'utf8');
  let data = null;
  let parseError = null;
  try {
    data = yaml.load(text) || {};
  } catch (e) {
    parseError = e.message;
  }
  return { exists: true, path: p, text, data, parseError };
}

function writeConfig(projectDir, text) {
  // 写入前校验 YAML 合法性
  try {
    yaml.load(text);
  } catch (e) {
    const err = new Error(`YAML 校验失败: ${e.message}`);
    err.code = 'INVALID_YAML';
    throw err;
  }
  const p = configPath(projectDir);
  writeFileAtomic(p, text);
  return p;
}

/** 读取任意 gaal 配置文件（项目级或全局） */
function readFileConfig(file) {
  if (!fs.existsSync(file)) {
    return { exists: false, path: file, text: defaultTemplate(), data: null };
  }
  const text = fs.readFileSync(file, 'utf8');
  let data = null;
  let parseError = null;
  try {
    data = yaml.load(text) || {};
  } catch (e) {
    parseError = e.message;
  }
  return { exists: true, path: file, text, data, parseError };
}

/* ───────────── 注释保留的列表文本编辑 ─────────────
 * gaal.yaml 通常由用户手工维护，yaml.dump 整体重写会清掉注释。
 * 增删条目时优先做"文本级"定点修改，改完重新解析并与预期数据比对；
 * 任何一步不符（流式写法、锚点、缩进为 0 的条目等）则回退整体重写，
 * 正确性优先于注释保留。
 */

function dumpData(data) {
  return yaml.dump(data, { lineWidth: 120, noRefs: true, sortKeys: false });
}

function normList(v) {
  return Array.isArray(v) ? v : [];
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** 找到顶层键所在行及其列表体结束行（不含）；找不到返回 null */
function findTopLevelKey(lines, key) {
  const re = new RegExp(`^${key}:`);
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() && !l.trim().startsWith('#') && /^\S/.test(l)) {
        end = j;
        break;
      }
    }
    return { keyLine: i, bodyEnd: end };
  }
  return null;
}

/** 列表体中首个条目的缩进（空格数）；无块级条目返回 null */
function firstItemIndent(lines, keyLine, bodyEnd) {
  for (let i = keyLine + 1; i < bodyEnd; i++) {
    const m = lines[i].match(/^(\s+)-(\s|$)/);
    if (m) return m[1].length;
  }
  return null;
}

/** 条目行区间 [{start, end}]（end exclusive），尾部空行/注释不计入条目 */
function entrySpans(lines, keyLine, bodyEnd, indent) {
  const itemRe = new RegExp(`^${' '.repeat(indent)}-(\\s|$)`);
  const spans = [];
  let cur = null;
  for (let i = keyLine + 1; i < bodyEnd; i++) {
    if (itemRe.test(lines[i])) {
      if (cur) {
        cur.end = i;
        spans.push(cur);
      }
      cur = { start: i, end: bodyEnd };
    }
  }
  if (cur) spans.push(cur);
  for (const sp of spans) {
    while (sp.end > sp.start) {
      const t = lines[sp.end - 1].trim();
      if (!t || t.startsWith('#')) sp.end--;
      else break;
    }
  }
  return spans;
}

/** 解析某个条目行区间对应的对象 */
function entryObjectAt(lines, span, indent) {
  const text = lines.slice(span.start, span.end).map((l) => l.slice(indent)).join('\n');
  const parsed = yaml.load(text);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

/** 把一个条目对象渲染为缩进后的行数组 */
function itemLines(entry, indent) {
  return yaml
    .dump([entry], { lineWidth: 120, noRefs: true, sortKeys: false })
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => (l ? ' '.repeat(indent) + l : l));
}

/**
 * 从文件顶层列表 key 中删除匹配条目。文本级定点删除以保留注释，
 * 校验不过则回退整体重写。
 * @param {{dryRun?: boolean}} opts dryRun 为 true 时不写盘，返回 { removed, text } 供预览
 * @returns {{removed: Array, text: string|null}} removed 为实际命中的条目；text 为计算后的完整文本
 */
function removeListItems(file, key, matchFn, opts = {}) {
  const cfg = readFileConfig(file);
  if (!cfg.exists || !cfg.data || typeof cfg.data !== 'object' || !Array.isArray(cfg.data[key])) {
    return { removed: [], text: null };
  }
  const list = cfg.data[key];
  const removed = list.filter(matchFn);
  if (!removed.length) return { removed: [], text: cfg.text };
  const kept = list.filter((x) => !matchFn(x));
  const data = JSON.parse(JSON.stringify(cfg.data));
  data[key] = kept;

  let done = false;
  let finalText = null;
  try {
    const eol = eolOf(cfg.text);
    const lines = cfg.text.split(/\r?\n/);
    const loc = findTopLevelKey(lines, key);
    const indent = loc && firstItemIndent(lines, loc.keyLine, loc.bodyEnd);
    if (loc && indent != null) {
      const drop = new Set();
      let matched = 0;
      for (const sp of entrySpans(lines, loc.keyLine, loc.bodyEnd, indent)) {
        if (matchFn(entryObjectAt(lines, sp, indent))) {
          matched++;
          for (let i = sp.start; i < sp.end; i++) drop.add(i);
        }
      }
      if (matched === removed.length) {
        const text = lines.filter((_, i) => !drop.has(i)).join(eol);
        const check = yaml.load(text);
        if (JSON.stringify(normList((check || {})[key])) === JSON.stringify(kept)) {
          finalText = text;
          done = true;
        }
      }
    }
  } catch {
    /* 回退 */
  }
  if (!done) {
    finalText = dumpData(data);
  }
  if (!opts.dryRun) {
    writeFileAtomic(file, finalText);
  }
  return { removed, text: finalText };
}

/**
 * 在顶层列表 key 中插入或原位替换条目（按 matchFn 定位）。
 * 文本级定点修改以保留注释，校验不过则回退整体重写。
 * @param {{dryRun?: boolean}} opts dryRun 为 true 时不写盘，返回 { replaced, text } 供预览
 * @returns {{path: string, replaced: boolean, text: string}}
 */
function upsertListItem(file, key, matchFn, entry, opts = {}) {
  const cfg = readFileConfig(file);
  const hasData = cfg.exists && cfg.data && typeof cfg.data === 'object' && !Array.isArray(cfg.data);
  const base = hasData ? JSON.parse(JSON.stringify(cfg.data)) : { schema: 1 };
  const list = normList(base[key]);
  const idx = list.findIndex(matchFn);
  const expected = [...list];
  if (idx >= 0) expected[idx] = entry;
  else expected.push(entry);
  base[key] = expected;

  let finalText = null;
  if (hasData) {
    try {
      const eol = eolOf(cfg.text);
      const lines = cfg.text.split(/\r?\n/);
      const loc = findTopLevelKey(lines, key);
      // 键行带流式值（如 skills: []）时无法定点编辑
      const inlineVal = loc ? lines[loc.keyLine].slice(key.length + 1).replace(/#.*$/, '').trim() : '';
      const iv = loc && !inlineVal ? firstItemIndent(lines, loc.keyLine, loc.bodyEnd) : null;
      const indent = iv != null ? iv : 2;
      if (loc && !inlineVal) {
        const spans = iv != null ? entrySpans(lines, loc.keyLine, loc.bodyEnd, indent) : [];
        const span = spans.find((sp) => matchFn(entryObjectAt(lines, sp, indent))) || null;
        const item = itemLines(entry, indent);
        if (span) {
          lines.splice(span.start, span.end - span.start, ...item); // 原位替换
        } else {
          const at = spans.length ? spans[spans.length - 1].end : loc.keyLine + 1; // 追加到最后一个条目后
          lines.splice(at, 0, ...item);
        }
        const text = lines.join(eol);
        const check = yaml.load(text);
        if (JSON.stringify(normList((check || {})[key])) === JSON.stringify(expected)) {
          finalText = text;
        }
      }
    } catch {
      /* 回退 */
    }
  }
  if (finalText == null) {
    finalText = dumpData(base);
  }
  if (!opts.dryRun) {
    writeFileAtomic(file, finalText);
  }
  return { path: file, replaced: idx >= 0, text: finalText };
}

/** 往任意配置文件写入 skill（按 source 匹配，存在则原位更新 agents 等字段） */
function addSkillToFile(file, skill) {
  return upsertListItem(file, 'skills', (s) => s && s.source === skill.source, skill);
}

/** 往任意配置文件写入 MCP（按 name 匹配，存在则原位更新） */
function addMcpToFile(file, mcp) {
  return upsertListItem(file, 'mcps', (m) => m && m.name === mcp.name, mcp);
}

/** 按精确 source 移除 skill 声明，返回 {path, removed} */
function removeSkillFromFile(file, source) {
  const { removed } = removeListItems(file, 'skills', (s) => s && s.source === source);
  return { path: file, removed };
}

/** 按名称移除 MCP 声明，返回 {path, removed} */
function removeMcpFromFile(file, name) {
  const { removed } = removeListItems(file, 'mcps', (m) => m && m.name === name);
  return { path: file, removed };
}

/** 往项目配置里写入一个 skill（upsert） */
function addSkill(projectDir, skill) {
  return addSkillToFile(configPath(projectDir), skill);
}

/** 往项目配置里写入一个 MCP（upsert） */
function addMcp(projectDir, mcp) {
  return addMcpToFile(configPath(projectDir), mcp);
}

function removeSkill(projectDir, source) {
  return removeSkillFromFile(configPath(projectDir), source);
}

function removeMcp(projectDir, name) {
  return removeMcpFromFile(configPath(projectDir), name);
}

function defaultTemplate() {
  return [
    'schema: 1',
    '',
    '# 代码仓库',
    'repositories: {}',
    '',
    '# AI 技能',
    'skills: []',
    '',
    '# 代理直接读取的内容',
    'content: []',
    '',
    '# MCP 服务器',
    'mcps: []',
    '',
  ].join('\n');
}

module.exports = {
  USER_CONFIG,
  configPath,
  readConfig,
  writeConfig,
  readFileConfig,
  removeListItems,
  upsertListItem,
  addSkillToFile,
  addMcpToFile,
  removeSkillFromFile,
  removeMcpFromFile,
  addSkill,
  addMcp,
  removeSkill,
  removeMcp,
  defaultTemplate,
};
