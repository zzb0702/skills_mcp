'use strict';

/**
 * Skills 发现层：扫描 gaal 未覆盖的 agent 的 skills 目录。
 * 一个 skill = <dir>/<name>/SKILL.md，解析 frontmatter 取 name/description。
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

/** 解析 SKILL.md 的 YAML frontmatter */
function parseSkillMd(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/^\uFEFF?---\s*\n([\s\S]*?)\n---/);
  if (!m) return { name: null, desc: '', parseError: null };
  let data = {};
  let parseError = null;
  try {
    data = yaml.load(m[1]) || {};
  } catch (e) {
    parseError = e.message;
  }
  return {
    name: data.name || null,
    desc: typeof data.description === 'string' ? data.description : '',
    parseError,
  };
}

function scanSkillsDir(dir, agent, scope) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // 注意：Trae / Zencoder 的 skills 常以符号链接（junction）形式存在，
    // Dirent.isDirectory() 对符号链接返回 false，需显式跟随。
    const isDir = e.isDirectory() || (e.isSymbolicLink() && isDirectorySafe(path.join(dir, e.name)));
    if (!isDir) continue;
    const skillDir = path.join(dir, e.name);
    const md = findSkillMd(skillDir);
    if (!md) continue;
    const parsed = parseSkillMd(md) || {};
    out.push({
      name: parsed.name || e.name,
      dir_name: e.name,
      agent,
      source: scope,
      desc: parsed.desc || '',
      path: path.resolve(skillDir).replace(/\\/g, '/'),
      link: e.isSymbolicLink() || null,
      parseError: parsed.parseError || null,
    });
  }
  return out;
}

/** 跟随符号链接判断是否为目录 */
function isDirectorySafe(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 查找 skill 描述文件（大小写兼容） */
function findSkillMd(skillDir) {
  for (const cand of ['SKILL.md', 'skill.md', 'Skill.md']) {
    const p = path.join(skillDir, cand);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 扫描 agent 的 skills（全局 + 项目级）。
 * @param {Array} agents 合并后的 agent 列表
 * @param {string} projectDir
 * @param {Set<string>} skipKeys 已存在的 `${agent}|${path}` 键，避免与 gaal 结果重复
 */
function discoverSkills(agents, projectDir, skipKeys = new Set()) {
  const results = [];
  for (const a of agents) {
    const collect = (dir, scope) => {
      for (const s of scanSkillsDir(dir, a.name, scope)) {
        const key = `${s.agent}|${s.path}`.toLowerCase();
        if (skipKeys.has(key)) continue;
        skipKeys.add(key);
        results.push(s);
      }
    };
    collect(a.global_skills_dir, 'global');
    if (projectDir && a.project_skills_dir) {
      const pd = path.isAbsolute(a.project_skills_dir)
        ? a.project_skills_dir
        : path.join(projectDir, a.project_skills_dir);
      collect(pd, 'project');
    }
  }
  return results;
}

module.exports = { discoverSkills, scanSkillsDir, parseSkillMd };
