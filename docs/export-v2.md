# All-in-Flow 多平台导出设计（IR v2）

> 状态：草案 v0.1 ｜ 日期：2026-10-10 ｜ 前置文档：[design.md](design.md) 第 6、7 节

---

## 1. 背景

一期的 IR（design.md 第 6 节）主要服务于 Agent Skill：每一步"具体做什么"都写在 `instructions` 这段自然语言里，由本地 Agent 中的大模型理解后执行。这对 Skill 足够，但 n8n、Dify、Coze 是**执行引擎**，需要确定的结构：

| 目标平台需要 | 一期 IR | 缺口 |
|---|---|---|
| 节点间的数据传递（n8n `{{ $json.x }}`、Dify `{{#node.var#}}`） | `inputs/outputs: string[]`，只有名字 | 变量类型；输入来自哪个节点的哪个输出 |
| 分支条件（IF / Switch / if-else） | 出边上的自然语言 `label`，如"有异常" | 结构化条件表达式，或明确标记"由 LLM 判断" |
| 节点调用什么（哪个接口、哪个工具、什么提示词） | 一段自然语言 | 有类型的 `action` |
| 循环（逐条处理订单） | 允许出现环，靠决策节点退出 | 显式的循环结构 |
| 并行 | 一个节点有多条出边时语义不清 | 区分"并行"和"互斥分支" |

本文档描述 IR v2、集成目录的扩展、导出插件机制的调整，以及 Skill、n8n、Dify、Coze 四个导出插件的设计。

### 1.1 目标

| # | 目标 | 衡量方式 |
|---|---|---|
| G1 | 同一份 IR 能导出到 Skill、n8n、Dify | 演示数据的工作流导出后，能在对应平台导入成功，并在补齐凭证后跑通 |
| G2 | Skill 中的〔脚本〕步骤真正确定性执行 | 有 `action` 的 deterministic 步骤都生成 `scripts/` 下的脚本，而不是文字说明 |
| G3 | 转换不了的内容提前告知 | 导出前由 `supports()` 列出每个无法映射的节点及原因，导出产物中留有占位 |
| G4 | 兼容一期数据 | v1 IR 自动迁移到 v2，已有工作流的 Skill 导出结果不变差 |

### 1.2 非目标

- 不在平台内执行工作流（与 design.md 1.2 一致）。
- 不做 n8n / Dify / Coze → IR 的反向导入（可作为三期的输入源插件）。
- 不保存任何平台的凭证；凭证始终由使用者在目标平台中自行配置。
- Coze 在调研结论出来之前不进入开发（见第 9 节）。

---

## 2. 总体方案

```
访谈 Agent ──emit_workflow──▶ IR 生成器（Pro 模型）
                                  │  读取集成目录中的 operations
                                  ▼
                             WorkflowIR v2 ──校验──▶ 存库
                                  │
                                  ▼
                        lower(ir) → ExecGraph          （packages/workflow-ir，公共）
                    引用解析 · 拓扑排序 · 自动布局 · 节点命名 · 能力识别
                                  │
        ┌───────────────┬─────────┴─────┬────────────────┐
        ▼               ▼               ▼                ▼
   exporter-skill  exporter-n8n    exporter-dify    exporter-coze（待调研）
```

三条原则：

1. **IR 仍是唯一数据源**。新增的结构化字段都是可选的。没有结构化信息时，Skill 退回自然语言写法；n8n、Dify 生成占位节点并给出 warning。
2. **平台无关的处理放在公共层**。坐标布局、引用解析、子图展开等每个插件都要做的事，只在 `lower()` 里实现一次；插件只做最后一步格式转换。
3. **平台差异放在集成目录里**。"ERP 订单接口在 n8n 里用哪个节点"这类知识写在 `packages/integrations`，不写在插件代码里。

---

## 3. IR v2

### 3.1 Schema

只列出相对 v1 的变化，未列出的字段与 design.md 6.1 相同。

```ts
type WorkflowIR = {
  version: 2;
  // ……kind / slug / name / description / trigger / source 同 v1

  inputs: Variable[];                  // v1 的 inputs 增加类型
  integrations: {
    id: string;
    name: string;
    purpose: string;
    access: "mcp" | "api" | "cli" | "webhook" | "manual";   // 补上 webhook，与集成目录对齐
    hint?: string;
  }[];
  nodes: Node[];
  edges: Edge[];
};

/** 变量：工作流输入、节点输出都用它描述 */
type Variable = {
  name: string;                        // 小写字母、数字、下划线，作为引用名
  type: "string" | "number" | "boolean" | "object" | "array" | "file";
  items?: Variable["type"];            // type 为 array 时的元素类型
  description: string;
  required?: boolean;                  // 只对工作流输入有意义
};

type Node =
  | { id: string; type: "start"; title: string }
  | { id: string; type: "end"; title: string; outputs?: OutputBinding[] }
  | StepNode
  | DecisionNode
  | ForeachNode
  | MergeNode;

type StepNode = {
  id: string;
  type: "step";
  title: string;
  executor: "deterministic" | "llm" | "human";
  integration?: string;
  instructions: string;                // 保留：给人和 Agent 看的说明，也是没有 action 时的兜底
  action?: Action;                     // 新增：结构化的执行方式
  outputs?: Variable[];                // 新增：本步骤产出的变量
};

type DecisionNode = {
  id: string;
  type: "decision";
  title: string;
  mode: "expr" | "llm";                // expr：按出边上的 condition 判断；llm：由模型分类
  question?: string;                   // mode 为 llm 时，给模型的判断问题
  input?: Ref;                         // mode 为 llm 时，被判断的内容
};

/** 对数组逐项执行一个子流程 */
type ForeachNode = {
  id: string;
  type: "foreach";
  title: string;
  over: Ref;                           // 必须引用一个 array 变量
  item: string;                        // 子流程中当前元素的变量名，如 "order"
  body: { nodes: Node[]; edges: Edge[] };   // 子图，自带 start / end
  outputs?: Variable[];                // 收集到的结果，类型为 array
};

/** 等待所有并行分支完成 */
type MergeNode = { id: string; type: "merge"; title: string };

type Edge = {
  from: string;
  to: string;
  label?: string;                      // 画布显示用
  condition?: Condition;               // 只在 mode 为 expr 的 decision 出边上使用
  default?: boolean;                   // decision 的"其他情况"分支
};
```

### 3.2 引用（Ref）与模板

为了让模型容易生成、也方便人读，引用统一写成字符串：

| 写法 | 含义 |
|---|---|
| `input.week` | 工作流输入 `week` |
| `n1.orders` | 节点 `n1` 的输出 `orders` |
| `n1.orders.length` / `n1.summary.total` | 取下级字段（只允许 `.` 访问和 `length`） |
| `item.order` | foreach 子流程中的当前元素 |
| `env.ERP_BASE_URL` | 集成目录中声明的配置项（只能引用，不能出现真实值） |

```ts
type Ref = string;                     // 正则：^(input|env|item|[a-z][a-z0-9_]*)(\.[a-zA-Z0-9_]+)*$
```

在 `prompt`、`params` 等字符串中，用 `{{ref}}` 嵌入引用，例如 `"请汇总以下订单：{{n1.orders}}"`。各插件在编译时把它改写成目标平台的语法：

| 平台 | `{{n1.orders}}` 改写为 |
|---|---|
| Skill | "第 1 步得到的 orders" 加变量说明，或脚本的命令行参数 |
| n8n | `{{ $('拉取本周订单').item.json.orders }}`（节点按名字引用） |
| Dify | `{{#n1.orders#}}`；需要选择器的字段写成 `["n1", "orders"]` |

### 3.3 Action

```ts
type Action =
  /** 调用集成目录中登记的操作（API、MCP 工具、CLI 命令、Webhook 都走这里） */
  | { kind: "integration"; integration: string; operation: string; params: Record<string, Template> }
  /** 没有登记的普通 HTTP 请求 */
  | { kind: "http"; method: "GET" | "POST" | "PUT" | "DELETE"; url: Template;
      headers?: Record<string, Template>; body?: Template }
  /** 调用大模型 */
  | { kind: "llm"; prompt: Template; system?: string; outputSchema?: Variable[] }
  /** 数据整理：取字段、拼接、格式化 */
  | { kind: "transform"; template: Template }
  /** 代码：只在确实没有其他办法时使用，生成器需要说明原因 */
  | { kind: "code"; language: "javascript" | "python"; source: string }
  /** 人工确认或填写表单 */
  | { kind: "human"; message: Template; form?: FormField[];
      approval?: boolean };          // true：只需要"同意 / 拒绝"，结果写入输出 approved

type Template = string;                // 可以包含 {{ref}}

type FormField = {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "date";
  options?: string[];
  required?: boolean;
};
```

executor 与 action 的对应关系：

| executor | 允许的 action |
|---|---|
| `deterministic` | `integration`、`http`、`transform`、`code` |
| `llm` | `llm` |
| `human` | `human` |

### 3.4 条件表达式

只支持一个小而固定的子集，避免任意代码。这个子集可以一一对应到 n8n 的 IF / Switch 和 Dify 的 if-else。

```ts
type Condition =
  | { all: Condition[] }               // 且
  | { any: Condition[] }               // 或
  | { left: Ref;
      op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains"
        | "empty" | "not_empty" | "is_true" | "is_false";
      right?: string | number | boolean };
```

`mode: "llm"` 的决策用于"这封邮件是不是投诉"这类无法写成表达式的判断。这时出边上只需要 `label`，插件把它编译成分类节点：n8n 用 Text Classifier，Dify 用问题分类器；不支持的平台退回成"LLM 输出类别 + Switch"。

### 3.5 并行与合并

- `step` 有多条出边 → **并行**：所有后继都执行。
- `decision` 有多条出边 → **互斥**：只走满足条件的一条。
- 需要等并行分支都完成时，显式加一个 `merge` 节点。没有 `merge` 时，多个分支各自独立走到 `end`。

### 3.6 校验规则

在 design.md 6.3 的基础上增加：

- `Ref` 指向的节点必须在当前节点之前（从 `start` 出发能先到达），变量名必须在该节点的 `outputs` 中声明。
- `foreach.over` 必须引用 `array` 类型；`item.*` 只能出现在 `body` 中。
- `body` 内部是独立的子图，必须满足同样的 start / end 规则；子图中的节点不能被外部引用，外部只能引用 `foreach.outputs`。
- `decision.mode = "expr"` 时，每条出边要么有 `condition`，要么 `default: true`，并且 `default` 最多一条。
- `decision.mode = "llm"` 时必须有 `question` 和 `input`。
- `action.kind = "integration"` 时，`integration` 和 `operation` 必须在集成目录中登记；`params` 的键必须是该操作声明过的参数。
- `action` 与 `executor` 必须符合 3.3 的对应表。
- 环：v2 中只有 Skill 允许出现环。其他插件在 `supports()` 中把环报成 error，并提示改成 `foreach`。

### 3.7 v1 → v2 迁移

- `workflow-ir` 提供 `migrate(ir: unknown): WorkflowIRv2`，按 `version` 字段逐级迁移。
- 数据库中的 IR 读取时迁移，不批量改写历史数据；生成新版本时写入 v2。
- 迁移规则：
  - `inputs[]` 加上 `type: "string"`；
  - 节点的 `inputs/outputs: string[]` 改成 `Variable[]`，类型都是 `string`，`description` 留空；
  - `decision` 加上 `mode: "llm"`，`question` 取节点标题，`input` 留空，并生成一条 warning；
  - 不生成 `action`。
- 迁移后的 v1 工作流可以照常导出 Skill（退回自然语言写法）；导出到 n8n / Dify 时节点会成为占位，用户可以在对话中说"补全执行细节"，让 Agent 重新生成一个 v2 版本。

---

## 4. 访谈 Agent 与 IR 生成器

| 改动 | 说明 |
|---|---|
| IR 生成器的提示词 | 加入 v2 schema、引用写法、条件子集，以及当前集成目录中所有 `operations` 的精简列表（id、参数、输出） |
| 结构化输出 | 继续由服务端的 Pro 模型生成；生成后先做 zod 校验，再做 3.6 的图校验 |
| 修复循环 | 校验失败时把错误列表交回模型修复，最多 2 轮；仍失败时去掉出错节点的 `action`，退回 `instructions`，并在工作台提示 |
| 访谈阶段 | 进入"方案细化"阶段后，Agent 要问清楚三件事：每一步要用的系统、判断的依据、需要人确认的内容。这三点决定 `action` 和 `condition` 能否生成 |
| `emit_workflow` | 参数不变，仍然只传 `brief`。`brief` 中要求包含上面三点的回答 |

评测（packages/evals）增加两项指标：`action` 覆盖率（有 action 的 step 占比），以及 n8n 导出时无 error 的比例。

---

## 5. 集成目录扩展（packages/integrations）

### 5.1 operations：把访问方式细化到具体操作

```ts
interface IntegrationEntry {
  // ……一期字段不变
  operations: Operation[];
  targets?: PlatformTargets;
}

interface Operation {
  id: string;                          // 如 "listOrders"
  title: string;                       // "查询订单"
  description: string;
  params: Variable[];
  output: Variable[];
  /** 各访问方式下的具体调用写法；只含占位符 */
  api?: { method: "GET" | "POST"; path: string; query?: Record<string, Template>; body?: Template };
  mcp?: { tool: string; args: Record<string, Template> };
  cli?: { command: Template };
  webhook?: { body: Template };
}
```

一期 `api.examples` 中的示例迁移成 `operations`。`CONNECTIONS.md` 和 Skill 的 `scripts/` 都由 `operations` 生成。

### 5.2 targets：同一个操作在各平台的写法

```ts
interface PlatformTargets {
  n8n?: {
    /** 有官方节点时使用，否则退回 HTTP Request */
    node?: { type: string; typeVersion: number; operationMap: Record<string, Record<string, unknown>> };
    credentialType?: string;           // 如 "httpHeaderAuth"
  };
  dify?:
    | { tool: { provider: string; name: string; plugin?: string } }   // Dify 插件 / 工具
    | { http: true };                  // 用 http-request 节点
  coze?: { plugin: string; api: string };
}
```

- 没有 `targets` 的集成：`api` 类型一律退回成各平台的 HTTP 请求节点；`mcp` 类型在 n8n 中用 MCP Client 节点，在 Dify 中用 MCP 工具（版本支持情况见第 8 节的待验证项）；`cli`、`manual` 类型生成占位节点。
- 凭证一律只写配置项名，例如 n8n 中的凭证名为 `all-in-flow · ERP_TOKEN`，由用户在 n8n 里创建同名凭证；导出产物中不会出现真实值。

---

## 6. 导出插件机制 v2（packages/workflow-ir）

### 6.1 公共层：lower()

```ts
function lower(ir: WorkflowIRv2): ExecGraph;

interface ExecGraph {
  ir: WorkflowIRv2;
  order: string[];                          // 拓扑顺序（环用回边标记）
  refs: Map<string, ResolvedRef[]>;         // 每个节点用到的引用，已解析到节点和变量
  layout: Map<string, { x: number; y: number }>;   // dagre 自动布局，n8n / Dify 共用
  names: Map<string, string>;               // 平台内唯一的显示名（n8n 按名字引用节点）
  features: Set<Feature>;                   // 本工作流用到的能力，如 "foreach"、"llm-decision"
}

type Feature =
  | "trigger:manual" | "trigger:schedule" | "trigger:event"
  | "action:integration" | "action:http" | "action:llm" | "action:transform"
  | "action:code" | "action:human" | "action:none"
  | "decision:expr" | "decision:llm" | "foreach" | "parallel" | "merge" | "cycle";
```

### 6.2 插件接口调整

```ts
interface ExporterPlugin<Options = unknown> {
  // ……一期字段不变
  /** 插件支持的能力；不在列表中的 Feature 自动生成 issue，不用每个插件手写 */
  capabilities: Partial<Record<Feature, "full" | "degraded">>;   // 未列出 = 不支持（error）
  /** 兼容的目标平台版本，展示在导出菜单中，如 "n8n >= 1.x" */
  targetVersion?: string;
  supports(graph: ExecGraph): ExportIssue[];          // 只写平台特有的检查
  compile(graph: ExecGraph, options: Options): ExportFile[] | Promise<ExportFile[]>;
}
```

- `"degraded"`：可以导出但有损失（例如 Skill 中的 `foreach` 写成"对每一项重复第 3–5 步"），生成 warning。
- 未列出的能力生成 error，导出按钮禁用，并显示是哪个节点、为什么不行。
- `compile` 允许返回 Promise，与 design.md 7.4 保持一致；为以后"通过 API 直接推送到 n8n"（`serverCompile`）留出空间。
- `ExportFile.content` 支持 `string | Uint8Array`，便于以后输出二进制文件。

---

## 7. Agent Skill 插件改进（exporter-skill v2）

### 7.1 生成可执行脚本

有 `action` 的 deterministic 步骤生成脚本，SKILL.md 中写成"运行 `scripts/xxx.sh`"，不再只写文字说明：

```
weekly-sales-report/
├── SKILL.md
├── scripts/
│   ├── 01-fetch-orders.sh        # action.kind = integration（api）：由 operation 生成 curl
│   └── 03-format-table.mjs       # action.kind = transform / code
├── references/
│   ├── workflow.mmd
│   └── workflow.json
├── .env.example                  # 列出所有配置项，值为空
├── CONNECTIONS.md
└── INSTALL.md
```

- 脚本从环境变量读取配置项，缺少时立即退出并给出可读的报错。
- 脚本把结果输出为 JSON（stdout），SKILL.md 中说明"把输出保存为 `orders`，供后续步骤使用"。
- `mcp` 类型的操作不生成脚本，写成"调用 MCP 工具 `<tool>`，参数为 …"。

### 7.2 SKILL.md 中写明每一步的输入和输出

```markdown
1. **拉取本周订单**〔脚本〕运行 `scripts/01-fetch-orders.sh <week>`。
   - 输入：`week`（工作流输入）
   - 输出：`orders`（array，订单列表）
2. **判断：有异常订单？**
   - `orders` 中存在 `status = abnormal` 的订单 → 第 3 步
   - 其他情况 → 第 4 步
```

条件表达式（`mode: "expr"`）翻译成可读的中文条件；`mode: "llm"` 写成判断问题。

### 7.3 description 校验

`supports()` 增加检查：`description` 中必须说明"什么时候用"（例如包含"当……时使用"），否则给出 warning。Agent 靠这一句决定是否自动触发 Skill。

### 7.4 打包方式选项

| 选项 | 产物 | 适用 |
|---|---|---|
| `zip`（默认） | 解压到 skills 目录即可使用 | 个人试用 |
| `claude-plugin` | `.claude-plugin/plugin.json` + `skills/<slug>/`，可以放进公司内部的 git marketplace | 团队共享，可以统一更新版本 |

---

## 8. n8n 插件（exporter-n8n）

### 8.1 产物

单个 `<slug>.n8n.json`，用户在 n8n 中通过"Import from File"或粘贴导入。导出完成后提示需要创建哪些凭证。

工作流 JSON 的基本结构：`{ name, nodes: [{ id, name, type, typeVersion, position, parameters, credentials? }], connections, settings }`。其中 `connections` 以**节点名**为键，所以节点名必须唯一，由 `lower()` 中的 `names` 保证。

### 8.2 映射

| IR | n8n 节点 | 说明 |
|---|---|---|
| trigger manual | Manual Trigger | |
| trigger schedule | Schedule Trigger | 使用 `trigger.cron` |
| trigger event | Webhook | 事件源无法自动映射时给出 warning |
| action integration（有 targets.n8n.node） | 对应的官方节点 | 按 `operationMap` 填参数 |
| action integration（api，无 targets） / action http | HTTP Request | 鉴权使用凭证，凭证按配置项命名 |
| action integration（mcp） | MCP Client 工具节点 | 待验证，见 8.4 |
| action llm | Basic LLM Chain + 模型子节点 | 模型子节点默认使用 OpenAI 兼容接口，凭证由用户配置；`outputSchema` 用 Structured Output Parser |
| action transform | Set（Edit Fields） | |
| action code | Code | |
| action human | Wait（表单提交后继续）或 Form | `approval: true` 时生成同意 / 拒绝两个选项 |
| decision expr，两条出边 | IF | |
| decision expr，多条出边 | Switch | |
| decision llm | Text Classifier | |
| foreach | Loop Over Items（Split in Batches） | body 展开在循环内部 |
| merge | Merge | |
| 无 action 的 step | Sticky Note + No Operation 占位 | Sticky Note 中写 `instructions`，提醒用户手动补全 |
| 环 | 不支持 | error，提示改成 foreach |

### 8.3 表达式改写

`{{n1.orders}}` → `={{ $('拉取本周订单').item.json.orders }}`。字符串中嵌入引用时，整段参数值以 `=` 开头。

### 8.4 待验证项

开发前需要在公司实际使用的 n8n 版本上确认：

- 各节点的 `type` 和 `typeVersion`，以及 Wait 表单、MCP Client、Text Classifier 是否可用，并写死在插件中；
- 导入后凭证引用的表现（导入时缺少凭证，节点会显示为待配置）。

---

## 9. Dify 插件（exporter-dify）

### 9.1 产物

单个 `<slug>.dify.yml`（DSL），在 Dify 中通过"导入 DSL 文件"创建 Workflow 应用。

DSL 的基本结构：`app`（mode 为 `workflow`）、`kind: app`、`version`（DSL 版本）、`workflow.graph.nodes / edges`、`environment_variables`、`dependencies`（插件依赖）。

### 9.2 映射

| IR | Dify 节点 | 说明 |
|---|---|---|
| inputs | 开始节点的 variables | 类型映射：string → text-input / paragraph，number → number，file → file |
| trigger schedule / event | 触发器节点或说明 | 取决于目标 Dify 版本是否支持触发器，待验证；不支持时给出 warning，由用户在外部调度 |
| action integration（有 targets.dify.tool） | 工具节点 | 写入 `dependencies` |
| action integration（api） / action http | HTTP 请求 | |
| action llm | LLM | 模型提供方和模型名作为导出选项，默认留空由用户选择 |
| action transform | 模板转换 | |
| action code | 代码执行 | |
| action human | 人工介入节点 | 待验证目标版本是否支持；不支持时为 error |
| decision expr | 条件分支（if-else） | 多条件对应多个 case |
| decision llm | 问题分类器 | |
| foreach | 迭代 | body 作为迭代内的子图 |
| merge | 变量聚合器 | Dify 的并行分支会自动汇合 |
| end | 结束节点 outputs | |
| 无 action 的 step | 模板转换占位 | 输出 `instructions`，并给出 warning |
| 配置项 | `environment_variables` | secret 类型的值留空 |

### 9.3 风险

- **DSL 版本变动较快**：插件选项中锁定一个 DSL 版本，`targetVersion` 写明对应的 Dify 版本；升级 Dify 时需要先跑第 11 节的导入测试。
- 节点 id 用时间戳风格的数字字符串，与 Dify 自己导出的格式保持一致，避免导入后编辑出问题（待验证）。

---

## 10. Coze（调研项，不排期开发）

### 10.1 需要回答的问题

1. 公司用的是 Coze 云端（国内版 / 海外版）还是开源的 Coze Studio？
2. 目标版本是否支持**导入工作流文件**？格式是否有公开文档？
3. 有没有通过 OpenAPI 创建或更新工作流的方式？

### 10.2 决策标准

| 调研结果 | 方案 |
|---|---|
| 有公开、稳定的导入格式 | 与 n8n、Dify 一样做导出插件 |
| 只有私有格式（需要逆向） | 不做文件导出，改成导出"搭建说明"（每个节点怎么配，配图）；或者让 Coze 通过 MCP / HTTP 调用已导出的 n8n 工作流 |
| 平台本身不再使用 | 不做 |

---

## 11. 测试

| 层级 | 内容 | 运行时机 |
|---|---|---|
| 单元测试 | `migrate`、`lower`、条件和引用的改写；每个插件对演示工作流做快照测试 | 每次提交 |
| 格式校验 | n8n 产物按节点结构校验；Dify 产物做 YAML 解析，并检查必填字段 | 每次提交 |
| 真实导入 | docker compose 中加 `e2e` profile，启动指定版本的 n8n，调用其公开 API 导入工作流并检查返回结果 | 每次改动 exporter-n8n 时 |
| Dify 导入 | Dify 依赖的容器较多，不放进日常 CI；在测试服务器上部署固定版本，按周或发版前做导入检查 | 每周 / 发版前 |
| Skill 执行 | 在临时目录中解压，用假 ERP（`scripts/dev-fake-erp.mjs`）执行生成的 `scripts/`，检查输出 JSON | 每次提交 |

演示数据（`seed-demo.ts`）补一份 v2 工作流，覆盖 integration、llm、human、expr 决策、llm 决策、foreach 六种情况，作为所有插件的公共测试样例。

---

## 12. 路线图

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| P1 | IR v2 schema、校验、`migrate`；集成目录增加 `operations`，access 加 `webhook` | v1 数据迁移后 Skill 导出快照不变；新 schema 测试通过 |
| P2 | IR 生成器、访谈提示词改为生成 v2；评测增加 action 覆盖率 | 演示人设的 action 覆盖率 ≥ 80% |
| P3 | 公共层 `lower()`、插件接口 v2（capabilities、异步 compile） | Skill 插件迁移到新接口 |
| P4 | Skill 插件 v2：`scripts/`、输入输出、`.env.example`、`claude-plugin` 打包 | 用假 ERP 跑通生成的脚本 |
| P5 | n8n 插件 + 真实导入测试 | 演示工作流在 n8n 中导入成功，补齐凭证后能执行 |
| P6 | Dify 插件 | 在固定版本的 Dify 中导入成功并能运行 |
| P7 | Coze 调研，按第 10 节决定 | 输出调研结论 |

---

## 13. 待确认问题

1. 公司实际在用哪些平台，各自是什么版本？（决定 P5–P7 是否都做，以及锁定的版本）
2. n8n / Dify 中的 LLM 默认用哪个模型和提供方？平台统一的 DeepSeek Key 不能放进导出产物，需要使用者自己配置。
3. 是否需要"直接推送到 n8n / Dify"（`serverCompile`）？这需要平台保存用户的 n8n / Dify API Key，与"平台不保存凭证"的原则冲突，建议暂不做。
4. `code` action 由模型生成代码的风险是否可以接受？建议默认关闭，只在用户明确要求时生成。

---

## 附录 A：P1 实现记录

> 日期：2026-10-10。以下是实现过程中对草案的修正，以本节为准。

| 位置 | 草案 | 实现 | 原因 |
|---|---|---|---|
| 3.1 decision（llm） | `input` 必填 | `input` 可选 | v1 没有判断依据的引用，迁移时无法生成；缺省时由模型基于上下文判断 |
| 3.2 子流程当前元素 | `item.order` | 直接用 foreach 声明的 `item` 名作引用头，如 `order.id` | 避免 `item` 与元素名混淆 |
| 3.1 step.inputs | 删除 | 保留为 `string[]`，只作说明，不参与引用解析 | 保留 v1 数据，不丢失信息 |
| 3.1 变量名 | 未约束 | 不能包含空白、`{}` 和 `.` | 旧数据里的中文输入名需要能迁移；引用语法要求无空白和点 |
| 3.2 引用位置 | 未明确 | 只有 `{{...}}` 模板里的才是引用；`foreach.over`、`decision.input`、`condition.left` 是纯引用 | 与 3.2 的表格一致，裸字符串只是字面量 |
| 3.6 引用可见性 | 未明确 | 节点只能引用「存在从它到当前节点的路径」的节点（允许经过循环）；子流程不能引用所在 foreach 自身的输出 | 需要一个可以判断的规则 |
| 3.7 迁移 | 判断节点迁移后有 warning | `convertV1` 返回 `warnings`，`validateWorkflow` 一并返回 | 调用方可以提示用户确认 |
| 6.2 操作校验 | 通过集成目录校验 | `validateWorkflow(input, { resolveOperation })`，workflow-ir 不直接依赖 `@aif/integrations` | 保持 workflow-ir 无依赖；server 接入留到 P2 |

### A.1 已完成的文件

- `packages/workflow-ir`：`schema.ts`（v2 schema + v1 schema）、`migrate.ts`（`convertV1`、`migrateIr`）、`validate.ts`（schema、图结构、引用、action 校验）、`toMermaid.ts`（foreach、merge 形状）。
- `packages/integrations`：`catalog.ts` 增加 `operations`、`findOperation`；ERP、钉钉机器人、GitHub CLI 登记了操作，钉钉文档（MCP 工具名未确认）和本地文件暂为空数组。
- `plugins/exporter-skill`：foreach 写成「对某数组逐项执行」，merge 写成「等待并行分支完成」；步骤的渲染文本不变。
- `apps/server`：历史数据在读取时经 `migrateIr` 转换（工作流版本接口、分享读取）；存储类型改为 `StoredWorkflowIR`。
- `apps/web`：测试夹具改为 v2。

### A.2 Skill 导出快照对比

迁移前后用同一份销售周报样例导出，逐文件对比：

- `SKILL.md`、`INSTALL.md`、`CONNECTIONS.md`、`references/workflow.mmd` 完全一致；
- `SKILL.md` frontmatter 的 `workflow-version` 从 `"1"` 变为 `"2"`；
- `references/workflow.json` 是 IR 本身，因此变化：版本号、判断节点补上 `mode` 和 `question`、步骤补上空的 `outputs`。

这是 IR 版本号变化带来的预期差异，Skill 的执行说明没有变化。

### A.3 验证

- `workflow-ir`：39 个测试通过（v1 原有 10 个不改，v2 与迁移共 29 个）。
- `integrations`：7 个测试通过。
- `exporter-skill`：21 个测试通过。
- `web`：14 个测试通过。
- `server`：连接本地 Postgres 的测试库，串行运行，首次运行 95 个全部通过。

服务端的测试在同一个测试库上连续运行也能通过（用户名冲突已修复，见 A.4）。

### A.5 P2 实现记录（2026-10-10）

- `packages/workflow-ir`：`actionCoverage(ir)`，统计有 action 的 step 占比（含子流程）。
- `packages/evals`：评测新增 action 覆盖率（逐工作流取平均，并写入报告表格和对比）。
- `apps/server`：
  - IR 提示词 v2，操作清单由 `INTEGRATION_CATALOG` 生成，进程内固定，保持静态前缀；
  - 生成器用 `resolveOperation` 校验操作与参数；修复最多两轮；仍失败且问题只在某些 step 的 action 上时，去掉这些 action 并返回警告（`GeneratedWorkflow.warnings`），警告会出现在工具返回给 Agent 的文本中；
  - 访谈提示词新增「方案细化」（系统与接口、判断依据、需要人确认的环节），`emit_workflow` 的 brief 要求包含这三点；
  - server 依赖 `@aif/integrations`。

验收（销售运营人设，真实模型，单次运行）：

| 指标 | 结果 |
|---|---|
| action 覆盖率 | 100%（目标 ≥ 80%） |
| IR 合法率 | 100% |
| 生成前轮数 | 15 |
| 痛点召回 | 67% |
| 量化完整度 | 50% |

只跑了一个人设、一次，样本量很小。召回和量化指标不是 P2 的验收项，但偏低，后续需要关注。

### A.6 P3 实现记录（2026-10-10）

- `packages/workflow-ir/src/lower.ts`：`lower(ir)` 返回 `ExecGraph`，包括每一层的遍历顺序（`order`）、回边（`backEdges`）、布局（`layout`）、引用解析（`refs`，区分输入、环境配置、子流程元素、节点输出）、全局唯一的显示名（`names`）、子流程（`children`），以及能力及对应节点（`features`）。
- `packages/workflow-ir/src/exporter.ts`：插件接口改为接收 `ExecGraph`，新增 `capabilities`（`full` / `degraded`）。`checkExport` 统一做能力检查：未声明的能力报错并带上节点，`degraded` 给警告；插件的 `supports` 只写平台特有的检查。`ExportFile.content` 支持 `Uint8Array`。
- `plugins/exporter-skill`：迁移到新接口。导出结果和 P1 之后的基线逐字节一致。测试要求它为每一种能力都做出声明。
- `apps/web/src/lib/exporters.ts`：先 `lower(ir)`，再用 `checkExport`。

与草案不同的地方：

| 草案 | 实现 | 原因 |
|---|---|---|
| 布局用 dagre | 纯函数的分层布局（最长路径层，层内按遍历顺序） | 避免新增依赖；n8n 和 Dify 只需要相对坐标，分层布局够用 |
| `features` 是 `Set<Feature>` | `Map<Feature, string[]>`，记录用到能力的节点 | 报错时可以指出具体节点，UI 能定位 |
| `item.order` 引用 | 直接用 foreach 声明的元素名 | 与 A.1 保持一致 |

Skill 的能力声明：`action:code` 和 `decision:expr`、`foreach`、`parallel` 标为 `degraded`，其余为 `full`。P4 生成 `scripts/` 之后，`action:code` 改为 `full`。

### A.7 P4 实现记录（2026-10-10）

- `plugins/exporter-skill/src/scripts.ts`：确定性步骤生成脚本。
  - `integration` 的 GET 接口、Webhook、CLI 生成 bash 脚本，`transform` 生成 `.mjs`，`code` 按源码生成 `.mjs` 或 `.py`；
  - 参数按操作声明的顺序通过命令行传入，SKILL.md 中写明每个参数的来源；
  - 脚本读取 Skill 根目录的 `.env`，但不覆盖 shell 中已设置的变量；
  - 接口路径尚未确认的操作，脚本要求通过 `<ENV>_<OP>_PATH` 填写，未填写时报错；
  - HTTP 错误（`--fail-with-body`）让脚本失败；
  - 没有脚本的步骤（http、POST 接口、MCP、人工、LLM）以文字说明导出，并在导出前给出警告。
- `.env.example`：列出所有配置项和接口路径覆盖项，值留空。
- SKILL.md：每个确定性步骤写明运行的脚本、参数和输出；判断分支的条件翻译为中文；判断问题与标题不同时才显示。
- 打包：`zip`（默认，`<slug>/...`）和 `claude-plugin`（`.claude-plugin/plugin.json` 加 `skills/<slug>/...`）。
- `supports`：检查 description 是否写明使用时机（「……时使用」），并列出无法生成脚本的步骤。
- 能力声明：`action:code`、`decision:expr` 改为 `full`；`foreach`、`parallel` 仍为 `degraded`。
- `scripts/dev-fake-erp.mjs`：增加 `/api/orders`（Bearer 令牌 `dev-token`），仅用于开发。

验证：
- 生成的脚本用假 `curl` 运行，检查了请求地址、查询参数、鉴权头和 Webhook 的 JSON 转义；`.mjs` 脚本用 `node` 实际运行。
- 端到端：生成的 `scripts/01-listOrders.sh` 连接假 ERP，正确令牌返回订单 JSON，错误令牌以 401 失败。
- 回归：销售周报样例的导出结果，只新增了 `.env.example`，INSTALL.md 增加了配置说明，SKILL.md 不变。

与草案不同的地方：
- 草案中 `scripts/` 只提到 deterministic 步骤，实现时把 `code` 也纳入（它本来就是确定性的）。
- 接口路径尚未确认时，不编造路径，而是要求通过环境变量填写。

### A.8 targets 与导出菜单打包选择（2026-10-10）

- `packages/integrations`：增加 `PlatformTargets` 类型和 `findTarget(integrationId, platform)`。**目前没有填写任何平台写法**：n8n 的节点类型和 typeVersion 必须以真实版本的源码为准，Dify 的 DSL 也还没验证，所以先留空。未登记时，插件退回通用的 HTTP 节点。
- `apps/web`：导出菜单的 Skill 项增加打包方式选择（解压即用 / Claude Code 插件），下载文件名区分为 `<slug>.skill.zip` 和 `<slug>.claude-plugin.zip`。验证方式：类型检查和构建通过，测试 14 个通过；没有在浏览器里实际点击验证。

### A.4 测试用户名冲突（已修复）

原因：同一个用户名 `zhangsan` 在不同测试文件里对应不同的 ERP ID，而 `users.username` 是唯一的，残留的行会让另一个文件登录失败。

修复：`auth.test.ts` 的假 ERP 用户改为 `auth-user`，`http.test.ts` 主流程的假 ERP 用户改为 `http-user`（ID 不变）。`helpers.ts` 的 `zhangsan`（990201）被 share、integrations 和 http 的一个用例共用，ID 始终一致，保留。验证：串行和并行模式各连续运行两次，全部通过，中间没有清库。
