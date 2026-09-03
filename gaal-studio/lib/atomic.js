'use strict';

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖目标。
 * 进程在写入中途崩溃/断电时，原文件要么是旧内容要么是新内容，不会写坏一半。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

module.exports = { writeFileAtomic };
