import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { migrateIr, type WorkflowIR } from "@aif/workflow-ir";
import { createRuntime } from "../src/agent/models.js";
import { createIrGenerator, IrGenerationError } from "../src/agent/irGenerator.js";
import { buildIrSystemPrompt, IR_SYSTEM_PROMPT } from "../src/agent/irPrompt.js";
import { salesReport } from "./fixtures.js";

/** 一个通过校验的 v2 工作流：n1 调用 ERP 操作，n3/n4 带 action */
function validV2(): WorkflowIR {
  const ir = structuredClone(migrateIr(salesReport));
  const byId = (id: string) => ir.nodes.find((n) => n.id === id)!;
  Object.assign(byId("n1"), {
    action: { kind: "integration", integration: "erp", operation: "listOrders", params: { start: "2026-10-01", end: "2026-10-07" } },
    outputs: [{ name: "orders", type: "array", description: "订单列表" }],
  });
  Object.assign(byId("n3"), { action: { kind: "human", message: "请确认异常订单是否计入" } });
  Object.assign(byId("n4"), { action: { kind: "llm", prompt: "汇总销售数据：{{n1.orders}}" } });
  return ir;
}

const json = (ir: unknown) => JSON.stringify(ir);

describe("IR 生成器（假模型）", () => {
  const setup = async () => {
    const faux = fauxProvider();
    const runtime = await createRuntime({});
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, "test-key");
    return { faux, runtime, model: faux.getModel() };
  };

  it("第一次输出合法时直接返回，没有警告", async () => {
    const { faux, runtime, model } = await setup();
    faux.setResponses([fauxAssistantMessage(json(validV2()))]);
    const gen = createIrGenerator({ runtime, model });
    const r = await gen("方案", "{}");
    expect(r.warnings).toEqual([]);
    expect(r.ir.nodes.find((n) => n.id === "n1")).toMatchObject({ action: { kind: "integration", operation: "listOrders" } });
  });

  it("校验失败后根据错误修复（操作不存在）", async () => {
    const { faux, runtime, model } = await setup();
    const bad = validV2();
    (bad.nodes.find((n) => n.id === "n1") as any).action.operation = "noSuchOp";
    faux.setResponses([fauxAssistantMessage(json(bad)), fauxAssistantMessage(json(validV2()))]);
    const r = await createIrGenerator({ runtime, model })("方案", "{}");
    expect(r.warnings).toEqual([]);
    expect(r.ir.nodes.find((n) => n.id === "n1")).toMatchObject({ action: { operation: "listOrders" } });
  });

  it("修复失败且只有 action 出错时，去掉这些 action 并给出警告", async () => {
    const { faux, runtime, model } = await setup();
    const bad = validV2();
    (bad.nodes.find((n) => n.id === "n1") as any).action.operation = "noSuchOp";
    faux.setResponses([fauxAssistantMessage(json(bad)), fauxAssistantMessage(json(bad)), fauxAssistantMessage(json(bad))]);
    const r = await createIrGenerator({ runtime, model })("方案", "{}");
    const n1 = r.ir.nodes.find((n) => n.id === "n1")!;
    expect(n1.type === "step" && n1.action).toBeFalsy();
    expect(n1.type === "step" && n1.instructions).toBeTruthy();
    expect(r.warnings.join("\n")).toMatch(/已退回为文字说明/);
    // 其他步骤的 action 保留
    expect(r.ir.nodes.find((n) => n.id === "n4")).toMatchObject({ action: { kind: "llm" } });
  });

  it("结构性错误无法靠去掉 action 修复，直接报错", async () => {
    const { faux, runtime, model } = await setup();
    const bad = validV2();
    bad.nodes = bad.nodes.filter((n) => n.type !== "start");
    faux.setResponses([fauxAssistantMessage(json(bad)), fauxAssistantMessage(json(bad)), fauxAssistantMessage(json(bad))]);
    await expect(createIrGenerator({ runtime, model })("方案", "{}")).rejects.toBeInstanceOf(IrGenerationError);
  });
});

describe("IR 提示词", () => {
  it("列出所有登记的操作，并要求 version 2", () => {
    for (const op of ["listOrders", "sendText", "listPullRequests"]) expect(IR_SYSTEM_PROMPT).toContain(`"${op}"`);
    expect(IR_SYSTEM_PROMPT).toMatch(/version 为 2|version\(固定为 2\)/);
    expect(IR_SYSTEM_PROMPT).toContain("没有登记操作的集成");
  });

  it("没有操作时不会列出空的清单", () => {
    expect(buildIrSystemPrompt([])).not.toContain('integration "');
  });
});
