'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const conf = require('../lib/config');
const { writeFileAtomic } = require('../lib/atomic');
const yaml = require('js-yaml');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gaal-test-config-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const p = (...x) => path.join(tmp, ...x);

test('writeFileAtomic：创建父目录并覆盖写入', () => {
  const f = p('sub', 'dir', 'a.txt');
  writeFileAtomic(f, 'one');
  assert.equal(fs.readFileSync(f, 'utf8'), 'one');
  writeFileAtomic(f, 'two');
  assert.equal(fs.readFileSync(f, 'utf8'), 'two');
  assert.equal(fs.readdirSync(p('sub', 'dir')).filter((n) => n.endsWith('.tmp')).length, 0);
});

test('addSkillToFile：新文件带 schema 创建', () => {
  const f = p('new1.yaml');
  conf.addSkillToFile(f, { source: 'a/b', agents: ['*'], global: false });
  const d = yaml.load(fs.readFileSync(f, 'utf8'));
  assert.equal(d.schema, 1);
  assert.equal(d.skills[0].source, 'a/b');
});

test('addSkillToFile：追加保留注释', () => {
  const f = p('c1.yaml');
  fs.writeFileSync(f, '# 顶部\nschema: 1\nskills:\n  # 已有\n  - source: x/y\n    agents: ["*"]\nmcps: []\n');
  conf.addSkillToFile(f, { source: 'n/e', agents: ['*'], global: false });
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.includes('# 顶部'));
  assert.ok(text.includes('# 已有'));
  const d = yaml.load(text);
  assert.deepEqual(d.skills.map((s) => s.source), ['x/y', 'n/e']);
});

test('addSkillToFile：同 source 原位替换（upsert）', () => {
  const f = p('c2.yaml');
  fs.writeFileSync(f, 'schema: 1\nskills:\n  - source: x/y\n    agents: ["*"]\n');
  conf.addSkillToFile(f, { source: 'x/y', agents: ['claude'], global: false });
  const d = yaml.load(fs.readFileSync(f, 'utf8'));
  assert.equal(d.skills.length, 1);
  assert.deepEqual(d.skills[0].agents, ['claude']);
});

test('addSkillToFile：替换保留注释与位置', () => {
  const f = p('c3.yaml');
  fs.writeFileSync(f, '# 头\nschema: 1\nskills:\n  # 注释 A\n  - source: one\n  # 注释 B\n  - source: two\n');
  conf.addSkillToFile(f, { source: 'one', agents: ['z'] });
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.includes('# 注释 A'));
  assert.ok(text.includes('# 注释 B'));
  const d = yaml.load(text);
  assert.deepEqual(d.skills.map((s) => s.source), ['one', 'two']);
});

test('addMcpToFile：按 name 覆盖', () => {
  const f = p('m1.yaml');
  conf.addMcpToFile(f, { name: 'a', agents: ['*'], inline: { command: 'old', args: [] } });
  conf.addMcpToFile(f, { name: 'a', agents: ['claude'], inline: { command: 'new', args: ['-y'] } });
  const d = yaml.load(fs.readFileSync(f, 'utf8'));
  assert.equal(d.mcps.length, 1);
  assert.equal(d.mcps[0].inline.command, 'new');
  assert.deepEqual(d.mcps[0].agents, ['claude']);
});

test('removeSkillFromFile：精确移除并保留注释，返回 removed', () => {
  const f = p('r1.yaml');
  fs.writeFileSync(f, '# h\nschema: 1\nskills:\n  - source: keep/me\n  - source: drop/me\nmcps: []\n');
  const r = conf.removeSkillFromFile(f, 'drop/me');
  assert.equal(r.removed.length, 1);
  assert.equal(r.removed[0].source, 'drop/me');
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.includes('# h'));
  assert.ok(text.includes('keep/me'));
  assert.ok(!text.includes('drop/me'));
});

test('removeSkillFromFile：文件不存在时返回空且不创建文件', () => {
  const f = p('nope.yaml');
  assert.deepEqual(conf.removeSkillFromFile(f, 'x/y').removed, []);
  assert.equal(fs.existsSync(f), false);
});

test('removeSkillFromFile：一次移除多条匹配', () => {
  const f = p('r2.yaml');
  fs.writeFileSync(f, 'schema: 1\nskills:\n  - source: d/1\n  - source: k\n  - source: d/2\n');
  const r = conf.removeSkillFromFile(f, 'd/1');
  conf.removeSkillFromFile(f, 'd/2');
  const d = yaml.load(fs.readFileSync(f, 'utf8'));
  assert.equal(r.removed.length, 1);
  assert.deepEqual(d.skills.map((s) => s.source), ['k']);
});

test('流式写法 skills: []：回退后数据正确', () => {
  const f = p('flow.yaml');
  fs.writeFileSync(f, '# c\nschema: 1\nskills: []\n');
  conf.addSkillToFile(f, { source: 'q/w', agents: ['*'], global: false });
  const d = yaml.load(fs.readFileSync(f, 'utf8'));
  assert.equal(d.skills[0].source, 'q/w');
  assert.equal(d.schema, 1);
});

test('CRLF 文件编辑后保持 CRLF', () => {
  const f = p('crlf.yaml');
  fs.writeFileSync(f, 'schema: 1\r\nskills:\r\n  - source: a/b\r\n', 'utf8');
  conf.addSkillToFile(f, { source: 'c/d', agents: ['*'], global: false });
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.includes('\r\n'));
  assert.ok(text.includes('c/d'));
});

test('顶层无 skills 键：追加新 section', () => {
  const f = p('nosec.yaml');
  fs.writeFileSync(f, 'schema: 1\nrepositories: {}\n');
  conf.addSkillToFile(f, { source: 's/x', agents: ['*'], global: false });
  const d = yaml.load(fs.readFileSync(f, 'utf8'));
  assert.equal(d.skills[0].source, 's/x');
  assert.deepEqual(Object.keys(d.repositories), []);
});

test('writeConfig：合法 YAML 写入，非法 YAML 抛错', () => {
  const dir = p('proj-wc');
  fs.mkdirSync(dir, { recursive: true });
  conf.writeConfig(dir, 'schema: 1\n');
  assert.equal(yaml.load(fs.readFileSync(path.join(dir, 'gaal.yaml'), 'utf8')).schema, 1);
  assert.throws(() => conf.writeConfig(dir, 'a: [unclosed'), /YAML 校验失败/);
});

test('dryRun 预览：upsert 返回 text 且不写盘', () => {
  const f = p('dry1.yaml');
  fs.writeFileSync(f, '# 注释\nschema: 1\nskills:\n  - source: keep\n');
  const before = fs.readFileSync(f, 'utf8');
  const r = conf.upsertListItem(f, 'skills', (s) => s && s.source === 'new', { source: 'new', agents: ['*'] }, { dryRun: true });
  assert.equal(r.replaced, false);
  assert.ok(r.text.includes('source: new'));
  assert.ok(r.text.includes('# 注释'));
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'dryRun 不应写盘');
});

test('dryRun 预览：remove 返回 removed 与 text 且不写盘', () => {
  const f = p('dry2.yaml');
  fs.writeFileSync(f, 'schema: 1\nskills:\n  - source: a\n  - source: b\n');
  const before = fs.readFileSync(f, 'utf8');
  const r = conf.removeListItems(f, 'skills', (s) => s && s.source === 'a', { dryRun: true });
  assert.equal(r.removed.length, 1);
  assert.ok(!r.text.includes('source: a'));
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'dryRun 不应写盘');
});

test('removeListItems：无命中时返回空且不写盘', () => {
  const f = p('dry3.yaml');
  fs.writeFileSync(f, 'schema: 1\nskills:\n  - source: a\n');
  const before = fs.readFileSync(f, 'utf8');
  const r = conf.removeListItems(f, 'skills', (s) => s && s.source === 'nope', { dryRun: true });
  assert.equal(r.removed.length, 0);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
});

test('readConfig：存在与不存在两种形态', () => {
  const dir = p('proj-rd');
  fs.mkdirSync(dir, { recursive: true });
  const miss = conf.readConfig(dir);
  assert.equal(miss.exists, false);
  fs.writeFileSync(path.join(dir, 'gaal.yaml'), 'schema: 1\n');
  const hit = conf.readConfig(dir);
  assert.equal(hit.exists, true);
  assert.equal(hit.data.schema, 1);
});
