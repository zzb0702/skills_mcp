# gaal-studio

[gaal](https://github.com/getgaal/gaal) 的本地可视化管理面板：在一个界面里查看和管理所有 AI 编程 agent 的 skills 与 MCP 配置。

![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![deps](https://img.shields.io/badge/runtime%20deps-2-blue)

## 功能

- **总览** — 已安装 agent 数、skill/MCP 数量统计、项目配置概况、快速同步入口
- **Agents** — gaal 注册的全部 agent（含补充的 zcode / qoder），安装状态与目录位置
- **Skills 清单** — 按 agent 分组或平铺浏览，搜索过滤，一键启用/禁用（可逆）、部署到项目、提升到全局、批量操作
- **MCP Servers** — 直接解析各 agent 的 JSON / TOML / YAML 配置（覆盖 `gaal audit` 的盲区），重复定义检测，软/硬开关
- **项目级部署** — 勾选本机 skills 写入项目 `gaal.yaml`，从 GitHub 导入（含仓库信息缓存），registry 搜索；**单条部署/移除前会展示对 `gaal.yaml` 的行级 diff 预览**，确认后才写入
- **配置编辑** — 项目级 / 用户级 `gaal.yaml` 查看、校验、保存
- **同步** — `gaal sync`（dry-run / prune / force）、健康检查、定时自动同步、SSE 实时输出；服务端对同步互斥（手动与定时不会并发跑多个 gaal）
- **数据更新提示** — 每 25 秒轮询状态签名，其他窗口或定时任务改动了数据时顶栏出现刷新提示（不自动刷新，避免打断编辑）

所有配置写入均为原子操作（临时文件 + rename），面板操作会尽量保留你手写的 YAML 注释。

## 前置要求

- Node.js ≥ 18
- [gaal](https://github.com/getgaal/gaal) 可执行文件，按以下顺序查找：
  1. 环境变量 `GAAL_BIN`
  2. `~/bin/gaal.exe`（或 `~/bin/gaal`）
  3. `C:\Program Files\Go\bin\gaal.exe`
  4. `%LOCALAPPDATA%\Programs\gaal\gaal.exe`
  5. 系统 PATH

## 启动

```bat
:: Windows
start.bat          :: 启动并自动打开浏览器

:: 任意平台
npm start          :: http://127.0.0.1:7788
npm run dev        :: --watch 模式
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `7788` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；改为 `0.0.0.0` 可局域网访问（见安全模型） |
| `GAAL_BIN` | — | gaal 可执行文件路径 |
| `GAAL_STUDIO_NO_OPEN` | — | 设为 `1` 时启动不自动打开浏览器 |

## 安全模型

- 服务默认只监听 `127.0.0.1`，且校验 `Host` 头必须指向本机（防 DNS rebinding：恶意网页无法借你的浏览器调用面板 API）。
- 若显式以 `HOST=0.0.0.0` 监听以便局域网使用，Host 校验会自动放宽，此时请自行确保网络环境可信。
- 没有登录鉴权——这是设计给单机单人用的工具，不要暴露到公网。

## 文件布局

| 路径 | 用途 |
|---|---|
| `<项目>/gaal.yaml` | 项目级 gaal 配置（面板部署/提升的目标） |
| `~/.config/gaal/config.yaml` | 用户级 gaal 配置（提升到全局的目标） |
| `~/.config/gaal-studio/disabled.json` | 禁用记录（恢复的依据） |
| `~/.config/gaal-studio/disabled-skills/` | 被禁用 skill 的备份区 |
| `gaal-studio/studio.json` | 面板自身状态（当前项目、最近目录、定时开关） |

## 开发

```bash
npm test     # node:test 测试套件（lib 单元测试 + HTTP 冒烟）
npm run check  # 全部 JS 文件语法检查 + 测试
```

代码结构：

```
server.js            HTTP 服务与 API 路由（零框架）
lib/gaal.js          gaal CLI 封装（含流式 sync）
lib/config.js        gaal.yaml 读写：注释保留的文本级列表编辑（支持 dryRun 预览）
lib/toggle.js        skills / MCP 的可逆启用与禁用
lib/mcp-discovery.js 各 agent MCP 配置的解析与去重
lib/skill-discovery.js  SKILL.md 扫描
lib/registry.js      GitHub 导入与 registry 搜索
lib/extra-agents.js  gaal 未收录的补充 agent（zcode / qoder）
lib/diff.js          行级 LCS diff（部署预览用）
lib/atomic.js        原子写文件
public/              原生 JS 前端
test/                node:test 测试
```

## License

[MIT](LICENSE)
