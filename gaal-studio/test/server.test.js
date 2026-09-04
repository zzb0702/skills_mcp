'use strict';

/* HTTP 冒烟测试：require server 模块（不自动监听），自行绑定临时端口 */

process.env.GAAL_STUDIO_NO_OPEN = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { server, state } = require('../server');

let port = 0;
let base = '';

test.before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(() => {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
});

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test('GET /api/meta 返回版本与兼容性信息', async () => {
  const r = await req('GET', '/api/meta');
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.ok(d.binary);
  assert.ok(d.compat && typeof d.compat.ok === 'boolean');
  assert.equal(d.platform, process.platform);
});

test('GET / 返回面板页面', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /gaal studio/);
  assert.match(r.headers['content-type'] || '', /text\/html/);
});

test('app.css 提供 .hidden 工具类（stale pill 与批量操作条靠它隐藏）', async () => {
  const r = await req('GET', '/app.css');
  assert.equal(r.status, 200);
  // #stale-pill / .bulk-bar 各自声明了 display，工具类必须带 !important 才压得住
  assert.match(r.body, /\.hidden\s*\{[^}]*display:\s*none\s*!important/);
});

test('未知 API 路由返回 404 与错误说明', async () => {
  const r = await req('GET', '/api/no-such-route');
  assert.equal(r.status, 404);
  assert.match(JSON.parse(r.body).error, /no route/);
});

test('非法 JSON 请求体返回 400', async () => {
  const r = await req('POST', '/api/project/select', { body: 'not-json', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
});

test('Host 头校验：伪造域名被 403 拒绝（DNS rebinding 防护）', async () => {
  const r = await req('GET', '/api/meta', { headers: { Host: 'evil.example.com' } });
  assert.equal(r.status, 403);
  const ok = await req('GET', '/api/meta', { headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(ok.status, 200);
  const okLocal = await req('GET', '/api/meta', { headers: { Host: `localhost:${port}` } });
  assert.equal(okLocal.status, 200);
});

test('静态文件禁止越出 public 目录', async () => {
  const r = await req('GET', '/..%2f..%2fserver.js');
  assert.ok(r.status === 403 || r.status === 404);
});

test('GET /api/schedule 返回定时状态', async () => {
  const r = await req('GET', '/api/schedule');
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(typeof d.enabled, 'boolean');
  assert.equal(typeof d.intervalMin, 'number');
});

test('GET /api/state 返回状态签名（轮询用）', async () => {
  const r = await req('GET', '/api/state');
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.ok(d.projectDir);
  assert.equal(typeof d.configMtime === 'number' || d.configMtime === null, true);
});

test('同步互斥：syncBusy 时 POST /api/sync 返回 409', async () => {
  state.syncBusy = true;
  try {
    const r = await req('POST', '/api/sync', { body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.body).error, /同步在进行中/);
  } finally {
    state.syncBusy = false;
  }
});

test('部署预览：返回 diff 且不写盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaal-test-preview-'));
  const skillDir = path.join(dir, 'demo-skill');
  fs.mkdirSync(skillDir, { recursive: true }); // preview 与 deploy 一样校验源目录存在
  const oldDir = state.projectDir;
  state.projectDir = dir;
  try {
    const r = await req('POST', '/api/preview/skill', {
      body: JSON.stringify({ source: skillDir, agents: ['*'] }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(r.status, 200);
    const d = JSON.parse(r.body);
    assert.equal(d.exists, false);
    assert.equal(d.replaced, false);
    assert.ok(Array.isArray(d.diff));
    assert.ok(d.diff.some((l) => l.op === '+' && l.text.includes('demo-skill')));
    assert.equal(fs.existsSync(path.join(dir, 'gaal.yaml')), false, '预览不应创建 gaal.yaml');
  } finally {
    state.projectDir = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('部署预览：源目录不存在返回 400', async () => {
  const r = await req('POST', '/api/preview/skill', {
    body: JSON.stringify({ source: 'D:/definitely/not/exist-xyz' }),
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(r.status, 400);
});

test('移除预览：无配置文件时返回 removed 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaal-test-rmprev-'));
  const oldDir = state.projectDir;
  state.projectDir = dir;
  try {
    const r = await req('POST', '/api/preview/remove-skill', {
      body: JSON.stringify({ source: 'a/b' }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { removed: 0, diff: null });
  } finally {
    state.projectDir = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('移除预览：命中时返回删除行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaal-test-rmprev2-'));
  const oldDir = state.projectDir;
  state.projectDir = dir;
  try {
    fs.writeFileSync(path.join(dir, 'gaal.yaml'), 'schema: 1\nskills:\n  - source: a/b\n    agents:\n      - "*"\n');
    const r = await req('POST', '/api/preview/remove-skill', {
      body: JSON.stringify({ source: 'a/b' }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(r.status, 200);
    const d = JSON.parse(r.body);
    assert.equal(d.removed, 1);
    assert.ok(d.diff.some((l) => l.op === '-' && l.text.includes('source: a/b')));
  } finally {
    state.projectDir = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
