'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lineDiff } = require('../lib/diff');

test('完全相同的文本：全部为不变行', () => {
  const d = lineDiff('a\nb\n', 'a\nb\n');
  assert.ok(d.every((l) => l.op === ' '));
  assert.equal(d.length, 3);
});

test('纯新增：只出现 + 行，无 - 行', () => {
  const d = lineDiff('a\nb', 'a\nb\nc');
  assert.ok(!d.some((l) => l.op === '-'));
  assert.deepEqual(d.filter((l) => l.op === '+').map((l) => l.text), ['c']);
});

test('纯删除：只出现 - 行，无 + 行', () => {
  const d = lineDiff('a\nb\nc', 'a\nc');
  assert.ok(!d.some((l) => l.op === '+'));
  assert.deepEqual(d.filter((l) => l.op === '-').map((l) => l.text), ['b']);
});

test('修改一行：等量 - 与 +', () => {
  const d = lineDiff('source: old\nx: 1', 'source: new\nx: 1');
  assert.deepEqual(d.filter((l) => l.op === '-').map((l) => l.text), ['source: old']);
  assert.deepEqual(d.filter((l) => l.op === '+').map((l) => l.text), ['source: new']);
  assert.ok(d.some((l) => l.op === ' ' && l.text === 'x: 1'));
});

test('空原文（新文件场景）：全部为 + 行', () => {
  const d = lineDiff('', 'schema: 1\nskills: []');
  assert.ok(d.length >= 2);
  assert.ok(d.every((l) => l.op === '+'));
});

test('null 输入按空字符串处理', () => {
  const d = lineDiff(null, 'x: 1');
  assert.ok(d.some((l) => l.op === '+' && l.text === 'x: 1'));
});

test('中间行变化：前后公共行被掐头去尾保留', () => {
  const d = lineDiff('head\nm1\ntail', 'head\nm2\ntail');
  assert.equal(d[0].text, 'head');
  assert.equal(d[d.length - 1].text, 'tail');
  assert.deepEqual(
    d.slice(1, -1).map((l) => `${l.op}${l.text}`),
    ['-m1', '+m2'],
  );
});

test('超大规模输入返回 null（防御阈值）', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(lineDiff(big, big + '\nx'), null);
});
