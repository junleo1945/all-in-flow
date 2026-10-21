# 导出 n8n 工作流：授权管理 + 导出 skill（方案）

> 状态：已实施（见末尾“实施记录”）。
> 替代并删除本分支之前的"导出向导"（独立页面、实例登记、部署、覆盖层等）。
> 产品定位：All-in-Flow 的重点是从对话里深挖用户的痛点，然后导出适合他的工具——一段提示词、一个 skill，或一个 n8n 工作流 JSON。选择 n8n JSON 的用户本身了解 n8n，所以不需要向导，只需要把"这张流程图里哪一段能自动化、对应 n8n 里哪些节点"算出来，交给他粘贴。

---

## 1. 用户看到的

**授权管理**（头像菜单新增一项，弹窗，不是页面）
- 列表：名称、类型、地址、添加时间；操作：添加、改名、删除。
- 第一期只有一种类型：**n8n MCP**。添加时填名称、n8n 地址、MCP token；点"保存"先探测一次（initialize + tools/list），连不上不保存。
- 保存后 token 不再回显，列表只显示"已配置"。

**导出 n8n 工作流**（工作台"导出"菜单里的 n8n 一项，弹窗，不跳页）
- 没有 n8n 授权：弹窗提示"先在授权管理里添加你的 n8n"，带一个按钮直接打开授权管理。
- 有授权（多个时先选一个）：弹窗显示进度，分四步：**分析流程图 → 匹配 n8n 节点 → 校验 → 完成**。
- 完成后弹窗显示：
  1. **切段说明**：哪一段被做成了工作流，哪些环节被排除（例如"到公司打开邮箱"是人工环节，工作流从"读取新邮件"开始），以及需要用户在 n8n 里补的东西（没有现成凭证的节点、需要人工确认的步骤）。
  2. **工作流 JSON**，一键复制，提示"到 n8n 画布上按 Ctrl/⌘+V 粘贴"。
  3. 下载 .json 按钮（保留给不想粘贴的人）。
- 失败时显示原因，可以重试；不会留下任何半成品。

## 2. skill 的工作方式

一个服务端的 agent 任务（复用 `agent/session.ts`：只启用自定义工具，内置的读写、bash 全部禁用），输入是流程图的 IR，工具是对用户 n8n MCP 的只读包装。

**第一步 切段**（纯模型，不用工具）
- 从 IR 里找出"连续、可自动化"的一段：有明确触发（定时、收到邮件、webhook、表单）和一串可由系统执行的步骤。
- 人工环节（到公司、口头确认、凭经验判断）标为边界或替换为人工确认节点，并记录"为什么排除"，最后展示给用户。
- 输出一份精简后的步骤清单，作为第二步的输入。

**第二步 匹配节点**（模型 + MCP 工具）
- 工具白名单（只读）：`search_nodes`、`get_node_types`、`list_credentials`、`validate_node_config`、`validate_workflow`、`get_workflow_best_practices`。不给任何创建、修改、执行的工具。
- 对每一步：搜节点 → 取参数定义 → 填参数；凭证按类型挂上用户已配置的（`list_credentials` 只返回 id、名称、类型），没有的留空并记入"需要补的东西"。
- 搜索关键词用英文（实测 MCP 的搜索不认中文）。
- 不保留确定性编译器。节点类型、版本、参数全部以用户实例上 `get_node_types` 返回的定义为准，所以平台这边没有任何随 n8n 版本漂移的东西要维护。循环、分支、AI 子节点这类结构由提示词里的固定说明（n8n 的连线规则、Loop Over Items 的两个输出、IF/Switch 的分支索引、ai_languageModel 子节点的接法）加 `validate_workflow` 兜底，不靠自己编译。

**第三步 校验**
- 逐节点 `validate_node_config`，整体 `validate_workflow`（如果实例支持）。不通过就把错误交回模型修改，最多 3 轮；仍不通过就带着问题返回给用户，不假装成功。
- 服务端再做一遍结构检查：所有连线指向存在的节点、有且只有一个触发器、节点名唯一、参数里不含明文密钥（有密钥样的值直接拒绝）。

**第四步 输出**
- 返回 `{ workflow, excluded: [...], todo: [...] }`；工作流 JSON 带 `name`、`nodes`、`connections`、`settings`，格式和 n8n 画布粘贴兼容。
- 进度通过 SSE 推给弹窗（复用对话那套流式输出）。

## 3. 服务端

- **表** `authorizations`：id、user_id、kind（`n8n_mcp`）、name、url、secret（密文）、created_at。密文用 AES-256-GCM，密钥来自新环境变量 `AUTH_SECRET_KEY`（32 字节），缺失时授权功能关闭并在启动日志提示。token 不写日志、不在任何响应里出现。
- **接口** `/api/authorizations`：list / create（含探测）/ rename / delete。
- **出站安全**：用户填的地址服务端会去连，复用 `lib/netguard.ts` 里的内网地址拦截（`isPrivateAddress`）加 DNS 解析，套在 `n8n/mcp.ts` 客户端上；不跟随跳转、限制响应大小和超时（已有）。内部部署要连内网 n8n 时用 `MCP_ALLOW_PRIVATE_HOSTS=true` 显式放开。
- **导出接口** `POST /api/workflows/:id/n8n-export`（SSE）：参数是版本号和授权 id；走每用户的模型配额（`assertBudget`）和已有的 `FixedWindowLimiter` 限流（例如每分钟 3 次）。
- MCP 客户端 `n8n/mcp.ts` 保留，白名单改为上面那组只读工具。

## 4. 删除清单

本分支之前为"导出向导"加的东西全部去掉：

- 前端：`pages/N8nExport.tsx` 与路由、`N8nWizard`、`N8nNodeEntry`、`N8nReplacementEditor`、`N8nMcp`、`N8nFlow`、`lib/n8n.ts`、`lib/n8nEdit.ts`、`lib/n8nFlow.ts`、`lib/n8nCredentials.ts`、`lib/canvasNodes.ts`（若只被向导使用）、相关样式和 i18n 文案、相关测试。`ExportMenu` 里 n8n 一项改为打开新弹窗。
- 服务端：`routes/n8n.ts`、`routes/n8nInstances.ts`、`n8n/analyzer.ts`、`n8n/drafter.ts`、`n8n/relay.ts`、`n8n/service.ts`、`n8n/mcpChecks.ts`、`n8n/instances.ts`、`db/repos/n8nConfigRepo.ts`、`db/schema/n8n.ts`、迁移 0003–0005（分支未合并，直接拿掉，新迁移从 0003 开始）、`config.ts` 里的 `N8N_INSTANCES`、对应测试。
- 包：`packages/n8n-nodes`（白名单与节点定义快照、同步脚本）、`packages/evals` 里的可执行性评测、`plugins/exporter-n8n`（main 上已有的确定性编译器也一起删，前端 `lib/exporters.ts` 里的 `exportN8nJson` 随之去掉）。此后 n8n 导出只有 skill 这一条路，必须先有授权。
- 部署与脚本：`docker-compose.yml` 的 `n8n-e2e` 服务、`scripts/n8n-e2e.sh`、`.github/workflows/n8n-e2e.yml`、`.env.example` 里的 n8n 实例说明。
- 文档：`docs/n8n-guided-export.md`、`docs/n8n-guided-export-revision.md`、`docs/n8n-mcp-enhancement.md`、`docs/n8n-public-launch.md` 删除；本文件改名为实施记录。
- 您 `.env` 里的 `N8N_INSTANCES` 这一行不再使用，可以删掉。

## 5. 不做的事

- 不做实例登记、不做部署、不做覆盖层、不做试运行。用户拿到 JSON 后的事在 n8n 里完成。
- 不存 n8n API Key；只存 MCP token。
- "直接创建到我的 n8n"按钮：token 已经有了，技术上一行就能加，但先不做，等用户要。

## 6. 验收

- 没有授权时点 n8n 导出：提示并能直接打开授权管理；添加一个错误的 token 不会被保存。
- 用"每天早上到公司打开邮箱，读邮件，分析内容，发钉钉群"这张图导出：切段说明里"到公司"被排除，工作流从邮件触发器开始；钉钉一步挂上实例里已有的凭证（若有）；JSON 粘到 n8n 画布上能完整出现。
- 用一个带循环和分支的流程图导出：结构与编译器一致，粘贴后连线正确。
- 模型故意输出一个带 `apiKey: "sk-..."` 的参数：被服务端拒绝，弹窗显示原因。
- 填内网地址添加授权：被拒绝。
- 一分钟内连点 5 次导出：第 4 次起被限流。

## 7. 实施顺序与工作量

| 顺序 | 内容 | 预估 |
|---|---|---|
| 1 | 删除向导及相关代码、回退导出器、清理部署脚本与文档 | 0.5 天 |
| 2 | 授权表、加密、接口、出站安全、头像菜单弹窗 | 1 天 |
| 3 | 导出 skill：切段、匹配、校验、结构检查、SSE | 2 天 |
| 4 | 导出弹窗：进度、切段说明、复制与下载 | 0.5 天 |
| 5 | 测试（假 MCP）、对着您飞牛实例走一遍验收 | 0.5 天 |

共约 4.5 天。

---

## 8. 实施记录

**已完成**：第 4 节的删除清单全部执行；授权管理（`authorizations` 表、AES-256-GCM 加密、`/api/authorizations`、头像菜单弹窗）；导出 skill（`n8n/exportAgent.ts`）与 SSE 接口 `POST /api/workflows/:id/n8n-export`；导出弹窗；`.env.example` 与 compose 增加 `AUTH_SECRET_KEY`、`MCP_ALLOW_PRIVATE_HOSTS`。

**与方案的差异**
- 不用 `validate_workflow`：它校验的是 n8n Workflow SDK 的 TypeScript 代码，不是工作流 JSON。校验改为服务端的结构检查（触发器唯一、连线有效、无孤立节点、名称唯一、参数里无明文密钥、代码节点安全检查）加 `validate_node_config` 逐节点校验。不用 `get_workflow_best_practices`（面向 SDK 构建）。MCP 工具白名单因此是 4 个：`search_nodes`、`get_node_types`、`list_credentials`、`validate_node_config`。
- 模型不直接调用 MCP：它只能在 JSON 里请求 `search` / `types` / `credentials` / `done` 四个动作，由服务端执行并把结果文本交还；其他动作一律不执行。
- 凭证只能引用本次 `list_credentials` 里出现过、类型一致的 id，其余去掉并写入“需要补的东西”。
- 触发器的判断：类型名以 Trigger 结尾、已知的老触发节点（webhook、emailReadImap 等），以及搜索结果里 n8n 标出的 `[TRIGGER]`。
- 内网地址拦截复用 `lib/netguard.ts` 的判断，先解析域名再检查所有地址；解析和实际连接之间存在极小的重绑定窗口。

**上线前需要做**
- 在服务端环境里设置 `AUTH_SECRET_KEY`（`openssl rand -hex 32`），否则授权管理和 n8n 导出都是关闭的。
- 用您的飞牛 n8n 走一遍验收（第 6 节）：这轮没有对真实 n8n 跑过导出，只在假 MCP 上验证了流程；`list_credentials` 的真实返回形态按多种形态兼容解析，需要真实验证。

**后续调整：授权管理改为“MCP 服务”**
- 头像菜单的入口叫“MCP 服务”，按钮是“添加 MCP”。表单顶部可以直接粘贴 MCP 配置 JSON（和 `.mcp.json` 一样），自动识别服务名、`url` 和 `headers.Authorization` 里的 Bearer token，再填进下面三项；粘贴的内容只在页面里识别，不保存。
- `authorizations.kind` 改为 `mcp`；`url` 存 MCP 服务的完整地址（只填了 n8n 地址、没有路径时补 `/mcp-server/http`）；添加时只验证能连上（initialize 加 tools/list），不再要求是 n8n。
- 导出 n8n 时才检查所选 MCP 是否开放了 `search_nodes` 和 `get_node_types`，不是 n8n 的 MCP 会得到明确的提示。
- 目前只支持 Authorization: Bearer 形式的鉴权；其他自定义请求头暂不支持。
