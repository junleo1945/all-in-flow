import { parseSecretKey } from "./auth/secretBox.js";

export interface AppConfig {
  databaseUrl: string;
  port: number;
  deepseekApiKey?: string;
  /** DeepSeek 请求地址，默认 https://api.deepseek.com */
  deepseekBaseUrl: string;
  /** 自定义模型清单路径（models.json），可选 */
  modelsJsonPath?: string;
  /** 图片识别模型 ID（如 qwen3.8-flash）；不配置则不开启图片上传 */
  visionModelId?: string;
  /** 图片识别的请求地址与密钥，默认与 DeepSeek 相同（同一代理） */
  visionBaseUrl: string;
  visionApiKey?: string;
  /** 是否开启思考（千问的 enable_thinking）；默认关闭，速度更快 */
  visionThinking: boolean;
  attachmentDir: string;
  attachmentMaxBytes: number;
  attachmentMaxPerMessage: number;
  attachmentDailyLimitPerUser: number;
  /** 访谈 Agent 使用的模型，格式 provider/modelId */
  agentModel: string;
  /** 生成工作流 IR 使用的模型 */
  workflowModel: string;
  erpBaseUrl: string;
  ssoAppCode: string;
  cookieSecure: boolean;
  cookieDomain?: string;
  verifyIntervalSeconds: number;
  adminUsernames: string[];
  publicBaseUrl: string;
  sharePublicEnabled: boolean;
  dailyTokenQuotaPerUser: number;
  dailyCostLimitUsd: number;
  maxTurnsPerConversation: number;
  /** 授权信息的加密密钥（AUTH_SECRET_KEY，32 字节）；没有时授权管理与 n8n 导出关闭 */
  authSecretKey?: Buffer;
  /** 允许授权的地址指向内网（仅内部部署时开启） */
  allowPrivateHosts: boolean;
}

const bool = (v: string | undefined, def: boolean) =>
  v === undefined || v === "" ? def : ["true", "1", "yes"].includes(v.toLowerCase());
const num = (v: string | undefined, def: number) => (v && v.trim() !== "" ? Number(v) : def);
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL 未配置");
  return {
    databaseUrl: env.DATABASE_URL,
    port: num(env.PORT, 3000),
    deepseekApiKey: env.DEEPSEEK_API_KEY || undefined,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    modelsJsonPath: env.MODELS_JSON_PATH || undefined,
    visionModelId: env.VISION_MODEL_ID || undefined,
    visionBaseUrl: env.VISION_BASE_URL || env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    visionApiKey: env.VISION_API_KEY || env.DEEPSEEK_API_KEY || undefined,
    visionThinking: bool(env.VISION_THINKING, false),
    attachmentDir: env.ATTACHMENT_DIR || "/tmp/aif-uploads",
    attachmentMaxBytes: num(env.ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024),
    attachmentMaxPerMessage: num(env.ATTACHMENT_MAX_PER_MESSAGE, 4),
    attachmentDailyLimitPerUser: num(env.ATTACHMENT_DAILY_LIMIT_PER_USER, 50),
    agentModel: env.AGENT_MODEL || "deepseek/deepseek-flash",
    workflowModel: env.WORKFLOW_MODEL || "deepseek/deepseek-v4-pro",
    erpBaseUrl: env.ERP_BASE_URL || "https://erp.tourmind.cn",
    ssoAppCode: env.SSO_APP_CODE ?? "",
    cookieSecure: bool(env.SESSION_COOKIE_SECURE, false),
    cookieDomain: env.SESSION_COOKIE_DOMAIN || undefined,
    verifyIntervalSeconds: num(env.SESSION_VERIFY_INTERVAL_SECONDS, 300),
    adminUsernames: list(env.ADMIN_USERNAMES),
    publicBaseUrl: env.PUBLIC_BASE_URL || "http://localhost",
    sharePublicEnabled: bool(env.SHARE_PUBLIC_ENABLED, false),
    dailyTokenQuotaPerUser: num(env.DAILY_TOKEN_QUOTA_PER_USER, 2_000_000),
    dailyCostLimitUsd: num(env.DAILY_COST_LIMIT_USD, 20),
    maxTurnsPerConversation: num(env.MAX_TURNS_PER_CONVERSATION, 80),
    authSecretKey: parseSecretKey(env.AUTH_SECRET_KEY),
    allowPrivateHosts: bool(env.MCP_ALLOW_PRIVATE_HOSTS, false),
  };
}
