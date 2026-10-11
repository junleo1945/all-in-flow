import { describe, expect, it } from "vitest";
import { createRuntime, resolveModel, DEFAULT_DEEPSEEK_BASE_URL } from "../src/agent/models.js";
import { loadConfig } from "../src/config.js";

describe("DeepSeek 请求地址可配置", () => {
  it("默认使用官方地址", async () => {
    const runtime = await createRuntime({});
    expect(resolveModel(runtime, "deepseek/deepseek-flash").baseUrl).toBe(DEFAULT_DEEPSEEK_BASE_URL);
  });

  it("配置 deepseekBaseUrl 后，模型请求地址随之改变，且保留内置模型", async () => {
    const runtime = await createRuntime({ deepseekBaseUrl: "https://gateway.example.test/v1" });
    const model = resolveModel(runtime, "deepseek/deepseek-flash");
    expect(model.baseUrl).toBe("https://gateway.example.test/v1");
    expect(resolveModel(runtime, "deepseek/deepseek-v4-pro").id).toBe("deepseek-v4-pro");
  });

  it("环境变量 DEEPSEEK_BASE_URL 生效，未设置时为默认值", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x/y", DEEPSEEK_BASE_URL: "https://proxy.test" }).deepseekBaseUrl).toBe("https://proxy.test");
    expect(loadConfig({ DATABASE_URL: "postgres://x/y" }).deepseekBaseUrl).toBe(DEFAULT_DEEPSEEK_BASE_URL);
  });
});
