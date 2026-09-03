'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { discoverMcps, parseJsonMcp, parseTomlMcp, parseYamlMcp } = require('../lib/mcp-discovery');
const { discoverSkills, scanSkillsDir, parseSkillMd } = require('../lib/skill-discovery');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaal-test-disc-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const p = (...x) => path.join(tmp, ...x);

test('parseJsonMcp：mcpServers / mcp.servers 扁平 / mcp 嵌套 / mcp 直接挂载', () => {
  const a = parseJsonMcp('{"mcpServers":{"a":{"command":"x"}}}', 'ag', 'global', 'f.json');
  assert.equal(a[0].name, 'a');
  assert.equal(a[0].type, 'stdio');

  const b = parseJsonMcp('{"mcp.servers":{"b":{"url":"https://x"}}}', 'ag', 'global', 'f.json');
  assert.equal(b[0].name, 'b');
  assert.equal(b[0].type, 'http');

  const c = parseJsonMcp('{"mcp":{"servers":{"c":{"command":"x"}}}}', 'ag', 'global', 'f.json');
  assert.equal(c[0].name, 'c');

  const d = parseJsonMcp('{"mcp":{"d":{"command":"x"}}}', 'ag', 'global', 'f.json');
  assert.equal(d[0].name, 'd');
});

test('parseJsonMcp：enable/enabled 字段都影响 enabled 判定', () => {
  const [a] = parseJsonMcp('{"mcpServers":{"a":{"command":"x","enable":false}}}', 'ag', 'global', 'f.json');
  const [b] = parseJsonMcp('{"mcpServers":{"b":{"command":"x","enabled":false}}}', 'ag', 'global', 'f.json');
  const [c] = parseJsonMcp('{"mcpServers":{"c":{"command":"x"}}}', 'ag', 'global', 'f.json');
  assert.equal(a.enabled, false);
  assert.equal(b.enabled, false);
  assert.equal(c.enabled, true);
});

test('parseJsonMcp：非法 JSON 返回空数组', () => {
  assert.deepEqual(parseJsonMcp('not json{', 'ag', 'global', 'f.json'), []);
});

test('parseTomlMcp / parseYamlMcp', () => {
  const t = parseTomlMcp('[mcp_servers.a]\ncommand = "x"\n\n[mcp_servers.b]\ncommand = "y"\n', 'codex', 'global', 'f.toml');
  assert.deepEqual(t.map((m) => m.name), ['a', 'b']);
  const y = parseYamlMcp('mcpServers:\n  a:\n    command: x\n', 'goose', 'global', 'f.yaml');
  assert.equal(y[0].name, 'a');
});

test('discoverMcps：同一文件被多个 agent 名扫描只保留一条', () => {
  const pf = p('proj', '.mcp.json');
  fs.mkdirSync(path.dirname(pf), { recursive: true });
  fs.writeFileSync(pf, JSON.stringify({ mcpServers: { dup: { command: 'x' } } }));
  const agents = [
    { name: 'claude', global_mcp_config_file: p('claude-global.json'), project_mcp_config_file: '.mcp.json' },
    { name: 'claude-code', global_mcp_config_file: p('cc-global.json'), project_mcp_config_file: '.mcp.json' },
  ];
  const list = discoverMcps(agents, path.dirname(pf));
  assert.equal(list.filter((m) => m.name === 'dup').length, 1);
  assert.equal(list[0].agent, 'claude');
});

test('discoverMcps：不同文件同名各自保留（重复检测的数据基础）', () => {
  const dir = p('dupcase');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ mcpServers: { same: { command: 'x' } } }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ mcpServers: { same: { command: 'y' } } }));
  const agents = [
    { name: 'ag1', global_mcp_config_file: path.join(dir, 'a.json') },
    { name: 'ag2', global_mcp_config_file: path.join(dir, 'b.json') },
  ];
  const list = discoverMcps(agents, null);
  assert.equal(list.length, 2);
});

test('scanSkillsDir：扫描 SKILL.md 并解析 frontmatter', () => {
  const root = p('sk', 'skills');
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', 'SKILL.md'), '---\nname: Alpha Skill\ndescription: 描述\n---\nbody');
  fs.mkdirSync(path.join(root, 'empty'), { recursive: true }); // 无 SKILL.md，应跳过
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
  const out = scanSkillsDir(root, 'claude', 'global');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Alpha Skill');
  assert.equal(out[0].agent, 'claude');
  assert.equal(out[0].source, 'global');
});

test('scanSkillsDir：跟随 junction 目录', () => {
  const root = p('sk2', 'skills');
  const real = p('sk2', 'real-target');
  fs.mkdirSync(path.join(real), { recursive: true });
  fs.writeFileSync(path.join(real, 'SKILL.md'), '---\nname: linked\n---\nbody');
  fs.mkdirSync(root, { recursive: true });
  let made = false;
  try {
    fs.symlinkSync(real, path.join(root, 'lnk'), 'junction');
    made = true;
  } catch {
    /* 非 Windows 或权限不足时跳过该断言 */
  }
  if (!made) return;
  const out = scanSkillsDir(root, 'claude', 'global');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'linked');
});

test('parseSkillMd：无 frontmatter 与 BOM 场景', () => {
  assert.equal(parseSkillMdHelper('no frontmatter here').name, null);
  const r = parseSkillMdHelper('\uFEFF---\nname: bom\ndescription: d\n---\n');
  assert.equal(r.name, 'bom');
});
function parseSkillMdHelper(text) {
  const f = p('md-' + Math.random().toString(36).slice(2) + '.md');
  fs.writeFileSync(f, text);
  return parseSkillMd(f);
}

test('discoverSkills：skipKeys 去重', () => {
  const root = p('sk3', 'skills');
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', 'SKILL.md'), '---\nname: a\n---\n');
  const agents = [{ name: 'claude', global_skills_dir: root, project_skills_dir: '.claude/skills' }];
  const first = discoverSkills(agents, tmp, new Set());
  assert.equal(first.length, 1);
  // 模拟 gaal 已报告同一路径：key = agent|path（小写、正斜杠）
  const key = `claude|${first[0].path}`.toLowerCase();
  const second = discoverSkills(agents, tmp, new Set([key]));
  assert.equal(second.length, 0);
});
