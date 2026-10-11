import { describe, expect, it } from "vitest";
import { runTurn, userFacingError } from "../src/routes/conversations.js";
import { SessionBusy } from "../src/agent/registry.js";

describe("返回给前端的错误文案", () => {
  it("缺少 API Key 时给出可理解的提示，不暴露内部路径", () => {
    const raw = new Error("No API key found for deepseek.\nUse /login ... /Users/king/Desktop/owner-king/all-in-flow/node_modules/.pnpm/x/docs/providers.md");
    const msg = userFacingError(raw);
    expect(msg).toBe("模型服务尚未配置，请联系管理员。");
    expect(msg).not.toMatch(/node_modules|\/Users\//);
  });

  it("其他错误统一为通用提示", () => {
    expect(userFacingError(new Error("socket hang up at /srv/app/x.js:12"))).toBe("AI 顾问暂时无法回复，请稍后再试。");
  });

  it("并发冲突保留原提示", () => {
    expect(userFacingError(new SessionBusy("上一条消息还在处理中，请稍候"))).toBe("上一条消息还在处理中，请稍候");
  });
});

describe("runTurn：事件顺序", () => {
  it("失败时发送 error，之后一定有 done，且不泄露内部细节", async () => {
    const events: Array<[string, unknown]> = [];
    await runTurn(
      (e, d) => {
        events.push([e, d]);
      },
      async () => {
        throw new Error("模拟模型故障 /internal/path");
      },
    );
    expect(events.map(([e]) => e)).toEqual(["error", "done"]);
    expect(JSON.stringify(events)).not.toContain("/internal/path");
  });

  it("成功时只发送业务事件，最后是 done", async () => {
    const events: string[] = [];
    await runTurn(
      (e) => {
        events.push(e);
      },
      async (sink) => {
        sink("text_delta", { delta: "你好" });
      },
    );
    expect(events).toEqual(["text_delta", "done"]);
  });
});
