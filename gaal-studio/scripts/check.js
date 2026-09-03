'use strict';

/** 语法检查全部 JS 文件（node --check），配合 npm test 使用：npm run check */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const files = ['server.js'];
for (const dir of ['lib', 'test']) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    if (f.endsWith('.js')) files.push(path.join(dir, f));
  }
}
files.push('public/app.js', 'scripts/check.js');

let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    console.error(`✗ ${f}\n${e.stderr}`);
  }
}
if (bad) {
  console.error(`语法检查失败：${bad} 个文件`);
  process.exit(1);
}
console.log(`✓ 语法检查通过（${files.length} 个文件）`);
