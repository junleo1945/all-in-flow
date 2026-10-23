import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const env = (extra: Record<string, string> = {}) => ({ DATABASE_URL: "postgres://x/y", ...extra });

describe("访谈 Agent 的思考等级", () => {
  it("默认 high，可以关闭或调低，大小写和空格不影响", () => {
    expect(loadConfig(env()).agentThinkingLevel).toBe("high");
    expect(loadConfig(env({ AGENT_THINKING_LEVEL: "" })).agentThinkingLevel).toBe("high");
    expect(loadConfig(env({ AGENT_THINKING_LEVEL: "off" })).agentThinkingLevel).toBe("off");
    expect(loadConfig(env({ AGENT_THINKING_LEVEL: " Low " })).agentThinkingLevel).toBe("low");
  });

  it("取值无效时启动报错，而不是悄悄按默认值运行", () => {
    expect(() => loadConfig(env({ AGENT_THINKING_LEVEL: "on" }))).toThrow("AGENT_THINKING_LEVEL");
  });
});
