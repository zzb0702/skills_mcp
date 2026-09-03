'use strict';

/* ───────────── 基础设施 ───────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * POST 并按 SSE 帧流式读取服务端推送。
 * @param {string} path
 * @param {object} body
 * @param {(text: string) => void} [onOutput] 每次 output 事件的文本
 * @returns {Promise<object|null>} done 事件携带的最终结果
 */
async function apiStream(path, body, onOutput) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let data;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      if (event === 'output') onOutput?.(data.text || '');
      if (event === 'done') result = data;
    }
  }
  return result;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function basename(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/');
  return parts.filter(Boolean).pop() || p || '';
}

/** 是否为路径形态（绝对路径 / ~ / 相对路径），而非 owner/repo 简写 */
function isAbsPath(p) {
  return /^(?:[a-z]:[\\/]|[\\/]|~)/i.test(String(p || ''));
}

/** 返回 skill 所在 skills 根目录（去掉末尾两段：<root>/<name>[/SKILL.md]） */
function dirnameOf(p) {
  let parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length && /^skill\.md$/i.test(parts[parts.length - 1])) parts.pop();
  if (parts.length) parts.pop(); // 去掉 skill 名，留 skills 根目录
  return parts.join('/') || p || '';
}

function openModal(html, onMount) {
  const root = $('#modal-root');
  root.classList.remove('hidden');
  root.innerHTML = `<div class="modal">${html}</div>`;
  root.onclick = (e) => {
    if (e.target === root) closeModal();
  };
  onMount?.(root);
}
function closeModal() {
  const root = $('#modal-root');
  root.classList.add('hidden');
  root.innerHTML = '';
}

/** 把 lineDiff 结果渲染为带色彩的行 */
function renderDiff(lines) {
  if (!lines) return '<div class="muted">（无法生成对比，请直接检查文件）</div>';
  const body = lines
    .map((l) => {
      const cls = l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'ctx';
      const prefix = l.op === ' ' ? '  ' : `${l.op} `;
      return `<div class="diff-line ${cls}">${esc(prefix + l.text)}</div>`;
    })
    .join('');
  return body || '<div class="muted">（无变化）</div>';
}

/**
 * 应用内确认弹窗（替代原生 confirm，风格与界面一致）。
 * @param {{title:string, message:string, detail?:string, diff?:Array, confirmText?:string, tone?:'primary'|'danger'}} opts
 * @returns {Promise<boolean>}
 */
function confirmDialog(opts) {
  return new Promise((resolve) => {
    const icon = opts.tone === 'danger' ? '🚫' : '⚡';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      closeModal();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') finish(true);
    };
    openModal(
      `<div class="confirm-box">
         <div class="confirm-head"><span class="confirm-icon">${icon}</span><h2>${esc(opts.title)}</h2></div>
         <p class="confirm-msg">${esc(opts.message)}</p>
         ${opts.detail ? `<div class="confirm-detail">${esc(opts.detail)}</div>` : ''}
         ${opts.diff ? `<div class="confirm-detail diff-view">${renderDiff(opts.diff)}</div>` : ''}
         <div class="modal-actions">
           <button class="ghost" id="cf-no">${esc(opts.cancelText || '取消')}</button>
           <button class="${opts.tone === 'danger' ? 'danger' : 'primary'}" id="cf-yes">${esc(opts.confirmText || '确认')}</button>
         </div>
       </div>`,
      (root) => {
        root.querySelector('.modal').style.width = 'min(440px, 100%)';
        $('#cf-yes', root).onclick = () => finish(true);
        $('#cf-no', root).onclick = () => finish(false);
        root.querySelector('.modal').onclick = (e) => e.stopPropagation();
      },
    );
    // 点遮罩关闭 = 取消
    $('#modal-root').onclick = (e) => {
      if (e.target === $('#modal-root')) finish(false);
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => $('#cf-yes')?.focus(), 0);
  });
}

/* ───────────── 全局缓存 ───────────── */

const cache = {
  meta: null,
  agents: null,
  audit: null,
  status: null,
  config: null,
};

async function loadBase() {
  const [meta, agents, audit, mcps] = await Promise.all([
    api('/api/meta'),
    api('/api/agents'),
    api('/api/audit'),
    api('/api/mcps').catch(() => ({ mcps: [] })),
  ]);
  cache.meta = meta;
  cache.agents = agents.agents || [];
  cache.audit = audit;
  cache.mcps = mcps.mcps || [];
  $('#meta-version').textContent = `gaal ${typeof meta.version === 'string' ? meta.version : meta.version?.version || ''}`;
  if (meta.compat && meta.compat.ok === false) {
    toast(`gaal ${$('#meta-version').textContent.slice(5)} 低于面板验证过的最低版本 ${meta.compat.min}，部分字段可能显示异常`, 'err');
  }
  $('#project-path').textContent = meta.projectDir;
  $('#project-path').title = meta.projectDir;
  refreshScheduleBadge();
  noteStateBaseline();
}

/* ── 数据更新检测：轮询 /api/state 签名，变化时提示刷新（不自动刷新，避免打断编辑） ── */

let knownStateSig = null;

async function noteStateBaseline() {
  try {
    const s = await api('/api/state');
    knownStateSig = JSON.stringify([s.projectDir, s.lastSyncAt, s.scheduleLastRun, s.configMtime]);
    $('#stale-pill')?.classList.add('hidden');
  } catch {
    /* ignore */
  }
}

setInterval(async () => {
  if (!knownStateSig || !cache.meta) return;
  try {
    const s = await api('/api/state');
    const sig = JSON.stringify([s.projectDir, s.lastSyncAt, s.scheduleLastRun, s.configMtime]);
    if (sig !== knownStateSig) $('#stale-pill')?.classList.remove('hidden');
  } catch {
    /* ignore */
  }
}, 25000);

async function refreshScheduleBadge() {
  try {
    const s = await api('/api/schedule');
    const b = $('#schedule-badge');
    b.textContent = s.enabled ? `定时: 每 ${s.intervalMin} 分钟` : '定时: 关';
    b.classList.toggle('on', !!s.enabled);
  } catch {
    /* ignore */
  }
}

/* ───────────── 视图路由 ───────────── */

const views = {};
let currentView = 'overview';
const VALID_VIEWS = new Set(['overview', 'agents', 'skills', 'mcps', 'deploy', 'config', 'sync']);

async function show(view) {
  currentView = view;
  // hash 路由：刷新/后退/直达链接均可恢复视图
  if (location.hash.slice(1) !== view) location.hash = view;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const titles = {
    overview: '总览',
    agents: 'Agents',
    skills: 'Skills 清单',
    mcps: 'MCP Servers',
    deploy: '项目级部署',
    config: '配置编辑',
    sync: '同步 & 健康检查',
  };
  $('#view-title').textContent = titles[view] || view;
  $('#content').innerHTML = '<div class="loading">加载中…</div>';
  try {
    await views[view]();
  } catch (e) {
    $('#content').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/* ───────────── 总览 ───────────── */

views.overview = async () => {
  const agents = cache.agents;
  const skills = cache.audit?.skills || [];
  const installedAgents = agents.filter((a) => a.installed);
  const agentSet = new Set(skills.map((s) => s.agent));
  const mcpCount = (cache.mcps || []).length;

  // 按 agent 统计 skill 数
  const byAgent = {};
  for (const s of skills) byAgent[s.agent] = (byAgent[s.agent] || 0) + 1;

  const cfg = await api('/api/config');
  cache.config = cfg;
  const declared = cfg.data || {};
  const nSkills = (declared.skills || []).length;
  const nMcps = (declared.mcps || []).length;
  const nRepos = Object.keys(declared.repositories || {}).length;

  $('#content').innerHTML = `
    <div class="grid cols-4">
      <div class="card"><div class="stat-num">${installedAgents.length}</div><div class="stat-label">已安装 Agents</div></div>
      <div class="card"><div class="stat-num">${skills.length}</div><div class="stat-label">已发现 Skills</div></div>
      <div class="card"><div class="stat-num">${mcpCount}</div><div class="stat-label">已发现 MCP</div></div>
      <div class="card"><div class="stat-num">${agentSet.size}</div><div class="stat-label">持有 Skill 的 Agents</div></div>
    </div>

    <div class="split" style="margin-top:14px">
      <div class="card">
        <h3>当前项目配置 <span class="tag ${cfg.exists ? 'green' : 'warn'}">${cfg.exists ? 'gaal.yaml 已存在' : '尚无 gaal.yaml'}</span></h3>
        <div class="grid cols-4">
          <div><div class="stat-num">${nRepos}</div><div class="stat-label">repositories</div></div>
          <div><div class="stat-num">${nSkills}</div><div class="stat-label">skills</div></div>
          <div><div class="stat-num">${nMcps}</div><div class="stat-label">mcps</div></div>
          <div><div class="stat-num">${(declared.content || []).length}</div><div class="stat-label">content</div></div>
        </div>
        <div class="mono muted" style="margin-top:10px;font-size:11px">${esc(cfg.path)}</div>
        ${cfg.exists ? '' : `
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="primary" id="ov-init">⚡ 一键部署到此项目</button>
          <button class="ghost" id="ov-init-import">导入本机已装内容并部署</button>
        </div>`}
      </div>

      <div class="card">
        <h3>各 Agent 的 Skill 分布</h3>
        ${
          Object.keys(byAgent).length
            ? `<table><tbody>${Object.entries(byAgent)
                .sort((a, b) => b[1] - a[1])
                .map(
                  ([ag, n]) => `<tr><td class="mono">${esc(ag)}</td><td>
                    <div style="background:var(--bg-elev);border-radius:4px;height:14px;position:relative;overflow:hidden">
                      <div style="position:absolute;inset:0;width:${Math.min(100, (n / skills.length) * 100)}%;background:linear-gradient(90deg,#3fb950,#58a6ff)"></div>
                    </div></td><td class="mono nowrap" style="width:52px;text-align:right">${n}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : '<div class="empty">未发现 skills</div>'
        }
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>快速操作</h3>
      <div class="toolbar">
        <button class="primary" id="ov-dryrun">预览同步 (dry-run)</button>
        <button id="ov-sync">立即同步</button>
        <button id="ov-doctor">健康检查</button>
        <button class="ghost" id="ov-goto-deploy">部署到项目 →</button>
      </div>
      <pre class="output hidden" id="ov-out" style="display:none"></pre>
    </div>
  `;

  const out = $('#ov-out');
  const run = async (label, body) => {
    out.style.display = 'block';
    out.textContent = `$ gaal sync (${label})…\n`;
    try {
      const r = await apiStream('/api/sync/stream', body, (t) => {
        out.textContent += t;
        out.scrollTop = out.scrollHeight;
      });
      out.textContent += `\nexit=${r?.code ?? '?'}`;
      toast(r?.ok ? '完成' : `退出码 ${r?.code}`, r?.ok ? 'ok' : 'err');
    } catch (e) {
      out.textContent += `\n失败：${e.message}`;
      toast(e.message, 'err');
    }
  };
  $('#ov-dryrun').onclick = () => run('dry-run', { dryRun: true });
  $('#ov-sync').onclick = () => run('sync', {});
  $('#ov-doctor').onclick = async () => {
    out.style.display = 'block';
    out.textContent = 'doctor 执行中…';
    const r = await api('/api/doctor', { method: 'POST' });
    out.textContent = r.output + (r.stderr ? '\n' + r.stderr : '');
  };
  $('#ov-goto-deploy').onclick = () => show('deploy');

  const doInit = async (mode, btn) => {
    const ok = await confirmDialog({
      title: mode === 'import-all' ? '导入本机内容并部署' : '一键部署到当前项目',
      message:
        mode === 'import-all'
          ? '将扫描本机已安装的 skills / MCP，写入项目 gaal.yaml 并执行同步。'
          : '将在项目根目录创建空骨架 gaal.yaml，并执行一次同步。',
      detail: mode === 'import-all' ? '导入后可在"配置编辑"页调整，再重新同步。' : '之后可到"部署到项目"页添加 skills / MCP。',
      confirmText: '开始部署',
    });
    if (!ok) return;
    out.style.display = 'block';
    out.textContent = `gaal init --scope project ${mode === 'import-all' ? '--import-all' : '--empty'} 执行中…`;
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/project/init', { method: 'POST', body: { mode } });
      const s = r.sync;
      out.textContent =
        `已创建 ${r.path}\n\n` +
        (r.initOutput ? `[init]\n${r.initOutput}\n\n` : '') +
        (s ? `[sync] exit=${s.code}\n${s.output || ''}${s.stderr ? '\n[stderr]\n' + s.stderr : ''}` : '');
      toast(`部署成功：${r.path}`, 'ok');
      await loadBase();
      views.overview();
    } catch (e) {
      out.textContent = `失败：${e.message}`;
      toast(e.message, 'err');
      if (btn) btn.disabled = false;
    }
  };
  if ($('#ov-init')) $('#ov-init').onclick = (ev) => doInit('empty', ev.target);
  if ($('#ov-init-import')) $('#ov-init-import').onclick = (ev) => doInit('import-all', ev.target);
};

/* ───────────── Agents ───────────── */

views.agents = async () => {
  const agents = cache.agents;
  const skills = cache.audit?.skills || [];
  const byAgent = {};
  for (const s of skills) (byAgent[s.agent] ||= []).push(s);

  $('#content').innerHTML = `
    <div class="toolbar">
      <input type="text" id="ag-filter" placeholder="过滤 agent 名…" />
      <label class="nowrap"><input type="checkbox" id="ag-only-installed" style="width:auto" checked /> 只显示已安装</label>
      <span class="spacer"></span>
      <span class="muted">共 ${agents.length} 个注册 agent</span>
    </div>
    <div class="card scroll-x" style="padding:0">
      <table>
        <thead><tr>
          <th>Agent</th><th>状态</th><th>Skills</th><th>项目级 skills 目录</th><th>全局 skills 目录</th><th>MCP 配置文件</th>
        </tr></thead>
        <tbody id="ag-body"></tbody>
      </table>
    </div>
  `;

  const render = () => {
    const kw = $('#ag-filter').value.trim().toLowerCase();
    const onlyInstalled = $('#ag-only-installed').checked;
    const rows = agents
      .filter((a) => (onlyInstalled ? a.installed : true))
      .filter((a) => !kw || a.name.toLowerCase().includes(kw))
      .map((a) => {
        const own = byAgent[a.name] || [];
        return `<tr>
          <td class="mono nowrap"><strong>${esc(a.name)}</strong></td>
          <td>${a.installed ? '<span class="tag green">已安装</span>' : '<span class="tag">未安装</span>'}</td>
          <td class="mono">${own.length || '<span class="muted">0</span>'}</td>
          <td class="mono muted">${esc(a.project_skills_dir || '—')}</td>
          <td class="mono muted">${esc(a.global_skills_dir || '—')}</td>
          <td class="mono muted">${esc(a.global_mcp_config_file || '—')}</td>
        </tr>`;
      })
      .join('');
    $('#ag-body').innerHTML = rows || '<tr><td colspan="6" class="empty">无匹配</td></tr>';
  };
  $('#ag-filter').oninput = render;
  $('#ag-only-installed').onchange = render;
  render();
};

/* ───────────── Skills ───────────── */

let skMode = localStorage.getItem('gaal-sk-mode') || 'group';

views.skills = async () => {
  const skills = cache.audit?.skills || [];
  const agents = [...new Set(skills.map((s) => s.agent))].sort();
  // 已在当前项目 gaal.yaml 声明的 skill 源路径集合
  const cfg = await api('/api/config').catch(() => null);
  const declaredSkills = ((cfg?.data || {}).skills || []).filter((s) => s && s.source);
  const declaredSet = new Set(declaredSkills.map((s) => s.source));
  // 简写/相对路径声明的末段也计入“已声明”：同一 skill 安装后的绝对路径与
  // 声明里的简写形态不同，只做精确比较会导致重复部署
  const declaredBase = new Set(declaredSkills.filter((s) => !isAbsPath(s.source)).map((s) => basename(s.source)));
  const isDeclared = (s) => declaredSet.has(s.path) || declaredBase.has(basename(s.path));

  $('#content').innerHTML = `
    <div class="toolbar">
      <input type="text" id="sk-search" placeholder="搜索名称 / 描述 / 路径…" />
      <select id="sk-agent" style="max-width:180px">
        <option value="">全部 agent</option>
        ${agents.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}
      </select>
      <select id="sk-source" style="max-width:150px">
        <option value="">全部来源</option>
        <option value="global">global</option>
        <option value="project">project</option>
      </select>
      <div class="seg">
        <button id="sk-mode-group" class="${skMode === 'group' ? 'active' : ''}">按 agent 分组</button>
        <button id="sk-mode-list" class="${skMode === 'list' ? 'active' : ''}">平铺列表</button>
      </div>
      <span class="spacer"></span>
      <span class="muted" id="sk-count"></span>
    </div>
    <div class="bulk-bar hidden" id="sk-bulk">
      <span id="sk-sel-count">已选 0</span>
      <button class="small primary" id="sk-bulk-deploy">批量部署到项目</button>
      <button class="small" id="sk-bulk-enable">批量启用</button>
      <button class="small danger" id="sk-bulk-disable">批量禁用</button>
      <button class="small ghost" id="sk-bulk-clear">取消选择</button>
    </div>
    <div id="sk-area"></div>
  `;

  // 多选：key = agent|path，value = skill 对象（跨过滤/模式切换保持选择）
  const selection = new Map();
  const selKey = (s) => `${s.agent}|${s.path}`;
  const updateBulk = () => {
    const bar = $('#sk-bulk');
    bar.classList.toggle('hidden', selection.size === 0);
    $('#sk-sel-count').textContent = `已选 ${selection.size}`;
  };

  const skillRow = (s, i) => `<tr class="${s.enabled === false ? 'row-disabled' : ''}">
    <td style="width:30px"><input type="checkbox" class="sk-check" data-sk-check="${i}" ${selection.has(selKey(s)) ? 'checked' : ''} /></td>
    <td class="mono"><strong>${esc(s.name)}</strong>${isDeclared(s) ? ' <span class="tag green" style="font-size:10px">已声明</span>' : ''}<div class="muted" style="font-size:11px">${esc(basename(s.path))}</div></td>
    ${skMode === 'list' ? `<td><span class="tag blue">${esc(s.agent)}</span></td>` : ''}
    <td>${s.source === 'global' ? '<span class="tag">global</span>' : `<span class="tag green">${esc(s.source)}</span>`}</td>
    <td class="desc">${esc(s.desc || (s.parseError ? '（SKILL.md frontmatter 解析失败，建议修复）' : '—'))}</td>
    <td><button class="small toggle-btn ${s.enabled === false ? 'off' : 'on'}" data-toggle-sk="${i}" title="${s.enabled === false ? '点击启用（从备份恢复）' : '点击禁用（移出并解除声明，可恢复）'}">${s.enabled === false ? '已禁用' : '启用中'}</button></td>
    <td>${s.enabled === false ? '' : `<button class="small" data-deploy="${esc(s.name)}" data-agent="${esc(s.agent)}" data-path="${esc(s.path)}">部署到项目</button>${s.source === 'project' ? ` <button class="small" data-promote-sk="${i}" title="写入用户级 ~/.config/gaal/config.yaml（global: true）">提升到全局</button>` : ''}`}</td>
  </tr>`;

  const bindRows = (list) => {
    // 每个表格头部的全选框：只影响本表内的行
    $$('#sk-area .sk-check-all').forEach((all) => {
      const sync = () => {
        const boxes = $$('input[data-sk-check]', all.closest('table'));
        const on = boxes.length && boxes.every((b) => b.checked);
        all.checked = on;
      };
      all.closest('table').querySelectorAll('input[data-sk-check]').forEach((b) => b.addEventListener('change', sync));
      all.onclick = () => {
        const want = all.checked;
        $$('input[data-sk-check]', all.closest('table')).forEach((b) => {
          if (b.checked === want) return;
          b.checked = want;
          const s = list[Number(b.dataset.skCheck)];
          if (want) selection.set(selKey(s), s);
          else selection.delete(selKey(s));
        });
        updateBulk();
      };
      sync();
    });

    $$('#sk-area [data-sk-check]').forEach((cb) => {
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => {
        const s = list[Number(cb.dataset.skCheck)];
        if (cb.checked) selection.set(selKey(s), s);
        else selection.delete(selKey(s));
        updateBulk();
      };
    });

    $$('#sk-area [data-toggle-sk]').forEach((btn) => {
      btn.onclick = async () => {
        const s = list[Number(btn.dataset.toggleSk)];
        const off = s.enabled !== false;
        if (off) {
          const ok = await confirmDialog({
            title: '禁用 skill',
            message: `确定禁用 "${s.name}"（${s.agent}）？`,
            detail: '文件将移动到备份区并解除 gaal.yaml 声明，可随时恢复。',
            confirmText: '禁用',
            tone: 'danger',
          });
          if (!ok) return;
        }
        btn.disabled = true;
        try {
          const r = await api('/api/toggle/skill', {
            method: 'POST',
            body: { agent: s.agent, skillPath: s.path, enabled: !off },
          });
          toast(off ? `已禁用 ${s.name}（${r.mode === 'move' ? '已备份' : 'ok'}）` : `已启用 ${s.name}`, 'ok');
          await loadBase();
          views.skills();
        } catch (e) {
          toast('操作失败: ' + e.message, 'err');
          btn.disabled = false;
        }
      };
    });

    $$('#sk-area [data-promote-sk]').forEach((btn) => {
      btn.onclick = async () => {
        const s = list[Number(btn.dataset.promoteSk)];
        const ok = await confirmDialog({
          title: '提升 skill 到全局',
          message: `把项目级 skill "${s.name}" 提升到全局？`,
          detail: '将写入用户级 ~/.config/gaal/config.yaml（global: true），并从当前项目 gaal.yaml 移除。',
          confirmText: '提升到全局',
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          const r = await api('/api/promote/skill', { method: 'POST', body: { source: s.path, agents: ['*'], removeFromProject: true } });
          toast(r.warning || `已提升到全局：${r.path}`, r.warning ? 'err' : 'ok');
          await loadBase();
          views.skills();
        } catch (e) {
          toast('操作失败: ' + e.message, 'err');
          btn.disabled = false;
        }
      };
    });

    $$('#sk-area [data-deploy]').forEach((btn) => {
      btn.onclick = () => skillDeployModal({ name: btn.dataset.deploy, path: btn.dataset.path });
    });
  };

  const render = () => {
    const kw = $('#sk-search').value.trim().toLowerCase();
    const ag = $('#sk-agent').value;
    const src = $('#sk-source').value;
    const list = skills
      .filter((s) => !ag || s.agent === ag)
      .filter((s) => !src || s.source === src)
      .filter(
        (s) =>
          !kw ||
          (s.name || '').toLowerCase().includes(kw) ||
          (s.desc || '').toLowerCase().includes(kw) ||
          (s.path || '').toLowerCase().includes(kw),
      );
    $('#sk-count').textContent = `${list.length} / ${skills.length}`;
    const cols = skMode === 'list' ? 7 : 6;
    const head = `<thead><tr>
      <th style="width:30px"><input type="checkbox" class="sk-check-all" title="全选/取消全选（本表）" /></th>
      <th style="width:220px">Skill</th>${skMode === 'list' ? '<th style="width:120px">Agent</th>' : ''}<th style="width:80px">范围</th><th>描述</th><th style="width:90px">状态</th><th style="width:150px">操作</th>
    </tr></thead>`;

    if (skMode === 'list') {
      $('#sk-area').innerHTML = `<div class="card scroll-x" style="padding:0"><table>${head}<tbody id="sk-body">${
        list.map((s, i) => skillRow(s, i)).join('') || `<tr><td colspan="${cols}" class="empty">无匹配</td></tr>`
      }</tbody></table></div>`;
      bindRows(list);
      return;
    }

    // 分组模式：按 agent 聚合，数量多的在前
    const groups = new Map();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!groups.has(s.agent)) groups.set(s.agent, []);
      groups.get(s.agent).push(i);
    }
    const ordered = [...groups.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
    $('#sk-area').innerHTML =
      ordered
        .map(([agent, idxs], gi) => {
          const rows = idxs.map((i) => skillRow(list[i], i)).join('');
          const g = list[idxs[0]];
          const nGlobal = idxs.filter((i) => list[i].source === 'global').length;
          const nProj = idxs.length - nGlobal;
          const nOff = idxs.filter((i) => list[i].enabled === false).length;
          return `
          <div class="card agent-group" style="padding:0;margin-bottom:12px">
            <div class="group-head" data-gi="${gi}">
              <span class="chev">▸</span>
              <strong>${esc(agent)}</strong>
              <span class="tag blue">${idxs.length} skills</span>
              ${nGlobal ? `<span class="tag">global ${nGlobal}</span>` : ''}
              ${nProj ? `<span class="tag green">project ${nProj}</span>` : ''}
              ${nOff ? `<span class="tag err">禁用 ${nOff}</span>` : ''}
              <span class="spacer"></span>
              <span class="muted mono" style="font-size:11px">${esc(dirnameOf(g.path))}</span>
            </div>
            <div class="group-body" hidden>
              <div class="scroll-x"><table>${head}<tbody>${rows}</tbody></table></div>
            </div>
          </div>`;
        })
        .join('') || '<div class="empty">无匹配</div>';

    $$('#sk-area .group-head').forEach((h) => {
      h.onclick = () => {
        const body = h.nextElementSibling;
        body.hidden = !body.hidden;
        h.querySelector('.chev').textContent = body.hidden ? '▸' : '▾';
      };
    });
    bindRows(list);
  };

  const setMode = (m) => {
    skMode = m;
    localStorage.setItem('gaal-sk-mode', m);
    $('#sk-mode-group').classList.toggle('active', m === 'group');
    $('#sk-mode-list').classList.toggle('active', m === 'list');
    render();
  };
  $('#sk-mode-group').onclick = () => setMode('group');
  $('#sk-mode-list').onclick = () => setMode('list');
  $('#sk-search').oninput = render;
  $('#sk-agent').onchange = render;
  $('#sk-source').onchange = render;

  /* 批量操作 */
  const bulkDeploy = async () => {
    const items = [...selection.values()];
    if (!items.length) return toast('请先勾选', 'err');
    const ok = await confirmDialog({
      title: '批量部署到项目',
      message: `将把 ${items.length} 个 skill 写入当前项目 gaal.yaml（global: false，agents: *）。`,
      detail: items.slice(0, 12).map((s) => s.name).join('、') + (items.length > 12 ? ` 等 ${items.length} 个` : ''),
      confirmText: `部署 ${items.length} 个`,
    });
    if (!ok) return;
    let done = 0;
    const errs = [];
    for (const s of items) {
      try {
        await api('/api/deploy/skill', { method: 'POST', body: { source: s.path, agents: ['*'] } });
        done++;
      } catch (e) {
        errs.push(`${s.name}: ${e.message}`);
      }
    }
    if (errs.length) {
      console.warn('批量部署失败：', errs);
      toast(`已写入 ${done} 个，失败 ${errs.length} 个`, 'err');
    }
    selection.clear();
    await loadBase();
    views.skills();
    if (done) await afterDeploy(done, ' skill');
  };
  const bulkToggle = async (enable) => {
    const items = [...selection.values()];
    if (!items.length) return toast('请先勾选', 'err');
    if (enable) {
      const on = items.filter((s) => s.enabled === false);
      if (!on.length) return toast('所选 skill 均已启用', 'err');
      return runBulkToggle(on, true);
    }
    const off = items.filter((s) => s.enabled !== false);
    if (!off.length) return toast('所选 skill 均已禁用', 'err');
    const ok = await confirmDialog({
      title: '批量禁用 skill',
      message: `确定禁用 ${off.length} 个 skill？`,
      detail: '文件将移动到备份区并解除 gaal.yaml 声明，可随时恢复。',
      confirmText: `禁用 ${off.length} 个`,
      tone: 'danger',
    });
    if (!ok) return;
    runBulkToggle(off, false);
  };
  const runBulkToggle = async (items, enable) => {
    let done = 0;
    const errs = [];
    for (const s of items) {
      try {
        await api('/api/toggle/skill', { method: 'POST', body: { agent: s.agent, skillPath: s.path, enabled: enable } });
        done++;
      } catch (e) {
        errs.push(`${s.name}: ${e.message}`);
      }
    }
    toast(`${enable ? '启用' : '禁用'} ${done}/${items.length}${errs.length ? `，失败 ${errs.length}` : ''}`, errs.length ? 'err' : 'ok');
    if (errs.length) console.warn('批量开关失败：', errs);
    selection.clear();
    await loadBase();
    views.skills();
  };
  $('#sk-bulk-deploy').onclick = bulkDeploy;
  $('#sk-bulk-enable').onclick = () => bulkToggle(true);
  $('#sk-bulk-disable').onclick = () => bulkToggle(false);
  $('#sk-bulk-clear').onclick = () => {
    selection.clear();
    updateBulk();
    render();
  };
  updateBulk();
  render();
};

/* ───────────── MCP ───────────── */

views.mcps = async () => {
  const mcps = cache.mcps || [];
  const agentNames = [...new Set(mcps.map((m) => m.agent))].sort();

  // 重复检测：同名 MCP 出现在多少个不同配置文件（agent + file + scope）
  const fileKey = (m) => `${m.agent}|${m.file}|${m.scope}`;
  const byName = {};
  for (const m of mcps) (byName[m.name] ||= new Set()).add(fileKey(m));
  const dupNames = new Set(Object.entries(byName).filter(([, set]) => set.size > 1).map(([n]) => n));
  const dupCount = dupNames.size;

  $('#content').innerHTML = `
    ${
      dupCount
        ? `<div class="dup-banner">⚠️ 检测到 <strong>${dupCount}</strong> 个 MCP 在多个 agent 配置文件中重复定义：<span class="mono">${[...dupNames].join('、')}</span>。它们各自独立生效，可按需保留或清理多余的。</div>`
        : ''
    }
    <div class="toolbar">
      <input type="text" id="mcp-search" placeholder="搜索名称 / 命令 / URL…" />
      <select id="mcp-agent" style="max-width:170px">
        <option value="">全部 agent</option>
        ${agentNames.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}
      </select>
      <select id="mcp-scope" style="max-width:140px">
        <option value="">全部范围</option>
        <option value="global">global</option>
        <option value="project">project</option>
      </select>
      ${dupCount ? '<label class="chk"><input type="checkbox" id="mcp-only-dup" /> 只看重复</label>' : ''}
      <span class="spacer"></span>
      <span class="muted" id="mcp-count"></span>
      <button class="primary" id="mcp-add">+ 添加 MCP 到项目</button>
    </div>
    <div class="card scroll-x" style="padding:0">
      <table>
        <thead><tr>
          <th style="width:170px">名称</th><th style="width:110px">Agent</th><th style="width:70px">范围</th>
          <th style="width:70px">类型</th><th>启动命令 / URL</th><th style="width:100px">状态</th><th style="width:100px">操作</th>
        </tr></thead>
        <tbody id="mcp-body"></tbody>
      </table>
    </div>
    <p class="muted" style="font-size:12px;margin-top:12px">
      本页面直接解析各 agent 的 MCP 配置文件（JSON / TOML / YAML），因此能看到 <span class="mono">gaal audit</span> 遗漏的条目——例如 Codex 的 <span class="mono">~/.codex/config.toml</span> 里的 <span class="mono">[mcp_servers.*]</span>。
    </p>
    ${
      !mcps.length
        ? `<div class="empty" style="margin-top:14px">未发现任何 MCP 配置。可在上方"添加 MCP 到项目"手动新增。</div>`
        : ''
    }
  `;

  const render = () => {
    const kw = $('#mcp-search').value.trim().toLowerCase();
    const ag = $('#mcp-agent').value;
    const sc = $('#mcp-scope').value;
    const onlyDup = $('#mcp-only-dup')?.checked;
    const list = mcps
      .filter((m) => !ag || m.agent === ag)
      .filter((m) => !sc || m.scope === sc)
      .filter((m) => !onlyDup || dupNames.has(m.name))
      .filter(
        (m) =>
          !kw ||
          (m.name || '').toLowerCase().includes(kw) ||
          (m.command || '').toLowerCase().includes(kw) ||
          (m.url || '').toLowerCase().includes(kw) ||
          (m.file || '').toLowerCase().includes(kw),
      );
    $('#mcp-count').textContent = `${list.length} / ${mcps.length}`;
    $('#mcp-body').innerHTML =
      list
        .map((m, i) => {
          const target = m.url ? m.url : [m.command, ...(m.args || [])].filter(Boolean).join(' ');
          const isDup = dupNames.has(m.name);
          const dupTag = isDup ? `<span class="tag warn" style="font-size:10px" title="同名 MCP 还出现在其他 ${byName[m.name].size - 1} 个配置文件">重复×${byName[m.name].size}</span>` : '';
          return `<tr class="${m.enabled === false ? 'row-disabled' : ''} ${isDup ? 'row-dup' : ''}">
            <td class="mono"><strong>${esc(m.name)}</strong> ${dupTag}<div class="muted" style="font-size:11px">${esc(basename(m.file))}</div></td>
            <td><span class="tag blue">${esc(m.agent)}</span></td>
            <td>${m.scope === 'global' ? '<span class="tag">global</span>' : '<span class="tag green">project</span>'}</td>
            <td><span class="tag ${m.type === 'http' ? 'warn' : ''}">${esc(m.type)}</span></td>
            <td class="mono desc" title="${esc(target)}">${esc(target || '—')}</td>
            <td><button class="small toggle-btn ${m.enabled === false ? 'off' : 'on'}" data-toggle-mcp="${i}" title="${m.enabled === false ? (m.hardDisabled ? '点击启用（恢复条目与声明）' : '点击启用') : '点击禁用（软开关或移除条目，可恢复）'}">${m.enabled === false ? (m.hardDisabled ? '已禁用(硬)' : '已禁用') : '启用中'}</button></td>
            <td><button class="small" data-idx="${i}">${m.scope === 'project' ? '提升到全局' : '部署到项目'}</button></td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="7" class="empty">无匹配</td></tr>';

    $$('#mcp-body [data-toggle-mcp]').forEach((btn) => {
      btn.onclick = async () => {
        const m = list[Number(btn.dataset.toggleMcp)];
        const enable = m.enabled === false;
        if (!enable) {
          const ok = await confirmDialog({
            title: '禁用 MCP',
            message: `确定禁用 "${m.name}"（${m.agent}）？`,
            detail: '支持 enabled 字段的 agent 走软开关；其余将移除条目并备份，可随时恢复。',
            confirmText: '禁用',
            tone: 'danger',
          });
          if (!ok) return;
        }
        btn.disabled = true;
        try {
          const r = await api('/api/toggle/mcp', {
            method: 'POST',
            body: { agent: m.agent, name: m.name, scope: m.scope, file: m.file, enabled: enable },
          });
          toast(enable ? `已启用 ${m.name}（${r.mode}）` : `已禁用 ${m.name}（${r.mode}开关）`, 'ok');
          await loadBase();
          views.mcps();
        } catch (e) {
          toast('操作失败: ' + e.message, 'err');
          btn.disabled = false;
        }
      };
    });

    $$('#mcp-body [data-idx]').forEach((b) => {
      b.onclick = async () => {
        const m = list[Number(b.dataset.idx)];
        if (m.scope !== 'project') return mcpForm(m);
        // 项目级 → 提升到全局
        const ok = await confirmDialog({
          title: '提升 MCP 到全局',
          message: `把项目级 MCP "${m.name}" 提升到全局？`,
          detail: '将写入用户级 ~/.config/gaal/config.yaml（global: true），并从当前项目 gaal.yaml 移除。',
          confirmText: '提升到全局',
        });
        if (!ok) return;
        b.disabled = true;
        try {
          const inline = m.type === 'http' ? { type: 'http', url: m.url } : { command: m.command || '', args: m.args || [] };
          const r = await api('/api/promote/mcp', { method: 'POST', body: { name: m.name, agents: ['*'], inline, removeFromProject: true } });
          toast(r.warning || `已提升到全局：${r.path}`, r.warning ? 'err' : 'ok');
          await loadBase();
          views.mcps();
        } catch (e) {
          toast('操作失败: ' + e.message, 'err');
          b.disabled = false;
        }
      };
    });
  };
  $('#mcp-search').oninput = render;
  $('#mcp-agent').onchange = render;
  $('#mcp-scope').onchange = render;
  if ($('#mcp-only-dup')) $('#mcp-only-dup').onchange = render;
  $('#mcp-add').onclick = () => mcpForm(null);
  render();
};

/**
 * MCP 表单。
 * @param {{name:string,command?:string,args?:string[],url?:string,type?:string}|null} preset
 */
function mcpForm(preset) {
  const p = preset || {};
  openModal(
    `<h2>${preset ? '部署 MCP 到当前项目' : '添加 MCP 到当前项目'}</h2>
     ${preset ? `<p class="muted" style="margin-top:0">来源：<span class="mono">${esc(preset.agent)} · ${esc(basename(preset.file))}</span>，已预填原始配置。</p>` : ''}
     <label class="field"><span>名称</span><input type="text" id="m-name" value="${esc(p.name ?? '')}" placeholder="例如 context7" /></label>
     <label class="field"><span>目标 agents（逗号分隔，* 表示全部已检测 agent）</span><input type="text" id="m-agents" value="*" /></label>
     <label class="field"><span>启动命令 command</span><input type="text" id="m-cmd" value="${esc(p.command ?? '')}" placeholder="npx / uvx / node …" /></label>
     <label class="field"><span>参数 args（每行一个）</span><textarea id="m-args" rows="3" placeholder="-y&#10;@upstash/context7-mcp">${esc((p.args || []).join('\n'))}</textarea></label>
     <label class="field"><span>或 HTTP 类型 URL（填写后忽略 command/args）</span><input type="text" id="m-url" value="${esc(p.url ?? '')}" placeholder="https://example.com/mcp" /></label>
     <div class="modal-actions">
       <button class="ghost" onclick="closeModal()">取消</button>
       <button class="primary" id="m-ok">写入配置</button>
     </div>`,
    (root) => {
      $('#m-ok', root).onclick = async () => {
        const name = $('#m-name', root).value.trim();
        if (!name) return toast('名称必填', 'err');
        const ags = $('#m-agents', root).value.split(',').map((x) => x.trim()).filter(Boolean);
        const url = $('#m-url', root).value.trim();
        const cmd = $('#m-cmd', root).value.trim();
        const args = $('#m-args', root).value.split('\n').map((x) => x.trim()).filter(Boolean);
        let inline;
        if (url) inline = { type: 'http', url };
        else if (cmd) inline = { command: cmd, args };
        else return toast('需要 command 或 url', 'err');
        try {
          const pv = await api('/api/preview/mcp', { method: 'POST', body: { name, agents: ags, inline } });
          const ok = await confirmDialog({
            title: pv.replaced ? '更新 MCP 声明' : '添加 MCP 到当前项目',
            message: `将把 "${name}" ${pv.replaced ? '原位更新到' : '写入'}当前项目的 gaal.yaml：`,
            diff: pv.diff,
            confirmText: '确认写入',
          });
          if (!ok) return;
          await api('/api/deploy/mcp', { method: 'POST', body: { name, agents: ags, inline } });
          closeModal();
          await afterDeploy(1, ' MCP');
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    },
  );
}

/* ───────────── 项目级部署 ───────────── */

/** 部署 skill 到项目级的弹窗（Skills 页与「项目级部署」页共用），含 diff 预览确认 */
function skillDeployModal(s) {
  openModal(
    `<h2>部署 skill 到项目级</h2>
     <p class="muted">写入当前项目的 <span class="mono">gaal.yaml</span>，并设置 <span class="mono">global: false</span>。</p>
     <label class="field"><span>Skill 名称</span><input type="text" value="${esc(s.name)}" readonly /></label>
     <label class="field"><span>source（gaal.yaml 中记录的来源）</span><input type="text" id="dp-source" value="${esc(s.path)}" /></label>
     <label class="field"><span>目标 agents（逗号分隔，* 表示全部）</span><input type="text" id="dp-agents" value="*" /></label>
     <div class="modal-actions">
       <button class="ghost" onclick="closeModal()">取消</button>
       <button class="primary" id="dp-ok">写入配置</button>
     </div>`,
    (root) => {
      $('#dp-ok', root).onclick = async () => {
        const source = $('#dp-source', root).value.trim();
        const ags = $('#dp-agents', root).value.split(',').map((x) => x.trim()).filter(Boolean);
        try {
          // 部署前先算 diff，让用户确认 gaal.yaml 将发生的变化
          const pv = await api('/api/preview/skill', { method: 'POST', body: { source, agents: ags } });
          const ok = await confirmDialog({
            title: pv.replaced ? '更新部署声明' : '部署 skill 到项目级',
            message: `将把该 skill ${pv.replaced ? '原位更新到' : '写入'}当前项目的 gaal.yaml：`,
            diff: pv.diff,
            confirmText: '确认写入',
          });
          if (!ok) return;
          await api('/api/deploy/skill', { method: 'POST', body: { source, agents: ags } });
          closeModal();
          await afterDeploy(1, ' skill');
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    },
  );
}

views.deploy = async () => {
  const skills = cache.audit?.skills || [];
  const agents = cache.agents.filter((a) => a.installed).map((a) => a.name);
  const cfg = await api('/api/config');
  const declared = cfg.data || {};
  const declaredSkillList = (declared.skills || []).filter((s) => s && s.source);
  const declaredSkills = new Set(declaredSkillList.map((s) => s.source));
  // 简写声明的末段也算已声明，避免同一 skill 以不同 source 形态重复部署
  const declaredBase = new Set(declaredSkillList.filter((s) => !isAbsPath(s.source)).map((s) => basename(s.source)));
  const declaredMcps = new Set((declared.mcps || []).map((m) => m.name));

  // 当前项目目录内实际存在的资源：skills 按路径位于项目目录下识别，MCP 取 project 作用域
  const projDir = cache.meta?.projectDir || '';
  const projNorm = projDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const projSkills = skills.filter((s) => projNorm && (s.path || '').replace(/\\/g, '/').toLowerCase().startsWith(`${projNorm}/`));
  const projMcps = (cache.mcps || []).filter((m) => m.scope === 'project');
  const skillDeclared = (s) => declaredSkills.has(s.path) || declaredBase.has(basename(s.path));

  const projSkillRow = (s) => {
    const off = s.enabled === false;
    const done = skillDeclared(s);
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="mono"><strong>${esc(s.name)}</strong></span>
        <span class="tag blue">${esc(s.agent)}</span>
        ${off ? '<span class="tag err">已禁用</span>' : ''}
        ${done ? '<span class="tag green">已声明</span>' : ''}
        <span style="flex:1"></span>
        ${!off && !done ? `<button class="small" data-pj-deploy="${esc(s.name)}" data-pj-path="${esc(s.path)}">写入声明</button>` : ''}
      </div>
      <div class="mono muted" style="font-size:10px;word-break:break-all;margin-top:2px">${esc(s.path)}</div>
    </div>`;
  };
  const projMcpRow = (m, i) => {
    const done = declaredMcps.has(m.name);
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="mono"><strong>${esc(m.name)}</strong></span>
        <span class="tag blue">${esc(m.agent)}</span>
        ${done ? '<span class="tag green">已声明</span>' : ''}
        <span style="flex:1"></span>
        ${done ? '' : `<button class="small" data-pj-mcp="${i}">写入声明</button>`}
      </div>
      <div class="mono muted" style="font-size:10px;word-break:break-all;margin-top:2px">${esc(basename(m.file))} · ${esc(m.command || m.url || '')}</div>
    </div>`;
  };

  $('#content').innerHTML = `
    <div class="split">
      <div class="card">
        <h3>从已扫描的 skills 中选择</h3>
        <p class="muted" style="margin-top:0">勾选后点击"部署到项目"，会写入当前项目的 <span class="mono">gaal.yaml</span>（<span class="mono">global: false</span>），然后执行同步即可生效。</p>
        <div class="toolbar">
          <input type="text" id="dp-search" placeholder="搜索 skill…" />
          <select id="dp-agent" style="width:auto"></select>
          <span class="spacer"></span>
          <span class="muted" id="dp-sel-count">已选 0</span>
        </div>
        <div id="dp-list" style="max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius)"></div>
        <div class="toolbar" style="margin-top:12px">
          <button class="primary" id="dp-deploy">部署所选到项目</button>
          <button class="ghost" id="dp-all">全选</button>
          <button class="ghost" id="dp-none">清空</button>
        </div>
      </div>

      <div class="card">
        <h3>从 GitHub 导入 skill</h3>
        <label class="field"><span>owner/repo 或完整 GitHub URL</span>
          <input type="text" id="gh-input" placeholder="obra/superpowers" /></label>
        <label class="field"><span>目标 agents（逗号分隔）</span><input type="text" id="gh-agents" value="*" /></label>
        <div class="toolbar">
          <button class="primary" id="gh-import">导入</button>
          <button class="ghost" id="gh-preview">仅预览内容</button>
        </div>
        <pre class="output" id="gh-out" style="display:none"></pre>

        <h3 style="margin-top:20px">搜索 registry（skills.sh）</h3>
        <div class="toolbar">
          <input type="text" id="rg-q" placeholder="关键词，如 react" />
          <button id="rg-search">搜索</button>
        </div>
        <pre class="output" id="rg-out" style="display:none"></pre>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>
        当前项目内的资源
        <span class="tag blue" title="${esc(projDir)}">${esc(basename(projDir) || projDir || '—')}</span>
        <span class="muted" style="font-size:11px;font-weight:400">按项目目录下的路径 / project 作用域识别</span>
      </h3>
      <div class="split">
        <div>
          <div class="muted" style="margin-bottom:6px">项目内 Skills (${projSkills.length})</div>
          ${projSkills.length ? projSkills.map(projSkillRow).join('') : '<div class="empty" style="padding:14px">项目目录下未发现 skills</div>'}
        </div>
        <div>
          <div class="muted" style="margin-bottom:6px">项目内 MCP (${projMcps.length})</div>
          ${projMcps.length ? projMcps.map(projMcpRow).join('') : '<div class="empty" style="padding:14px">项目内未发现 project 级 MCP 配置</div>'}
        </div>
      </div>
      ${
        !projSkills.length && !projMcps.length
          ? '<p class="muted" style="font-size:12px;margin-bottom:0">刚切换了项目？点右上角「刷新」重新扫描。项目内 skills 需位于项目的 skills 目录（如 .claude/skills、.zcode/skills 等）下才会被识别。</p>'
          : ''
      }
    </div>

    <div class="card" style="margin-top:14px">
      <h3>当前项目 gaal.yaml 已声明的资源</h3>
      ${
        declaredSkills.size || declaredMcps.size
          ? `<div class="split">
              <div>
                <div class="muted" style="margin-bottom:6px">Skills (${declaredSkills.size})</div>
                ${(declared.skills || []).map((s) => `<div class="mono" style="padding:5px 0;border-bottom:1px solid var(--border)">
                    ${esc(s.source)} <span class="tag">${esc((s.agents || []).join(',') || '*')}</span>
                    <button class="small ghost" style="float:right" data-rm-skill="${esc(s.source)}">移除</button>
                  </div>`).join('') || '<div class="empty">无</div>'}
              </div>
              <div>
                <div class="muted" style="margin-bottom:6px">MCP (${declaredMcps.size})</div>
                ${(declared.mcps || []).map((m) => `<div class="mono" style="padding:5px 0;border-bottom:1px solid var(--border)">
                    ${esc(m.name)} <span class="tag">${esc((m.agents || []).join(',') || '*')}</span>
                    <button class="small ghost" style="float:right" data-rm-mcp="${esc(m.name)}">移除</button>
                  </div>`).join('') || '<div class="empty">无</div>'}
              </div>
            </div>`
          : '<div class="empty">当前项目还没有声明任何 skill / MCP</div>'
      }
    </div>
  `;

  // 按 skill 名称去重：同一 skill 装在多个 agent 目录下时路径各不相同，
  // 按路径去重挡不住这种重复，故按名称（+作用域）合并，agent 收进标签
  const byName = new Map();
  for (const s of skills) {
    const key = `${(s.name || '').toLowerCase()}::${s.source === 'project' ? 'project' : 'global'}`;
    const g = byName.get(key);
    if (g) {
      if (!g.agents.includes(s.agent)) g.agents.push(s.agent);
      if (!g.paths.includes(s.path)) g.paths.push(s.path);
      if (!g.desc && s.desc) g.desc = s.desc;
    } else {
      byName.set(key, { ...s, agents: [s.agent], paths: [s.path] });
    }
  }
  const uniq = [...byName.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  $('#dp-agent').innerHTML =
    '<option value="">全部 agent</option>' +
    [...new Set(skills.map((s) => s.agent))].sort().map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');

  const renderList = () => {
    const kw = $('#dp-search').value.trim().toLowerCase();
    const ag = $('#dp-agent').value;
    const filtered = uniq.filter(
      (s) =>
        (!ag || s.agents.includes(ag)) &&
        (!kw || (s.name || '').toLowerCase().includes(kw) || (s.desc || '').toLowerCase().includes(kw)),
    );
    const html = filtered
      .map((s) => {
        const done = s.paths.some((p) => declaredSkills.has(p)) || declaredBase.has(basename(s.path));
        const badge =
          s.agents.length > 2
            ? `<span class="tag" title="${esc(s.agents.join(', '))}">${s.agents.length} 个 agent</span>`
            : s.agents.map((x) => `<span class="tag">${esc(x)}</span>`).join('');
        return `<label style="display:flex;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border);cursor:pointer;align-items:flex-start">
          <input type="checkbox" value="${esc(s.path)}" data-name="${esc(s.name)}" style="width:auto;margin-top:3px" ${done ? 'disabled' : ''} />
          <div style="min-width:0;flex:1">
            <div class="mono" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${esc(s.name)}
              ${s.source === 'project' ? '<span class="tag blue">项目</span>' : ''}
              ${done ? '<span class="tag green">已声明</span>' : ''}
              ${badge}
            </div>
            <div class="desc muted" style="font-size:11px">${esc((s.desc || '').slice(0, 120))}</div>
          </div>
        </label>`;
      })
      .join('');
    $('#dp-list').innerHTML = html || '<div class="empty">无匹配</div>';
    updateCount();
  };
  const updateCount = () => {
    $('#dp-sel-count').textContent = `已选 ${$$('#dp-list input:checked').length} / 共 ${uniq.length}`;
  };
  $('#dp-search').oninput = renderList;
  $('#dp-agent').onchange = renderList;
  $('#dp-list').onchange = updateCount;
  $('#dp-all').onclick = () => {
    $$('#dp-list input:not(:disabled)').forEach((i) => (i.checked = true));
    updateCount();
  };
  $('#dp-none').onclick = () => {
    $$('#dp-list input').forEach((i) => (i.checked = false));
    updateCount();
  };
  renderList();
  $('#dp-deploy').onclick = async () => {
    const checked = $$('#dp-list input:checked');
    if (!checked.length) return toast('请先勾选', 'err');
    let ok = 0;
    for (const c of checked) {
      try {
        await api('/api/deploy/skill', { method: 'POST', body: { source: c.value, agents: ['*'] } });
        ok++;
      } catch (e) {
        toast(`${c.dataset.name}: ${e.message}`, 'err');
      }
    }
    renderList();
    if (ok) await afterDeploy(ok, ' skill');
  };

  $('#gh-preview').onclick = async () => {
    const input = $('#gh-input').value.trim();
    if (!input) return toast('请输入仓库地址', 'err');
    const out = $('#gh-out');
    out.style.display = 'block';
    out.textContent = '查询 GitHub…';
    try {
      const r = await api('/api/import/github', { method: 'POST', body: { input, dryRun: true } });
      out.textContent = JSON.stringify(r.detected, null, 2);
    } catch (e) {
      out.textContent = `失败：${e.message}`;
    }
  };
  $('#gh-import').onclick = async () => {
    const input = $('#gh-input').value.trim();
    if (!input) return toast('请输入仓库地址', 'err');
    const out = $('#gh-out');
    out.style.display = 'block';
    out.textContent = '导入中…';
    const ags = $('#gh-agents').value.split(',').map((x) => x.trim()).filter(Boolean);
    try {
      const r = await api('/api/import/github', { method: 'POST', body: { input, agents: ags } });
      const n = (r.detected.skills || []).length;
      out.textContent = `已写入 ${r.path}\n\n检测到的 skills:\n${(r.detected.skills || []).join('\n') || '（无，可能仓库结构与预期不同）'}\n${r.detected.error ? '\n警告: ' + r.detected.error : ''}`;
      if (n > 0) {
        await afterDeploy(n, ' skill');
      } else {
        toast('声明已写入，但未在该仓库检测到 skill 目录', 'err');
        const go = await confirmDialog({
          title: '同步确认',
          message: '声明已写入项目 gaal.yaml，但未检测到 skill 目录。仍要立即执行 gaal sync 吗？',
          confirmText: '⟳ 立即同步',
          cancelText: '稍后再说',
        });
        if (go) await quickSync();
      }
    } catch (e) {
      out.textContent = `失败：${e.message}`;
      toast(e.message, 'err');
    }
  };

  $('#rg-search').onclick = async () => {
    const q = $('#rg-q').value.trim();
    if (!q) return toast('请输入关键词', 'err');
    const out = $('#rg-out');
    out.style.display = 'block';
    out.textContent = 'registry 搜索中（首次需下载 skills 包，请稍候）…';
    try {
      const r = await api(`/api/registry/search?q=${encodeURIComponent(q)}`);
      out.textContent = (r.output || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '');
    } catch (e) {
      out.textContent = `失败：${e.message}`;
    }
  };

  $$('[data-pj-deploy]').forEach((btn) => {
    btn.onclick = () => skillDeployModal({ name: btn.dataset.pjDeploy, path: btn.dataset.pjPath });
  });
  $$('[data-pj-mcp]').forEach((btn) => {
    btn.onclick = () => mcpForm(projMcps[Number(btn.dataset.pjMcp)]);
  });

  $$('[data-rm-skill]').forEach((b) => {
    b.onclick = async () => {
      try {
        // 移除前预览将被删掉的声明
        const pv = await api('/api/preview/remove-skill', { method: 'POST', body: { source: b.dataset.rmSkill } });
        if (!pv.removed) return toast('项目 gaal.yaml 中没有该声明', 'err');
        const ok = await confirmDialog({
          title: '移除 skill 声明',
          message: `从项目 gaal.yaml 移除 "${basename(b.dataset.rmSkill)}" 的声明？`,
          detail: '只移除声明，不会删除磁盘上的 skill 文件。',
          diff: pv.diff,
          confirmText: '确认移除',
          tone: 'danger',
        });
        if (!ok) return;
        await api('/api/deploy/skill', { method: 'DELETE', body: { source: b.dataset.rmSkill } });
        toast('已移除', 'ok');
        show('deploy');
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });
  $$('[data-rm-mcp]').forEach((b) => {
    b.onclick = async () => {
      try {
        const pv = await api('/api/preview/remove-mcp', { method: 'POST', body: { name: b.dataset.rmMcp } });
        if (!pv.removed) return toast('项目 gaal.yaml 中没有该声明', 'err');
        const ok = await confirmDialog({
          title: '移除 MCP 声明',
          message: `从项目 gaal.yaml 移除 "${b.dataset.rmMcp}" 的声明？`,
          detail: '只移除声明，不会修改各 agent 的配置文件。',
          diff: pv.diff,
          confirmText: '确认移除',
          tone: 'danger',
        });
        if (!ok) return;
        await api('/api/deploy/mcp', { method: 'DELETE', body: { name: b.dataset.rmMcp } });
        toast('已移除', 'ok');
        show('deploy');
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });
};

/* ───────────── 配置编辑 ───────────── */

views.config = async () => {
  const cfg = await api('/api/config');
  const userCfg = await api('/api/user-config');

  $('#content').innerHTML = `
    <div class="split">
      <div class="card">
        <h3>项目级 <span class="tag ${cfg.exists ? 'green' : 'warn'}">${cfg.exists ? '存在' : '不存在'}</span></h3>
        <div class="mono muted" style="font-size:11px;margin-bottom:10px">${esc(cfg.path)}</div>
        ${cfg.parseError ? `<div class="tag err" style="margin-bottom:8px">YAML 解析失败: ${esc(cfg.parseError)}</div>` : ''}
        <textarea id="cfg-text" rows="26">${esc(cfg.text)}</textarea>
        <div class="toolbar" style="margin-top:12px">
          <button class="primary" id="cfg-save">保存</button>
          <button class="ghost" id="cfg-reload">重新加载</button>
          <button class="ghost" id="cfg-template">插入模板</button>
        </div>
      </div>
      <div class="card">
        <h3>用户全局配置 <span class="tag ${userCfg.exists ? 'green' : ''}">${userCfg.exists ? '存在' : '不存在'}</span></h3>
        <div class="mono muted" style="font-size:11px;margin-bottom:10px">${esc(userCfg.path)}</div>
        ${
          userCfg.exists
            ? `<textarea id="ucfg-text" rows="26" readonly>${esc(userCfg.text)}</textarea>
               <p class="muted" style="font-size:12px">全局配置为只读预览。编辑请直接用编辑器打开该文件。</p>`
            : `<div class="empty">尚无全局配置。若你希望把部分内容留在全局，可运行 <span class="mono">gaal init --import-all --scope global</span>。</div>`
        }
      </div>
    </div>
  `;

  $('#cfg-save').onclick = async () => {
    try {
      const r = await api('/api/config', { method: 'POST', body: { text: $('#cfg-text').value } });
      toast(`已保存到 ${r.path}`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  $('#cfg-reload').onclick = () => show('config');
  $('#cfg-template').onclick = () => {
    $('#cfg-text').value = `schema: 1

repositories: {}

skills:
  - source: obra/superpowers
    agents: ["*"]
    global: false

content: []

mcps:
  - name: context7
    agents: ["*"]
    global: false
    inline:
      command: npx
      args: ["-y", "@upstash/context7-mcp"]
`;
  };
};

/* ───────────── 同步 ───────────── */

views.sync = async () => {
  const sched = await api('/api/schedule');
  const last = await api('/api/sync/last');

  $('#content').innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h3>执行同步</h3>
        <div class="toolbar">
          <button class="primary" id="sy-run">gaal sync</button>
          <button id="sy-dry">dry-run</button>
          <button id="sy-prune">sync --prune</button>
          <button id="sy-force">sync --force</button>
          <button id="sy-doctor">doctor</button>
        </div>
        <pre class="output" id="sy-out">${esc(lastOutput(last))}</pre>
      </div>

      <div class="card">
        <h3>定时自动同步</h3>
        <label class="field"><span>启用</span>
          <input type="checkbox" id="sch-on" style="width:auto" ${sched.enabled ? 'checked' : ''} /></label>
        <label class="field"><span>间隔（分钟）</span>
          <input type="number" id="sch-int" min="1" value="${sched.intervalMin}" style="max-width:140px" /></label>
        <button class="primary" id="sch-save">保存设置</button>
        <div class="muted" style="margin-top:12px;font-size:12px">
          上次自动同步：<span class="mono">${esc(sched.lastRun || '—')}</span><br />
          结果：<span class="mono">${sched.lastResult ? 'exit=' + sched.lastResult.code : '—'}</span>
        </div>
        <p class="muted" style="font-size:12px">定时任务在服务端进程内运行，关闭面板后仍持续（只要 <span class="mono">node server.js</span> 未退出）。每次执行 <span class="mono">gaal sync</span> 于当前项目目录。</p>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>同步状态（gaal status）</h3>
      <button class="ghost small" id="st-load">加载 status</button>
      <pre class="output" id="st-out" style="display:none;margin-top:10px"></pre>
    </div>
  `;

  function lastOutput(l) {
    if (l.none) return '（本会话尚未执行过同步）';
    return `$ gaal ${l.args.join(' ')}\n\n${l.stdout || ''}${l.stderr ? '\n[stderr]\n' + l.stderr : ''}\nexit=${l.code}  @ ${l.at}`;
  }

  const out = $('#sy-out');
  const run = async (body, label) => {
    out.textContent = `$ gaal ${label}…\n`;
    try {
      const r = await apiStream('/api/sync/stream', body, (t) => {
        out.textContent += t;
        out.scrollTop = out.scrollHeight;
      });
      out.textContent += `\nexit=${r?.code ?? '?'}`;
      toast(r?.ok ? '完成' : `退出码 ${r?.code}`, r?.ok ? 'ok' : 'err');
    } catch (e) {
      out.textContent += `\n失败：${e.message}`;
      toast(e.message, 'err');
    }
  };
  $('#sy-run').onclick = () => run({}, 'sync');
  $('#sy-dry').onclick = () => run({ dryRun: true }, 'dry-run');
  $('#sy-prune').onclick = () => run({ prune: true }, 'sync --prune');
  $('#sy-force').onclick = () => run({ force: true }, 'sync --force');
  $('#sy-doctor').onclick = async () => {
    out.textContent = 'doctor 执行中…';
    const r = await api('/api/doctor', { method: 'POST' });
    out.textContent = r.output + (r.stderr ? '\n' + r.stderr : '');
  };

  $('#sch-save').onclick = async () => {
    const enabled = $('#sch-on').checked;
    const intervalMin = Number($('#sch-int').value) || 60;
    try {
      await api('/api/schedule', { method: 'POST', body: { enabled, intervalMin } });
      toast(enabled ? `已启用，每 ${intervalMin} 分钟同步` : '已停用', 'ok');
      refreshScheduleBadge();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  $('#st-load').onclick = async () => {
    const el = $('#st-out');
    el.style.display = 'block';
    el.textContent = '加载中…';
    try {
      const st = await api('/api/status');
      el.textContent = JSON.stringify(st, null, 2);
    } catch (e) {
      el.textContent = `失败：${e.message}`;
    }
  };
};

/* ───────────── 切换项目 ───────────── */

async function changeProject() {
  let dir = cache.meta?.projectDir || cache.meta?.home || '';
  const select = async (path) => {
    try {
      const res = await api('/api/project/select', { method: 'POST', body: { path } });
      toast(`已切换到 ${res.projectDir}`, 'ok');
      closeModal();
      await loadBase();
      show(currentView);
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const render = async (p) => {
    let r;
    try {
      r = await api(`/api/fs/list?path=${encodeURIComponent(p)}`);
    } catch (e) {
      toast('无法读取目录: ' + e.message, 'err');
      return;
    }
    const rowStyle = 'padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px';
    openModal(
      `<h2>选择项目目录</h2>
       <div class="mono muted" style="font-size:12px;margin-bottom:8px">📍 ${esc(r.current)}</div>
       ${r.drives && r.drives.length ? `<div style="margin-bottom:10px"><span class="muted" style="font-size:11px">切换盘符：</span>
         ${r.drives.map((d) => `<button class="small drive-btn ${r.current.toLowerCase().startsWith(d.path.toLowerCase().slice(0, 2)) ? 'active' : ''}" data-go="${esc(d.path)}">${esc(d.name)}</button>`).join('')}
       </div>` : ''}
       ${r.recent && r.recent.length ? `<div style="margin-bottom:10px"><span class="muted" style="font-size:11px">最近项目：</span>
         ${r.recent.map((d) => `<button class="small recent-btn" data-go="${esc(d)}" title="${esc(d)}">${esc(basename(d))}</button>`).join('')}
       </div>` : ''}
       <div style="border:1px solid var(--border);border-radius:var(--radius);max-height:340px;overflow:auto">
         ${r.parent ? `<div class="fs-row" data-go="${esc(r.parent)}" style="${rowStyle};color:var(--text-dim)">⬆️ .. (上级)</div>` : ''}
         <div class="fs-row" data-select="${esc(r.current)}" style="${rowStyle};color:var(--accent);font-weight:600">✅ 选择当前目录</div>
         ${r.entries.map((e) => `<div class="fs-row" data-go="${esc(e.path)}" style="${rowStyle}">
            <span>${e.hasConfig ? '⭐' : '📁'}</span>
            <span style="flex:1">${esc(e.name)}</span>
            ${e.hasConfig ? '<span class="tag green" style="font-size:10px">gaal.yaml</span>' : ''}
            ${e.hidden ? '<span class="muted" style="font-size:10px">隐藏</span>' : ''}
          </div>`).join('') || '<div class="empty" style="padding:12px">无子目录</div>'}
       </div>
       <label class="field" style="margin-top:12px"><span>或手动输入路径</span><input type="text" id="fs-input" value="${esc(r.current)}" placeholder="例如 D:\\work\\my-project" /></label>
       <div class="modal-actions">
         <button class="ghost" onclick="closeModal()">取消</button>
         <button class="primary" id="fs-ok">打开该路径并选择</button>
       </div>`,
      (root) => {
        $$('.fs-row', root).forEach((el) => {
          el.onmouseenter = () => (el.style.background = 'var(--bg-elev)');
          el.onmouseleave = () => (el.style.background = '');
          if (el.dataset.go) el.onclick = () => render(el.dataset.go);
          if (el.dataset.select) el.onclick = () => select(el.dataset.select);
        });
        $$('.drive-btn, .recent-btn', root).forEach((el) => {
          el.onclick = () => render(el.dataset.go);
        });
        $('#fs-ok', root).onclick = async () => {
          const p = $('#fs-input', root).value.trim();
          if (!p) return;
          // 先尝试作为目录直接选择；失败则进入浏览
          try {
            await api(`/api/fs/list?path=${encodeURIComponent(p)}`).then(() => {});
            await select(p);
          } catch {
            render(p);
          }
        };
      },
    );
  };
  await render(dir);
}

/* ───────────── 启动 ───────────── */

/** 部署成功后的统一收尾：询问是否立即同步 */
async function afterDeploy(okCount, what) {
  toast(`已写入 ${okCount} 个${what}`, 'ok');
  const go = await confirmDialog({
    title: '部署完成',
    message: `已把 ${okCount} 个${what}写入项目 gaal.yaml。`,
    detail: '声明还未生效——现在执行 gaal sync 将其安装到项目目录？',
    confirmText: '⟳ 立即同步',
    cancelText: '稍后再说',
  });
  if (go) await quickSync();
}

/** 全局一键同步：任意页面顶栏可用，完成后 toast 可跳转查看输出 */
let syncing = false;
async function quickSync() {
  if (syncing) return;
  syncing = true;
  const btn = $('#btn-quick-sync');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⟳ 同步中…';
  try {
    const r = await api('/api/sync', { method: 'POST', body: {} });
    toast(r.ok ? '✓ 同步完成' : `同步退出码 ${r.code}`, r.ok ? 'ok' : 'err');
    await loadBase();
    show(currentView);
  } catch (e) {
    toast(`同步失败：${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    syncing = false;
  }
}

$$('#nav button').forEach((b) => (b.onclick = () => show(b.dataset.view)));
// 浏览器后退/前进、手动改 hash 时切换视图
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (VALID_VIEWS.has(v) && v !== currentView) show(v);
});
$('#btn-quick-sync').onclick = quickSync;
$('#btn-refresh').onclick = async () => {
  await loadBase();
  show(currentView);
};
$('#btn-change-project').onclick = changeProject;
$('#stale-pill').onclick = async () => {
  await loadBase();
  show(currentView);
  toast('已刷新到最新数据', 'ok');
};

const initialView = location.hash.slice(1);
loadBase()
  .then(() => show(VALID_VIEWS.has(initialView) ? initialView : 'overview'))
  .catch((e) => {
    $('#content').innerHTML = `<div class="empty">初始化失败：${esc(e.message)}<br /><br />
      请确认 gaal 已安装，或设置环境变量 <span class="mono">GAAL_BIN</span> 指向可执行文件。</div>`;
  });
