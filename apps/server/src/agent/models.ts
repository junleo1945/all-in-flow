import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** 解析 "provider/modelId"，例如 deepseek/deepseek-flash */
export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) throw new Error(`模型引用格式错误，应为 provider/modelId：${ref}`);
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/**
 * 创建模型运行时。凭证放在临时目录，不落到项目里；平台 Key 通过 setRuntimeApiKey 注入。
 */
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export async function createRuntime(opts: {
  deepseekApiKey?: string;
  deepseekBaseUrl?: string;
  /** 自定义模型清单（Pi 的 models.json 格式）；不填则只使用内置模型 */
  modelsJsonPath?: string;
}): Promise<ModelRuntime> {
  const dir = mkdtempSync(join(tmpdir(), "aif-models-"));
  // Pi 会在 models.json 所在目录写入 models-store.json，其中可能包含运行时密钥。
  // 因此复制一份到临时目录使用，避免状态文件落到项目或只读挂载的配置目录中。
  const modelsPath = join(dir, "models.json");
  if (opts.modelsJsonPath) copyFileSync(opts.modelsJsonPath, modelsPath);
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath,
  });
  // 只覆盖 baseUrl：Pi 保留该 provider 的内置模型，模型请求改发到配置的地址（例如代理或私有网关）
  const baseUrl = opts.deepseekBaseUrl?.trim();
  if (baseUrl && baseUrl !== DEFAULT_DEEPSEEK_BASE_URL) {
    runtime.registerProvider("deepseek", { baseUrl });
  }
  if (opts.deepseekApiKey) {
    await runtime.setRuntimeApiKey("deepseek", opts.deepseekApiKey);
  }
  return runtime;
}

export type RuntimeModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export function resolveModel(runtime: ModelRuntime, ref: string): RuntimeModel {
  const { provider, modelId } = parseModelRef(ref);
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error(`找不到模型：${ref}`);
  return model;
}

/** 图片识别模型所在的 provider 名称（与访谈模型分开，便于单独换模型或换地址） */
export const VISION_PROVIDER = "vision";

/**
 * 注册图片识别模型。模型 ID 由配置传入（例如 qwen3.8-flash），
 * 地址与密钥默认复用访谈模型所在的代理（OpenAI 兼容接口）。
 */
export async function registerVisionModel(
  runtime: ModelRuntime,
  opts: { modelId: string; baseUrl: string; apiKey?: string },
): Promise<RuntimeModel> {
  runtime.registerProvider(VISION_PROVIDER, {
    name: "图片识别",
    baseUrl: opts.baseUrl,
    api: "openai-completions",
    models: [
      {
        id: opts.modelId,
        name: opts.modelId,
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // 千问通过 enable_thinking 控制思考，不支持 developer 角色
        compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
      } as any,
    ],
  });
  if (opts.apiKey) await runtime.setRuntimeApiKey(VISION_PROVIDER, opts.apiKey);
  const model = runtime.getModel(VISION_PROVIDER, opts.modelId);
  if (!model) throw new Error(`图片识别模型注册失败：${opts.modelId}`);
  return model;
}
