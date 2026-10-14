# All-in-Flow

通过对话挖掘日常工作中的痛点，生成可视化的工作流，并导出为可以直接接入本地 Agent 的 Skill。

设计文档见 [docs/design.md](docs/design.md)，界面原型见 [docs/ui/mockup.html](docs/ui/mockup.html)。

## 目录

```
apps/server          Hono + Pi SDK + Drizzle（API、访谈 Agent、分享）
apps/web             React + Vite + Excalidraw（前端）
packages/workflow-ir 工作流 IR、校验、Mermaid、导出插件接口
packages/evals       评测人设与打分
plugins/exporter-skill  Agent Skill 导出插件
plugins/exporter-prompt 对话提示词导出插件（粘贴到聊天窗口使用）
docker/              nginx 配置
```

## 本地开发

需要 Node 24、pnpm 10、Docker。

```bash
pnpm install
docker compose up -d postgres          # 数据库，宿主机端口 5433
cp .env.example .env                   # 按需填写 DEEPSEEK_API_KEY、ERP_BASE_URL 等
```

一键启动（数据库用 docker，服务端和前端在本机运行，改代码即时生效）：

```bash
pnpm dev                               # 前端 5173，服务端 3000；登录走 .env 里的真实 ERP
```

也可以分开启动（两个终端）：

```bash
pnpm --filter @aif/server dev          # API，端口 3000
pnpm --filter @aif/web dev             # 前端，端口 5173（/api 代理到 3000）
```

写入一份演示数据（画像、痛点、工作流 v1 和 v2），用于检查工作台、画布、导出和分享。数据写入指定的真实账号，该账号需要先用 ERP 登录过一次：

```bash
SEED_USERNAME=<ERP 用户名> pnpm --filter @aif/server exec tsx scripts/seed-demo.ts
```

## 测试

测试使用独立的数据库 `all_in_flow_test`，首次需要创建：

```bash
pnpm db:test:create
pnpm test:db                           # 运行全部测试（服务端需要数据库）
pnpm -r typecheck                      # 类型检查
```

## Docker 部署

```bash
docker compose up -d --build           # 启动 postgres、server、web
```

浏览器访问 `http://localhost:8080`（由 `WEB_PORT` 决定）。应用配置可以写在 `.env` 中，`docker-compose.yml` 中列出的变量会传入服务端容器。

生产环境注意：

- `ERP_BASE_URL` 指向真实 ERP；`SESSION_COOKIE_SECURE=true`（使用 HTTPS 时）。
- `DEEPSEEK_API_KEY` 由平台统一配置，不要提交到仓库。
- `DEEPSEEK_BASE_URL` 默认为官方地址；经过代理或私有网关时修改它（改完后模型请求会发到这里）。
- `ADMIN_USERNAMES` 指定管理员（可以查看全站用量）。
- `SHARE_PUBLIC_ENABLED` 默认 `false`，开启公开分享前请确认公司数据安全要求。

## 评测

```bash
pnpm --filter @aif/server eval -- --persona sales-ops --max-turns 20
```

需要 `DEEPSEEK_API_KEY`。结果写入 `packages/evals/reports/<时间>/`，包含指标、对话记录，可以用 `--baseline` 与上一次结果对比。
