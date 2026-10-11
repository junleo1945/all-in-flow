/**
 * 集成目录：记录工作流中用到的外部系统如何访问（design.md 第 14 节 二期 "集成目录"）。
 *
 * 约定：
 * - 目录只描述"怎么访问"（协议、工具名、需要用户填写哪些配置项），不保存任何真实地址或密钥；
 * - 真实的地址和密钥由使用者在自己的 agent 中配置（例如 .mcp.json 或本地环境变量），平台不保存；
 * - 导出的 Skill 会附带 .mcp.json 模板，使用者把占位符替换成自己的值即可；
 * - IR 中 integrations[].id 与这里的 id 对应。
 */
export interface ConfigField {
  /** 配置项名称，例如 ERP_TOKEN */
  name: string;
  secret: boolean;
  /** 说明：这个值是什么、从哪里获取 */
  description: string;
}

/** 操作的参数：工作流中 action.params 的键必须与这里的 name 对应（export-v2.md 5.1） */
export interface OperationParam {
  name: string;
  description: string;
  required: boolean;
}

export interface OperationOutput {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "file";
  description: string;
}

/**
 * 集成中的一个具体操作，例如"查询订单"。
 * 调用写法只含占位符，参数名引用 params 中的 name。
 */
export interface Operation {
  id: string;
  title: string;
  description: string;
  params: OperationParam[];
  output: OperationOutput[];
  api?: { method: "GET" | "POST"; path: string; query?: Record<string, string> };
  mcp?: { tool: string; args: Record<string, string> };
  cli?: { command: string };
  webhook?: { body: unknown };
}

/**
 * 同一个操作在各平台的写法（export-v2.md 5.2）。
 * 只能在对应平台的真实版本中验证之后再填写；未验证的集成保持为空，平台插件退回通用的 HTTP 节点。
 */
export interface PlatformTargets {
  n8n?: {
    /** 有官方节点时使用；typeVersion 以 n8n 2.x 的 n8n-nodes-base 源码为准 */
    node?: { type: string; typeVersion: number; operationMap: Record<string, Record<string, unknown>> };
    /** 凭证类型，例如 httpHeaderAuth */
    credentialType?: string;
  };
  dify?: { tool: { provider: string; name: string; plugin?: string } } | { http: true };
  coze?: { plugin: string; api: string };
}

export interface IntegrationEntry {
  id: string;
  name: string;
  summary: string;
  access: "mcp" | "api" | "cli" | "webhook" | "manual";
  /** 是否已经在真实环境中连通验证过；未验证的需要使用者先确认 */
  verified: boolean;
  /** 使用者需要在本地配置的项 */
  fields: ConfigField[];
  mcp?: {
    serverName: string;
    transport: "streamable-http" | "stdio";
    /** streamable-http 时，服务地址对应的配置项名（见 fields） */
    urlField?: string;
    command?: string;
    args?: string[];
  };
  /** API：基础地址、鉴权方式和请求示例（都只含占位符） */
  api?: {
    baseUrlField?: string;
    auth?: { header: string; scheme: "Bearer" | "raw"; field: string };
    examples: Array<{ title: string; method: "GET" | "POST"; path: string; body?: unknown }>;
  };
  /** CLI：命令名、安装检查、登录检查 */
  cli?: { command: string; installCheck: string; loginCheck?: string };
  /** Webhook：地址所在的配置项和一个消息示例 */
  webhook?: { urlField: string; example: unknown };
  /** 集成提供的具体操作；一期的 api.examples 与 webhook.example 仍保留，供 CONNECTIONS.md 使用 */
  operations: Operation[];
  /** 各平台的写法；未验证前不填写 */
  targets?: PlatformTargets;
  /** 连通性检查：导出的 Skill 会在前置条件中写明，供使用者先验证 */
  verify: string;
  notes?: string;
}

export const INTEGRATION_CATALOG: IntegrationEntry[] = [
  {
    id: "dingtalk-doc",
    name: "钉钉文档",
    summary: "读写钉钉文档（通过钉钉 MCP 网关）",
    access: "mcp",
    verified: false,
    fields: [
      { name: "DINGTALK_DOC_MCP_URL", secret: true, description: "钉钉文档 MCP 服务地址（含访问 key，属于凭证，只保存在您自己的 .mcp.json 中）" },
    ],
    mcp: {
      serverName: "钉钉文档",
      transport: "streamable-http",
      urlField: "DINGTALK_DOC_MCP_URL",
    },
    // 工具名要等 MCP 服务连接后才能确定，暂不登记操作
    operations: [],
    verify: "在 Agent 中列出钉钉文档 MCP 提供的工具；能列出即表示连接正常。",
    notes: "地址中的 key 是凭证，只保存在使用者自己的 .mcp.json 中，平台不保存。",
  },
  {
    id: "erp",
    name: "ERP 订单",
    summary: "通过 ERP 接口拉取订单数据",
    access: "api",
    verified: false,
    fields: [
      { name: "ERP_BASE_URL", secret: false, description: "ERP 服务的企业内部地址（域名或 IP 加端口）" },
      { name: "ERP_TOKEN", secret: true, description: "ERP 接口的访问令牌" },
    ],
    api: {
      baseUrlField: "ERP_BASE_URL",
      auth: { header: "Authorization", scheme: "Bearer", field: "ERP_TOKEN" },
      examples: [{ title: "拉取订单列表", method: "GET", path: "<订单接口路径，待对接时确认>?start=<开始日期>&end=<结束日期>" }],
    },
    operations: [
      {
        id: "listOrders",
        title: "查询订单",
        description: "按时间范围拉取订单列表",
        params: [
          { name: "start", description: "开始日期，格式 YYYY-MM-DD", required: true },
          { name: "end", description: "结束日期，格式 YYYY-MM-DD", required: true },
        ],
        output: [{ name: "orders", type: "array", description: "订单列表" }],
        api: { method: "GET", path: "<订单接口路径，待对接时确认>", query: { start: "start", end: "end" } },
      },
    ],
    verify: "使用 ERP_TOKEN 请求 ERP 的订单接口，返回 200 即正常。订单接口路径需要在对接时确认。",
    notes: "订单接口的具体路径和参数尚未确认，导出时会标注为待确认。",
  },
  {
    id: "dingtalk-bot",
    name: "钉钉群机器人",
    summary: "向钉钉群发送消息（自定义机器人 Webhook）",
    access: "webhook",
    verified: false,
    fields: [
      { name: "DINGTALK_BOT_WEBHOOK_URL", secret: true, description: "钉钉群机器人的 Webhook 地址（含签名或 access_token，属于凭证）" },
    ],
    webhook: {
      urlField: "DINGTALK_BOT_WEBHOOK_URL",
      example: { msgtype: "text", text: { content: "<要发送的消息内容>" } },
    },
    operations: [
      {
        id: "sendText",
        title: "发送文本消息",
        description: "向群里发送一条文本消息",
        params: [{ name: "content", description: "消息内容", required: true }],
        output: [],
        webhook: { body: { msgtype: "text", text: { content: "<content>" } } },
      },
    ],
    verify: "向测试群发送一条消息，群里收到即正常。",
  },
  {
    id: "github-cli",
    name: "GitHub CLI",
    summary: "使用 gh 命令行工具读写 GitHub 仓库和 PR",
    access: "cli",
    verified: false,
    fields: [],
    cli: { command: "gh", installCheck: "gh --version", loginCheck: "gh auth status" },
    verify: "依次执行安装检查和登录检查，两条命令都成功即正常。",
    operations: [
      {
        id: "listPullRequests",
        title: "查询 PR 列表",
        description: "列出仓库中的 Pull Request",
        params: [{ name: "repo", description: "仓库，格式 owner/name", required: true }],
        output: [{ name: "pullRequests", type: "array", description: "PR 列表（JSON）" }],
        cli: { command: "gh pr list --repo <repo> --json number,title,state,author" },
      },
    ],
    notes: "登录凭证由 gh 自己保存在本机，平台和 Skill 都不保存。",
  },
  {
    id: "local-file",
    name: "本地文件",
    summary: "读取本地的 Excel 或 CSV 文件",
    access: "manual",
    verified: true,
    fields: [{ name: "LOCAL_DATA_DIR", secret: false, description: "存放数据文件的目录（可选，默认为当前工作目录）" }],
    operations: [],
    verify: "确认目标文件存在且可读，例如列出数据目录中的文件。",
  },
];

export function findIntegration(id: string): IntegrationEntry | undefined {
  return INTEGRATION_CATALOG.find((e) => e.id === id);
}

/** 某个集成在指定平台的写法；没有登记时返回 undefined，插件应退回通用的 HTTP 节点 */
export function findTarget(integrationId: string, platform: keyof PlatformTargets): PlatformTargets[keyof PlatformTargets] | undefined {
  return findIntegration(integrationId)?.targets?.[platform];
}

export function findOperation(integrationId: string, operationId: string): Operation | undefined {
  return findIntegration(integrationId)?.operations.find((o) => o.id === operationId);
}
