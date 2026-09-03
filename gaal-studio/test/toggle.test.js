'use strict';

/* XDG_CONFIG_HOME 必须在 require 之前重定向，避免测试碰真实用户配置 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'gaal-test-xdg-'));
process.env.XDG_CONFIG_HOME = XDG;

const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const toggle = require('../lib/toggle');

test.after(() => fs.rmSync(XDG, { recursive: true, force: true }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaal-test-toggle-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mkSkill = (dir, name) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: t\n---\nbody`);
};

const proj = tmp;
const noUserConf = path.join(tmp, 'user-not-exist.yaml');

test('skill 禁用→启用往返：目录与声明都恢复', () => {
  const gaalYaml = path.join(proj, 'gaal.yaml');
  mkSkill(path.join(proj, '.claude', 'skills'), 'alpha');
  fs.writeFileSync(gaalYaml, 'schema: 1\nskills:\n  - source: owner/alpha\n    global: false\n');
  const skillDir = path.join(proj, '.claude', 'skills', 'alpha');

  const off = toggle.toggleSkill({ agent: 'claude', skillPath: skillDir, enabled: false, projectDir: proj, userConfig: noUserConf });
  assert.equal(off.ok, true);
  assert.equal(off.mode, 'move');
  assert.ok(off.backup && fs.existsSync(off.backup));
  assert.equal(fs.existsSync(skillDir), false);
  assert.equal(((yaml.load(fs.readFileSync(gaalYaml, 'utf8')) || {}).skills || []).length, 0);
  const store = toggle.loadStore();
  assert.equal(Object.keys(store.skills).length, 1);

  const on = toggle.toggleSkill({ agent: 'claude', skillPath: skillDir, enabled: true, projectDir: proj, userConfig: noUserConf });
  assert.equal(on.mode, 'restore');
  assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')));
  assert.equal(yaml.load(fs.readFileSync(gaalYaml, 'utf8')).skills[0].source, 'owner/alpha');
  assert.equal(Object.keys(toggle.loadStore().skills).length, 0);
});

test('绝对路径 source 只按完整路径匹配，不误删同名目录的声明', () => {
  const gaalYaml = path.join(proj, 'gaal.yaml');
  mkSkill(path.join(proj, 'x'), 'foo');
  fs.writeFileSync(gaalYaml, 'schema: 1\nskills:\n  - source: D:/a/skills/foo\n  - source: D:/b/other/foo\n');
  toggle.toggleSkill({ agent: 'claude', skillPath: path.join(proj, 'x', 'foo'), enabled: false, projectDir: proj, userConfig: noUserConf });
  const d = yaml.load(fs.readFileSync(gaalYaml, 'utf8'));
  assert.equal(d.skills.length, 2);
});

test('作用域门控：项目内禁用不碰 global:true 声明，全局禁用不碰 global:false 声明', () => {
  const gaalYaml = path.join(proj, 'gaal.yaml');
  const userConf = path.join(proj, 'u3.yaml');
  mkSkill(path.join(proj, 'p'), 'beta');
  mkSkill(path.join(XDG, 'global-skills'), 'beta');
  fs.writeFileSync(gaalYaml, 'schema: 1\nskills:\n  - source: owner/beta\n    global: false\n');
  fs.writeFileSync(userConf, 'schema: 1\nskills:\n  - source: owner/beta\n    global: true\n');

  toggle.toggleSkill({ agent: 'claude', skillPath: path.join(proj, 'p', 'beta'), enabled: false, projectDir: proj, userConfig: userConf });
  assert.equal(((yaml.load(fs.readFileSync(gaalYaml, 'utf8')) || {}).skills || []).length, 0, '项目内简写声明应被移除');
  assert.equal((yaml.load(fs.readFileSync(userConf, 'utf8')).skills || []).length, 1, '用户级 global:true 不应被碰');

  toggle.toggleSkill({ agent: 'claude', skillPath: path.join(XDG, 'global-skills', 'beta'), enabled: false, projectDir: proj, userConfig: userConf });
  assert.equal((yaml.load(fs.readFileSync(userConf, 'utf8')).skills || []).length, 0, '全局简写声明应被移除');
});

test('目录被手动重建后启用：恢复声明并清记录', () => {
  const gaalYaml = path.join(proj, 'gaal.yaml');
  const skillDir = path.join(proj, 'rc', 'gamma');
  mkSkill(path.join(proj, 'rc'), 'gamma');
  fs.writeFileSync(gaalYaml, 'schema: 1\nskills:\n  - source: x/gamma\n    global: false\n');
  toggle.toggleSkill({ agent: 'claude', skillPath: skillDir, enabled: false, projectDir: proj, userConfig: noUserConf });
  mkSkill(path.join(proj, 'rc'), 'gamma'); // 手动重建
  const r = toggle.toggleSkill({ agent: 'claude', skillPath: skillDir, enabled: true, projectDir: proj, userConfig: noUserConf });
  assert.equal(r.mode, 'declarations-restored');
  assert.equal(yaml.load(fs.readFileSync(gaalYaml, 'utf8')).skills[0].source, 'x/gamma');
});

test('重复禁用返回已禁用；未记录的路径启用报错', () => {
  const skillDir = path.join(proj, 'dup', 'omega');
  mkSkill(path.join(proj, 'dup'), 'omega');
  toggle.toggleSkill({ agent: 'claude', skillPath: skillDir, enabled: false, projectDir: proj, userConfig: noUserConf });
  const again = toggle.toggleSkill({ agent: 'claude', skillPath: skillDir, enabled: false, projectDir: proj, userConfig: noUserConf });
  assert.ok(again.alreadyDisabled);
  // 目录不存在且无禁用记录 → 明确报错
  assert.throws(
    () => toggle.toggleSkill({ agent: 'claude', skillPath: path.join(proj, 'dup', 'never-disabled'), enabled: true, projectDir: proj, userConfig: noUserConf }),
    /未找到该 skill 的禁用记录/,
  );
  toggle.toggleSkill({ agent: 'claude', skillPath: skillDir, enabled: true, projectDir: proj, userConfig: noUserConf });
});

test('MCP 硬开关：opencode 布局禁用→启用回到原容器', () => {
  const f = path.join(tmp, 'opencode.json');
  fs.writeFileSync(f, JSON.stringify({ mcp: { ctx: { command: 'npx', args: ['-y', 'c'] } } }, null, 2));
  toggle.toggleMcp({ agent: 'opencode', name: 'ctx', scope: 'global', file: f, enabled: false, projectDir: proj, userConfig: noUserConf });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { mcp: {} });
  toggle.toggleMcp({ agent: 'opencode', name: 'ctx', scope: 'global', file: f, enabled: true, projectDir: proj, userConfig: noUserConf });
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(d.mcp && d.mcp.ctx && !d.mcpServers);
});

test('MCP 硬开关：混合布局恢复进原 mcp 块而非 mcpServers', () => {
  const f = path.join(tmp, 'mixed.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { other: { command: 'o' } }, mcp: { ctx: { command: 'c' } } }, null, 2));
  toggle.toggleMcp({ agent: 'opencode', name: 'ctx', scope: 'global', file: f, enabled: false, projectDir: proj, userConfig: noUserConf });
  toggle.toggleMcp({ agent: 'opencode', name: 'ctx', scope: 'global', file: f, enabled: true, projectDir: proj, userConfig: noUserConf });
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(d.mcp && d.mcp.ctx);
  assert.ok(!d.mcpServers.ctx);
});

test('MCP 软开关：已有 enabled 字段的 agent 直接改字段', () => {
  const f = path.join(tmp, 'zcode.json');
  fs.writeFileSync(f, JSON.stringify({ mcp: { servers: { a: { command: 'c', enabled: true } } } }, null, 2));
  const off = toggle.toggleMcp({ agent: 'zcode', name: 'a', scope: 'global', file: f, enabled: false, projectDir: proj, userConfig: noUserConf });
  assert.equal(off.mode, 'soft');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).mcp.servers.a.enabled, false);
  toggle.toggleMcp({ agent: 'zcode', name: 'a', scope: 'global', file: f, enabled: true, projectDir: proj, userConfig: noUserConf });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).mcp.servers.a.enabled, true);
});

test('MCP 硬开关：同时移除对应 scope 的 gaal.yaml 声明', () => {
  const gaalYaml = path.join(proj, 'gaal.yaml');
  const f = path.join(tmp, 'hard.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { ctx: { command: 'c' } } }, null, 2));
  fs.writeFileSync(gaalYaml, 'schema: 1\nmcps:\n  - name: ctx\n    agents: ["*"]\n    global: false\n');
  const r = toggle.toggleMcp({ agent: 'claude', name: 'ctx', scope: 'project', file: f, enabled: false, projectDir: proj, userConfig: noUserConf });
  assert.equal(r.mode, 'hard');
  assert.equal(r.declarationsRemoved, 1);
  assert.equal(((yaml.load(fs.readFileSync(gaalYaml, 'utf8')) || {}).mcps || []).length, 0);
  toggle.toggleMcp({ agent: 'claude', name: 'ctx', scope: 'project', file: f, enabled: true, projectDir: proj, userConfig: noUserConf });
  const d = yaml.load(fs.readFileSync(gaalYaml, 'utf8'));
  assert.equal(d.mcps[0].name, 'ctx');
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers.ctx);
});

test('TOML 软开关：codex config.toml 改 enabled 行，保留 CRLF', () => {
  const f = path.join(tmp, 'config.toml');
  fs.writeFileSync(f, '[mcp_servers.a]\r\ncommand = "c"\r\n\r\n[mcp_servers.b]\r\ncommand = "d"\r\nenabled = true\r\n');
  toggle.toggleMcp({ agent: 'codex', name: 'a', scope: 'global', file: f, enabled: false, projectDir: proj, userConfig: noUserConf });
  let text = fs.readFileSync(f, 'utf8');
  assert.ok(text.includes('\r\n'), 'CRLF 应保留');
  assert.ok(/\[mcp_servers\.a\]\r\nenabled = false/.test(text));
  assert.ok(/\[mcp_servers\.b\]\r\ncommand = "d"\r\nenabled = true/.test(text), '未触碰的 b 保持原值');
  toggle.toggleMcp({ agent: 'codex', name: 'b', scope: 'global', file: f, enabled: false, projectDir: proj, userConfig: noUserConf });
  text = fs.readFileSync(f, 'utf8');
  assert.ok(/\[mcp_servers\.b\]\r\ncommand = "d"\r\nenabled = false/.test(text));
  toggle.toggleMcp({ agent: 'codex', name: 'b', scope: 'global', file: f, enabled: true, projectDir: proj, userConfig: noUserConf });
  text = fs.readFileSync(f, 'utf8');
  assert.ok(/\[mcp_servers\.b\]\r\ncommand = "d"\r\nenabled = true/.test(text));
});

test('disabledList 反映 store 内容', () => {
  const skillDir = path.join(proj, 'dl', 'sigma');
  mkSkill(path.join(proj, 'dl'), 'sigma');
  toggle.toggleSkill({ agent: 'claude', skillPath: skillDir, enabled: false, projectDir: proj, userConfig: noUserConf });
  const list = toggle.disabledList();
  assert.ok(list.skills.some((s) => s.name === 'sigma'));
  toggle.toggleSkill({ agent: 'claude', skillPath: skillDir, enabled: true, projectDir: proj, userConfig: noUserConf });
  assert.ok(!toggle.disabledList().skills.some((s) => s.name === 'sigma'));
});
