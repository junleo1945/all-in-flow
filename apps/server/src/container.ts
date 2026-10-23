import type { AppConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createErpClient } from "./auth/erp.js";
import { createAuthService } from "./auth/service.js";
import { FixedWindowLimiter } from "./auth/limiter.js";
import { createRuntime, registerVisionModel, resolveModel } from "./agent/models.js";
import { createLocalStorage } from "./attachments/storage.js";
import { createVisionService } from "./attachments/vision.js";
import { createAttachmentService } from "./attachments/service.js";
import { createIrGenerator } from "./agent/irGenerator.js";
import { createN8nExporter } from "./n8n/exportAgent.js";
import { createSkillAuthor } from "./skill/authorAgent.js";
import { createSessionRegistry } from "./agent/registry.js";
import { createApp } from "./app.js";
import { skillExporter } from "@aif/plugin-exporter-skill";
import { promptExporter } from "@aif/plugin-exporter-prompt";
import type { ExporterPlugin } from "@aif/workflow-ir";

/** 所有对用户开放的导出插件，随代码发布，不通过环境变量开关。n8n 插件尚未成熟，暂不开放 */
const ALL_EXPORTERS: ExporterPlugin<any>[] = [skillExporter, promptExporter];

/** 组装所有依赖。测试和正式启动共用这一份装配逻辑。 */
export async function buildContainer(config: AppConfig, overrides: { agentModel?: any; workflowModel?: any; runtime?: any } = {}) {
  const { db, sql } = createDb(config.databaseUrl);
  const runtime = overrides.runtime ?? (await createRuntime({ deepseekApiKey: config.deepseekApiKey, deepseekBaseUrl: config.deepseekBaseUrl, modelsJsonPath: config.modelsJsonPath }));
  const agentModel = overrides.agentModel ?? resolveModel(runtime, config.agentModel);
  const workflowModel = overrides.workflowModel ?? resolveModel(runtime, config.workflowModel);

  const erp = createErpClient({ baseUrl: config.erpBaseUrl, appCode: config.ssoAppCode });
  const auth = createAuthService({
    db,
    erp,
    adminUsernames: config.adminUsernames,
    verifyIntervalSeconds: config.verifyIntervalSeconds,
  });

  const generateIr = createIrGenerator({ runtime, model: workflowModel });
  const n8nExporter = createN8nExporter({ runtime, model: workflowModel });
  // 没有配置模型密钥时不开放：导出接口返回 503，前端改用浏览器内的基础导出
  const skillAuthor = config.deepseekApiKey || overrides.runtime ? createSkillAuthor({ runtime, model: workflowModel }) : undefined;
  // 图片识别（千问，走和 DeepSeek 相同的代理）：配置了 VISION_MODEL_ID 才开启
  // 图片存储始终可用（关闭识别后，已上传的图片仍能查看）；识别只在配置了模型时启用
  const visionEnabled = !!config.visionModelId;
  const attachments = createAttachmentService({
    db,
    storage: createLocalStorage(config.attachmentDir),
    vision: visionEnabled
      ? createVisionService({
          runtime,
          model: await registerVisionModel(runtime, {
            modelId: config.visionModelId!,
            baseUrl: config.visionBaseUrl,
            apiKey: config.visionApiKey,
          }),
          thinking: config.visionThinking,
        })
      : undefined,
    visionModelId: config.visionModelId,
    maxBytes: config.attachmentMaxBytes,
    maxPerMessage: config.attachmentMaxPerMessage,
    dailyLimitPerUser: config.attachmentDailyLimitPerUser,
  });

  const registry = createSessionRegistry({
    db,
    runtime,
    agentModel,
    thinkingLevel: config.agentThinkingLevel,
    generateIr,
    askImage: visionEnabled ? (userId, conversationId, attachmentId, question) => attachments.ask(userId, conversationId, attachmentId, question) : undefined,
  });

  const app = createApp({
    db,
    auth,
    loginLimiter: new FixedWindowLimiter(10, 60_000),
    cookieSecure: config.cookieSecure,
    cookieDomain: config.cookieDomain,
    registry,
    attachments,
    visionEnabled,
    config,
    exporters: ALL_EXPORTERS,
    n8nExporter,
    skillAuthor,
  });

  return { app, db, sql, registry, auth };
}
