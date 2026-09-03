'use strict';

/**
 * 行级 diff（LCS 算法，零依赖）。
 * 用于部署前预览 gaal.yaml 将发生的变化；配置文件都很小，O(n·m) 足够。
 */

/** 超过此行数不再做精确 diff（防御异常大文件），返回 null 让前端降级为文字提示 */
const MAX_LINES = 2000;

/**
 * @param {string} aText 原文
 * @param {string} bText 新文
 * @returns {Array<{op: ' '|'+'|'-', text: string}>|null} op: ' ' 不变，'+' 新增，'-' 删除
 */
function lineDiff(aText, bText) {
  // 空文本按零行处理：新文件场景不应出现多余的"- 空行"
  const split = (t) => {
    const s = String(t ?? '');
    return s === '' ? [] : s.split('\n');
  };
  const a = split(aText);
  const b = split(bText);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;

  // 掐头去尾，缩小 DP 规模
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ea = a.length;
  let eb = b.length;
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const am = a.slice(start, ea);
  const bm = b.slice(start, eb);
  const m = am.length;
  const n = bm.length;

  const out = [];
  for (let i = 0; i < start; i++) out.push({ op: ' ', text: a[i] });

  if (m && n) {
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (am[i] === bm[j]) {
        out.push({ op: ' ', text: am[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ op: '-', text: am[i] });
        i++;
      } else {
        out.push({ op: '+', text: bm[j] });
        j++;
      }
    }
    while (i < m) out.push({ op: '-', text: am[i++] });
    while (j < n) out.push({ op: '+', text: bm[j++] });
  } else {
    for (const t of am) out.push({ op: '-', text: t });
    for (const t of bm) out.push({ op: '+', text: t });
  }

  for (let k = ea; k < a.length; k++) out.push({ op: ' ', text: a[k] });
  return out;
}

module.exports = { lineDiff };
