'use strict';

/* CLI 结果缓存：一次面板刷新里 /api/agents、/api/audit、/api/mcps 会各要一次
 * `gaal agents -o json`（每次 ~1s 子进程），ttlMemo 用于去重。 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ttlMemo, agents, agentsCacheStats, resetAgentsCache } = require('../lib/gaal');

test('ttlMemo：TTL 内复用，超过 TTL 才重新执行', async () => {
  let runs = 0;
  let clock = 1000;
  const memo = ttlMemo(async () => ({ n: (runs += 1) }), 500, { now: () => clock });

  const a = await memo();
  const b = await memo();
  clock = 1499;
  const c = await memo();
  assert.equal(runs, 1, 'TTL 内不应重复执行 loader');
  assert.equal(b, a, '并发/连续调用应拿到同一个结果');
  assert.equal(c, a);

  clock = 1501;
  const d = await memo();
  assert.equal(runs, 2, '过期后应重新执行');
  assert.deepEqual(d, { n: 2 });
});

test('ttlMemo：force 绕过缓存，reset 清空，坏结果不缓存', async () => {
  let runs = 0;
  const memo = ttlMemo(async () => ({ n: (runs += 1) }), 60000);
  await memo();
  await memo(true);
  assert.equal(runs, 2, 'force 应重新执行');
  assert.equal(memo.stats().cached, true);
  memo.reset();
  assert.equal(memo.stats().cached, false);
  await memo();
  assert.equal(runs, 3);

  let badRuns = 0;
  const counting = ttlMemo(
    async () => {
      badRuns += 1;
      return { data: null };
    },
    60000,
    { bad: (r) => !r || !r.data },
  );
  await counting();
  await counting();
  assert.equal(badRuns, 2, '解析失败（bad）的结果不应被缓存');
  assert.equal(counting.stats().cached, false);
});

test('ttlMemo：并发调用共享同一个 in-flight promise', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const memo = ttlMemo(async () => {
    runs += 1;
    await gate;
    return runs;
  }, 60000);

  const p1 = memo();
  const p2 = memo();
  assert.equal(p1, p2);
  release();
  assert.equal(await p1, 1);
  assert.equal(await p2, 1);
  assert.equal(runs, 1, '两个并发调用只应 spawn 一次');
});

test('agents() 在 TTL 内只 spawn 一次，force 可绕过', async (t) => {
  resetAgentsCache();
  const base = agentsCacheStats().runs;
  const first = await agents();
  if (!first.data) {
    resetAgentsCache();
    return t.skip('本机 gaal 不可用，跳过复用断言');
  }
  await Promise.all([agents(), agents(), agents()]);
  assert.equal(agentsCacheStats().runs - base, 1, '连续取 agents 不应重复 spawn');

  await agents({ force: true });
  assert.equal(agentsCacheStats().runs - base, 2, 'force 应重新 spawn');
  resetAgentsCache();
});
