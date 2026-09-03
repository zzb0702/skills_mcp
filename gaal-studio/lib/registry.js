'use strict';

const { execFile } = require('node:child_process');
const https = require('node:https');

/** 解析 GitHub 输入：owner/repo 或完整 URL */
function parseGitHub(input) {
  if (!input) return null;
  let s = String(input).trim().replace(/\.git\/?$/, '').replace(/\/+$/, '');
  // 去掉协议、用户名@、可选的 www.
  s = s.replace(/^(?:https?:\/\/|git:\/\/|ssh:\/\/)/i, '').replace(/^[^@/\s]+@/, '').replace(/^www\./i, '');
  let m = s.match(/^(?:github\.com|gitlab\.com|gitee\.com)\/([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (m) return { owner: m[1], repo: m[2], shorthand: `${m[1]}/${m[2]}`, host: 'github.com' };
  m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (m) return { owner: m[1], repo: m[2], shorthand: `${m[1]}/${m[2]}`, host: 'github.com' };
  return null;
}

function githubJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'gaal-studio',
            Accept: 'application/vnd.github+json',
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
          },
          timeout: 15000,
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if (res.statusCode >= 400) {
              return reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
            }
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        },
      )
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error('GitHub API timeout'));
      });
  });
}

/** 列出 repo 根目录下含 SKILL.md 的 skill 子目录 */
async function listRepoSkills(shorthand) {
  const [owner, repo] = shorthand.split('/');
  const info = await githubJson(`https://api.github.com/repos/${owner}/${repo}`);
  const tree = await githubJson(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${info.default_branch}?recursive=1`,
  );
  const names = new Set();
  for (const t of tree.tree || []) {
    if (t.type !== 'blob') continue;
    const p = t.path.replace(/\\/g, '/');
    if (!/(^|\/)SKILL\.md$/i.test(p)) continue;
    const dir = p.split('/').slice(0, -1).join('/');
    if (dir) names.add(dir.split('/').pop());
  }
  return {
    description: info.description || '',
    stars: info.stargazers_count || 0,
    skills: [...names].sort(),
  };
}

/** 通过 npx skills find 搜索 registry（gaal skill search 的底层） */
function registrySearch(keyword) {
  return new Promise((resolve) => {
    execFile(
      'npx',
      ['-y', 'skills', 'find', keyword],
      { timeout: 90000, windowsHide: true, shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout || '',
          stderr: stderr || (err ? err.message : ''),
        });
      },
    );
  });
}

module.exports = { parseGitHub, listRepoSkills, registrySearch };
