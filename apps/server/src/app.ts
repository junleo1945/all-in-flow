import { Hono } from "hono";
import type { AuthService } from "./auth/service.js";
import type { FixedWindowLimiter } from "./auth/limiter.js";
import { AppError, fail } from "./http/envelope.js";
import type { AppVariables } from "./http/context.js";
import { userRoutes } from "./routes/user.js";
import { conversationRoutes, type ConversationRouteDeps } from "./routes/conversations.js";
import { workflowRoutes } from "./routes/workflows.js";
import { authorizationRoutes } from "./routes/authorizations.js";
import { n8nExportRoutes } from "./routes/n8nExport.js";
import type { N8nExporter } from "./n8n/exportAgent.js";
import type { McpDeps } from "./n8n/mcp.js";
import { shareRoutes } from "./routes/shares.js";
import { adminRoutes } from "./routes/admin.js";
import { exporterRoutes } from "./routes/exporters.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { integrationRoutes } from "./routes/integrations.js";
import { FixedWindowLimiter as Limiter } from "./auth/limiter.js";
import type { AttachmentService } from "./attachments/service.js";
import type { ExporterPlugin } from "@aif/workflow-ir";
import { requireUser } from "./http/middleware.js";
import { localeOf } from "./i18n.js";
import type { Db } from "./db/client.js";
import { tm, tr } from "./i18n.js";

export interface AppDeps {
  auth: AuthService;
  loginLimiter: FixedWindowLimiter;
  cookieSecure: boolean;
  cookieDomain?: string;
  db: Db;
  exporters?: ExporterPlugin<any>[];
  /** 导出 n8n 工作流的 skill（未配置时导出接口返回 503） */
  n8nExporter?: N8nExporter;
  /** 访问用户 n8n 的 MCP 服务时使用的依赖（测试中替换 fetch 与域名解析） */
  n8nMcp?: McpDeps;
  registry: ConversationRouteDeps["registry"];
  attachments?: AttachmentService;
  /** 图片识别是否开启（图片存储与查看不受影响） */
  visionEnabled?: boolean;
  config: ConversationRouteDeps["config"] & {
    sharePublicEnabled: boolean;
    publicBaseUrl: string;
    dailyCostLimitUsd: number;
    /** 授权信息的加密密钥；没有时授权管理与 n8n 导出关闭 */
    authSecretKey?: Buffer;
    /** 允许授权的地址指向内网（仅内部部署） */
    allowPrivateHosts?: boolean;
  };
}

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: AppVariables }>();
  // 每个请求都带上界面语言，路由和中间件用 c.get("locale") 取用
  app.use("*", async (c, next) => {
    c.set("locale", localeOf(c));
    await next();
  });

  app.route("/api/user", userRoutes({ ...deps, dailyTokenQuotaPerUser: deps.config.dailyTokenQuotaPerUser, sharePublicEnabled: deps.config.sharePublicEnabled, visionEnabled: !!deps.visionEnabled }));
  app.use("/api/exporters", requireUser(deps.auth));
  app.route("/api/exporters", exporterRoutes({ plugins: deps.exporters ?? [] }));
  app.route("/api/admin", adminRoutes({ db: deps.db, auth: deps.auth, dailyCostLimitUsd: deps.config.dailyCostLimitUsd }));

  const authed = requireUser(deps.auth);
  app.use("/api/conversations/*", authed);
  app.use("/api/conversations", authed);
  app.route("/api/conversations", conversationRoutes(deps));
  app.use("/api/attachments/*", authed);
  app.route("/api", attachmentRoutes({ attachments: deps.attachments }));
  app.use("/api/integrations/*", authed);
  app.route("/api/integrations", integrationRoutes({ limiter: new Limiter(10, 60_000) }));
  app.use("/api/workflows/*", authed);
  app.route("/api/workflows", workflowRoutes(deps));
  app.use("/api/authorizations", authed);
  app.use("/api/authorizations/*", authed);
  app.route("/api/authorizations", authorizationRoutes({ db: deps.db, secretKey: deps.config.authSecretKey, limiter: new Limiter(10, 60_000), mcp: { ...deps.n8nMcp, allowPrivateHosts: deps.config.allowPrivateHosts } }));
  app.route("/api/workflows", n8nExportRoutes({ db: deps.db, config: deps.config, exporter: deps.n8nExporter, limiter: new Limiter(3, 60_000), mcp: deps.n8nMcp }));
  app.use("/api/shares", authed);
  app.use("/api/shares/*", authed);
  app.route("/api", shareRoutes(deps));

  app.notFound((c) => fail(c, 404, tm(c.get("locale"), "common.notFound")));

  app.onError((err, c) => {
    if (err instanceof AppError) return fail(c, err.status, tr(c.get("locale"), err.message), err.code);
    console.error(err);
    return fail(c, 500, tm(c.get("locale"), "common.internal"));
  });

  return app;
}
