import { describe, expect, it } from "vitest";
import { backfillChatInstructions, missingChatSteps } from "../src/agent/chatBackfill.js";
import { salesReport } from "./fixtures.js";

describe("旧工作流补写 chatInstructions", () => {
  it("只给缺说明的 deterministic 步骤补写，其他内容不动", async () => {
    expect(missingChatSteps(salesReport).map((n) => n.id)).toEqual(["n1"]);
    const asked: string[] = [];
    const { ir, filled } = await backfillChatInstructions(salesReport, async (_s, p) => {
      asked.push(p);
      return '```json\n{"n1":"在 ERP 的订单查询里导出本周订单","n3":"不该被写入"}\n```';
    });
    expect(filled).toBe(1);
    const n1 = ir.nodes.find((n) => n.id === "n1");
    expect(n1?.type === "step" && n1.chatInstructions).toBe("在 ERP 的订单查询里导出本周订单");
    // 人工和大模型步骤保持原样
    expect(JSON.stringify(ir.nodes.filter((n) => n.id !== "n1"))).toBe(JSON.stringify(salesReport.nodes.filter((n) => n.id !== "n1")));
    expect(asked[0]).toContain("拉取本周订单");
    expect(asked[0]).not.toContain("生成周报");
  });

  it("没有缺口时不请求模型；模型输出无法解析或带引用时不写入", async () => {
    const done = (await backfillChatInstructions(salesReport, async () => '{"n1":"在 ERP 里导出"}')).ir;
    const none = await backfillChatInstructions(done, async () => {
      throw new Error("不应该被调用");
    });
    expect(none.filled).toBe(0);
    expect((await backfillChatInstructions(salesReport, async () => "不是 JSON")).filled).toBe(0);
    expect((await backfillChatInstructions(salesReport, async () => '{"n1":"导出 {{n1.orders}}"}')).filled).toBe(0);
  });
});
