'use strict';

/**
 * gaal 未收录 / 未扫描的 agent 注册表（补充层）。
 * ZCode: 用户级 MCP 在 ~/.zcode/cli/config.json（键 mcp.servers），
 *        工作区级在 <项目>/.zcode/config.json（同键），
 *        用户级 skills 在 ~/.zcode/skills/<name>/SKILL.md。
 * Qoder: 用户级 skills 在 ~/.qoder/skills/<name>（常为指向 ~/.agents/skills 的符号链接），
 *        MCP 配置在 ~/.qoder/mcp.json（mcpServers 布局，未配置时文件可能不存在）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const exists = (...p) => fs.existsSync(path.join(os.homedir(), ...p));

const EXTRA_AGENTS = [
  {
    name: 'zcode',
    installed: exists('.zcode'),
    global_skills_dir: path.join(os.homedir(), '.zcode', 'skills'),
    project_skills_dir: '.zcode/skills',
    global_mcp_config_file: path.join(os.homedir(), '.zcode', 'cli', 'config.json'),
    project_mcp_config_file: '.zcode/config.json',
  },
  {
    name: 'qoder',
    installed: exists('.qoder'),
    global_skills_dir: path.join(os.homedir(), '.qoder', 'skills'),
    project_skills_dir: '.qoder/skills',
    global_mcp_config_file: path.join(os.homedir(), '.qoder', 'mcp.json'),
    project_mcp_config_file: '.qoder/mcp.json',
  },
];

module.exports = { EXTRA_AGENTS };
