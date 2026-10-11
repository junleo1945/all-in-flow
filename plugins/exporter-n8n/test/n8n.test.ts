import { describe, expect, it } from "vitest";
import { checkExport, lower, type WorkflowIR } from "@aif/workflow-ir";
import { n8nExporter, type N8nWorkflow } from "../src/index.js";

const ir: WorkflowIR = {
  version: 2,
  kind: "automation",
  slug: "weekly-report",
  name: "销售周报",
  description: "每周汇总订单并生成周报。当用户需要写周报时使用。",
  trigger: { type: "schedule", detail: "每周五 17:00", cron: "0 17 * * 5" },
  inputs: [],
  integrations: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    {
      id: "n1",
      type: "step",
      title: "拉取订单",
      executor: "deterministic",
      instructions: "调用订单接口",
      action: { kind: "http", method: "GET", url: "https://erp.example.com/orders?day={{input.day}}" },
    },
    { id: "n2", type: "decision", title: "有异常订单", mode: "expr" },
    {
      id: "n3",
      type: "step",
      title: "汇总异常",
      executor: "deterministic",
      instructions: "汇总异常订单",
      action: { kind: "transform", template: "异常：{{n1.orders}}" },
    },
    { id: "n4", type: "step", title: "生成周报", executor: "llm", instructions: "按模板写周报" },
    { id: "m", type: "merge", title: "汇合" },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3", condition: { left: "n1.count", op: "gt", right: 0 } },
    { from: "n2", to: "n4", default: true },
    { from: "n3", to: "m" },
    { from: "n4", to: "m" },
    { from: "m", to: "e" },
  ],
  source: { painPointIds: [] },
};

function compileOk(): N8nWorkflow {
  const graph = lower(ir);
  const issues = checkExport(n8nExporter, graph);
  expect(issues.filter((i) => i.level === "error")).toEqual([]);
  const [file] = n8nExporter.compile(graph, n8nExporter.defaultOptions) as Array<{ path: string; content: string }>;
  expect(file!.path).toBe("weekly-report.n8n.json");
  return JSON.parse(file!.content) as N8nWorkflow;
}

describe("n8nExporter", () => {
  it("把触发器、HTTP、条件、转换和汇合映射为对应的 n8n 节点", () => {
    const wf = compileOk();
    const types = wf.nodes.filter((n) => !n.type.includes("stickyNote")).map((n) => n.type);
    expect(types).toEqual([
      "n8n-nodes-base.scheduleTrigger",
      "n8n-nodes-base.httpRequest",
      "n8n-nodes-base.if",
      "n8n-nodes-base.set",
      "n8n-nodes-base.noOp",
      "n8n-nodes-base.merge",
      "n8n-nodes-base.noOp",
    ]);
  });

  it("改写引用为 n8n 表达式", () => {
    const wf = compileOk();
    const http = wf.nodes.find((n) => n.type === "n8n-nodes-base.httpRequest")!;
    expect(http.parameters.url).toBe("=https://erp.example.com/orders?day={{ $('触发器（定时触发）').item.json.day }}");
    const set = wf.nodes.find((n) => n.type === "n8n-nodes-base.set")!;
    expect(JSON.stringify(set.parameters)).toContain("=异常：{{ $('拉取订单').item.json.orders }}");
  });

  it("IF 的真分支接输出 0，假分支接输出 1；占位节点附带便签", () => {
    const wf = compileOk();
    const ifNode = wf.nodes.find((n) => n.type === "n8n-nodes-base.if")!;
    const conn = wf.connections[ifNode.name]!;
    expect(conn.main[0]!.map((c) => c.node)).toEqual(["汇总异常"]);
    expect(conn.main[1]!.map((c) => c.node)).toEqual(["生成周报"]);
    expect(wf.nodes.some((n) => n.type === "n8n-nodes-base.stickyNote" && String(n.parameters.content).includes("按模板写周报"))).toBe(true);
  });

  it("汇合节点的两条入边使用不同的输入槽", () => {
    const wf = compileOk();
    const indexes = [wf.connections["汇总异常"]!, wf.connections["生成周报"]!].map((c) => c.main[0]![0]!.index);
    expect(indexes.sort()).toEqual([0, 1]);
  });

  it("汇合节点入边超过两条时设置输入数量，每条入边占一个输入槽", () => {
    const threeWay: WorkflowIR = {
      ...ir,
      nodes: [
        ...ir.nodes.filter((n) => n.type !== "merge"),
        { id: "m", type: "merge", title: "汇合" },
        { id: "x", type: "step", title: "分支 C", executor: "deterministic", instructions: "C", action: { kind: "transform", template: "c" } },
      ],
      edges: [
        { from: "s", to: "n1" },
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3", condition: { left: "n1.count", op: "gt", right: 0 } },
        { from: "n2", to: "x", default: true },
        { from: "n3", to: "m" },
        { from: "x", to: "m" },
        { from: "n4", to: "m" },
        { from: "m", to: "e" },
      ],
    };
    const graph = lower(threeWay);
    const [file] = n8nExporter.compile(graph, n8nExporter.defaultOptions) as Array<{ content: string }>;
    const wf = JSON.parse(file!.content) as N8nWorkflow;
    const merge = wf.nodes.find((n) => n.type === "n8n-nodes-base.merge")!;
    expect(merge.parameters).toEqual({ numberInputs: 3 });
    const slots = ["汇总异常", "分支 C", "生成周报"].map((name) => wf.connections[name]!.main[0]![0]!.index);
    expect(slots.sort()).toEqual([0, 1, 2]);
  });

  it("两条入边的汇合节点不设置输入数量", () => {
    const wf = compileOk();
    const merge = wf.nodes.find((n) => n.type === "n8n-nodes-base.merge")!;
    expect(merge.parameters).toEqual({});
  });
});

/** 逐条核对订单：循环体内有条件分支，循环的输出在后面被引用 */
const loopIr: WorkflowIR = {
  version: 2,
  kind: "automation",
  slug: "order-loop",
  name: "逐条核对订单",
  description: "逐条核对订单并汇总。当用户需要核对订单时使用。",
  trigger: { type: "manual", detail: "手动" },
  inputs: [],
  integrations: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    {
      id: "n1",
      type: "step",
      title: "拉取订单",
      executor: "deterministic",
      instructions: "调用订单接口",
      action: { kind: "http", method: "GET", url: "https://erp.example.com/orders" },
      outputs: [{ name: "orders", type: "array", description: "订单" }],
    },
    {
      id: "f",
      type: "foreach",
      title: "逐条核对",
      over: "n1.orders",
      item: "order",
      body: {
        nodes: [
          { id: "bs", type: "start", title: "本条开始" },
          { id: "b1", type: "decision", title: "是否大额", mode: "expr" },
          {
            id: "b2",
            type: "step",
            title: "标记大额",
            executor: "deterministic",
            instructions: "标记大额订单",
            action: { kind: "transform", template: "大额：{{order.id}}" },
          },
          { id: "be", type: "end", title: "本条结束" },
        ],
        edges: [
          { from: "bs", to: "b1" },
          { from: "b1", to: "b2", condition: { left: "order.amount", op: "gt", right: 1000 } },
          { from: "b1", to: "be", default: true },
          { from: "b2", to: "be" },
        ],
      },
      outputs: [{ name: "checked", type: "array", description: "核对结果" }],
    },
    {
      id: "n2",
      type: "step",
      title: "汇总结果",
      executor: "deterministic",
      instructions: "汇总",
      action: { kind: "transform", template: "汇总：{{f.checked}}" },
    },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "f" },
    { from: "f", to: "n2" },
    { from: "n2", to: "e" },
  ],
  source: { painPointIds: [] },
};

function exportOk(source: WorkflowIR): N8nWorkflow {
  const graph = lower(source);
  expect(checkExport(n8nExporter, graph).filter((i) => i.level === "error")).toEqual([]);
  const [file] = n8nExporter.compile(graph, n8nExporter.defaultOptions) as Array<{ content: string }>;
  const wf = JSON.parse(file!.content) as N8nWorkflow;
  // 连线两端都必须是存在的节点
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [from, entry] of Object.entries(wf.connections)) {
    expect(names.has(from)).toBe(true);
    for (const slot of entry.main) for (const c of slot) expect(names.has(c.node)).toBe(true);
  }
  return wf;
}

const node = (wf: N8nWorkflow, name: string) => wf.nodes.find((n) => n.name === name)!;
const targets = (wf: N8nWorkflow, name: string, slot = 0) => wf.connections[name]?.main[slot]?.map((c) => `${c.node}#${c.index}`) ?? [];

describe("n8nExporter：foreach", () => {
  it("展开为 准备 → 有数据？ → 拆分 → Loop Over Items → 汇总，并经合并节点汇入下游", () => {
    const wf = exportOk(loopIr);
    expect(node(wf, "逐条核对（准备数据）").type).toBe("n8n-nodes-base.set");
    expect(node(wf, "逐条核对（有数据？）").type).toBe("n8n-nodes-base.if");
    expect(node(wf, "逐条核对（拆分）").type).toBe("n8n-nodes-base.splitOut");
    expect(node(wf, "逐条核对").type).toBe("n8n-nodes-base.splitInBatches");
    expect(node(wf, "逐条核对（汇总）").type).toBe("n8n-nodes-base.aggregate");
    expect(node(wf, "逐条核对（空结果）").type).toBe("n8n-nodes-base.set");
    expect(node(wf, "逐条核对（合并结果）").type).toBe("n8n-nodes-base.merge");

    expect(targets(wf, "拉取订单")).toEqual(["逐条核对（准备数据）#0"]);
    expect(targets(wf, "逐条核对（准备数据）")).toEqual(["逐条核对（有数据？）#0"]);
    // IF 的真分支（有数据）进入拆分，假分支（没有数据）进入空结果
    expect(targets(wf, "逐条核对（有数据？）", 0)).toEqual(["逐条核对（拆分）#0"]);
    expect(targets(wf, "逐条核对（有数据？）", 1)).toEqual(["逐条核对（空结果）#0"]);
    expect(targets(wf, "逐条核对（拆分）")).toEqual(["逐条核对#0"]);
    expect(targets(wf, "逐条核对", 0)).toEqual(["逐条核对（汇总）#0"]);
    expect(targets(wf, "逐条核对", 1)).toEqual(["是否大额#0"]);
    expect(targets(wf, "逐条核对（汇总）")).toEqual(["逐条核对（合并结果）#0"]);
    // 两条路径分别接合并节点的两个输入槽
    expect(targets(wf, "逐条核对（空结果）")).toEqual(["逐条核对（合并结果）#1"]);
    expect(targets(wf, "逐条核对（合并结果）")).toEqual(["汇总结果#0"]);
    // 循环体的 start 不生成节点
    expect(wf.nodes.some((n) => n.name === "本条开始")).toBe(false);
  });

  it("没有数据时的空结果输出空数组，字段名与循环输出一致", () => {
    const wf = exportOk(loopIr);
    const empty = JSON.stringify(node(wf, "逐条核对（空结果）").parameters);
    expect(empty).toContain(`"name":"checked","value":"={{ [] }}","type":"array"`);
    const gate = JSON.stringify(node(wf, "逐条核对（有数据？）").parameters);
    expect(gate).toContain(`"leftValue":"={{ $json.__items }}"`);
    expect(gate).toContain(`"operation":"notEmpty"`);
  });

  it("循环体内的条件分支照常映射，结束节点接回循环节点", () => {
    const wf = exportOk(loopIr);
    expect(targets(wf, "是否大额", 0)).toEqual(["标记大额#0"]);
    expect(targets(wf, "是否大额", 1)).toEqual(["本条结束#0"]);
    expect(targets(wf, "标记大额")).toEqual(["本条结束#0"]);
    expect(targets(wf, "本条结束")).toEqual(["逐条核对#0"]);
  });

  it("数组、元素和循环输出的引用改写为 n8n 表达式", () => {
    const wf = exportOk(loopIr);
    const prepare = JSON.stringify(node(wf, "逐条核对（准备数据）").parameters);
    expect(prepare).toContain(`"name":"__items","value":"={{ ($('拉取订单').item.json.orders ?? []) }}","type":"array"`);
    expect(node(wf, "逐条核对（拆分）").parameters).toEqual({ fieldToSplitOut: "__items", include: "noOtherFields", options: { destinationFieldName: "order" } });
    expect(node(wf, "逐条核对").parameters).toEqual({ batchSize: 1, options: {} });
    expect(node(wf, "逐条核对（汇总）").parameters).toEqual({ aggregate: "aggregateAllItemData", destinationFieldName: "checked" });

    expect(JSON.stringify(node(wf, "是否大额").parameters)).toContain("={{ $('逐条核对').item.json.order.amount }}");
    expect(JSON.stringify(node(wf, "标记大额").parameters)).toContain("=大额：{{ $('逐条核对').item.json.order.id }}");
    // 循环的输出可能为空，所以引用前先判断汇总节点是否执行过
    // 合并节点每次都会执行，下游直接取它的第一条数据
    expect(JSON.stringify(node(wf, "汇总结果").parameters)).toContain("=汇总：{{ $('逐条核对（合并结果）').first().json.checked }}");
  });

  it("循环体放在循环节点下方，后续节点右移，画布上不重叠", () => {
    const wf = exportOk(loopIr);
    const pos = (name: string) => node(wf, name).position;
    expect(pos("是否大额")[1]).toBeGreaterThan(pos("逐条核对")[1]);
    expect(pos("逐条核对（汇总）")[0]).toBeGreaterThan(pos("本条结束")[0]);
    expect(pos("逐条核对（合并结果）")[0]).toBeGreaterThan(pos("逐条核对（汇总）")[0]);
    expect(pos("汇总结果")[0]).toBeGreaterThan(pos("逐条核对（合并结果）")[0]);
    const keys = wf.nodes.filter((n) => !n.type.includes("stickyNote")).map((n) => n.position.join(","));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("嵌套循环：内层循环在外层循环体中展开，由拆分节点进入时重置", () => {
    const outer = loopIr.nodes.find((n) => n.id === "f") as Extract<WorkflowIR["nodes"][number], { type: "foreach" }>;
    const nested: WorkflowIR = {
      ...loopIr,
      nodes: loopIr.nodes.map((n) =>
        n.id !== "f"
          ? n
          : {
              ...outer,
              body: {
                nodes: [
                  { id: "bs", type: "start", title: "本条开始" },
                  {
                    id: "g",
                    type: "foreach",
                    title: "逐行处理",
                    over: "order.lines",
                    item: "line",
                    body: {
                      nodes: [
                        { id: "cs", type: "start", title: "本行开始" },
                        {
                          id: "c1",
                          type: "step",
                          title: "记录商品",
                          executor: "deterministic",
                          instructions: "记录商品",
                          action: { kind: "transform", template: "{{order.id}}/{{line.sku}}" },
                        },
                        { id: "ce", type: "end", title: "本行结束" },
                      ],
                      edges: [
                        { from: "cs", to: "c1" },
                        { from: "c1", to: "ce" },
                      ],
                    },
                  },
                  { id: "be", type: "end", title: "本条结束" },
                ],
                edges: [
                  { from: "bs", to: "g" },
                  { from: "g", to: "be" },
                ],
              },
            },
      ),
    };
    const wf = exportOk(nested);
    expect(targets(wf, "逐条核对", 1)).toEqual(["逐行处理（准备数据）#0"]);
    expect(targets(wf, "逐行处理", 1)).toEqual(["记录商品#0"]);
    expect(targets(wf, "本行结束")).toEqual(["逐行处理#0"]);
    expect(targets(wf, "逐行处理（合并结果）")).toEqual(["本条结束#0"]);
    expect(targets(wf, "本条结束")).toEqual(["逐条核对#0"]);

    expect(JSON.stringify(node(wf, "逐行处理（准备数据）").parameters)).toContain("={{ ($('逐条核对').item.json.order.lines ?? []) }}");
    expect(JSON.stringify(node(wf, "记录商品").parameters)).toContain("={{ $('逐条核对').item.json.order.id }}/{{ $('逐行处理').item.json.line.sku }}");
    expect(node(wf, "逐行处理").parameters).toEqual({ batchSize: 1, options: { reset: "={{ $prevNode.name === '逐行处理（拆分）' }}" } });
    expect(node(wf, "逐条核对").parameters).toEqual({ batchSize: 1, options: {} });
  });

  it("多个输出时给出警告，导出说明中写明汇总字段", () => {
    const multi: WorkflowIR = {
      ...loopIr,
      nodes: loopIr.nodes.map((n) =>
        n.type === "foreach" ? { ...n, outputs: [...(n.outputs ?? []), { name: "extra", type: "array" as const, description: "额外" }] } : n,
      ),
    };
    const graph = lower(multi);
    expect(checkExport(n8nExporter, graph).some((i) => i.level === "warning" && i.message.includes("只汇总到第一个输出「checked」"))).toBe(true);
    expect(n8nExporter.requirements(graph).some((r) => r.includes("「逐条核对（合并结果）」的 checked 字段"))).toBe(true);
  });
});

/** 分支专属节点的结果在合并之后被引用：只有走到那条分支时它才会执行 */
const branchIr: WorkflowIR = {
  version: 2,
  kind: "automation",
  slug: "branch-guard",
  name: "分支保护",
  description: "分支后合并。当用户需要验证分支时使用。",
  trigger: { type: "manual", detail: "手动" },
  inputs: [],
  integrations: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    {
      id: "n1",
      type: "step",
      title: "拉取",
      executor: "deterministic",
      instructions: "拉取",
      action: { kind: "http", method: "GET", url: "https://erp.example.com/orders" },
      outputs: [{ name: "orders", type: "array", description: "订单" }],
    },
    { id: "d", type: "decision", title: "有订单", mode: "expr" },
    { id: "n2", type: "step", title: "分支甲", executor: "deterministic", instructions: "甲", action: { kind: "transform", template: "有：{{n1.orders}}" } },
    { id: "n3", type: "step", title: "分支乙", executor: "deterministic", instructions: "乙", action: { kind: "transform", template: "无" } },
    { id: "m", type: "merge", title: "汇合" },
    { id: "n4", type: "step", title: "合并结果", executor: "deterministic", instructions: "合并", action: { kind: "transform", template: "结果：{{n2.summary}}" } },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "d" },
    { from: "d", to: "n2", condition: { left: "n1.count", op: "gt", right: 0 } },
    { from: "d", to: "n3", default: true },
    { from: "n2", to: "m" },
    { from: "n3", to: "m" },
    { from: "m", to: "n4" },
    { from: "n4", to: "e" },
  ],
  source: { painPointIds: [] },
};

describe("n8nExporter：引用保护", () => {
  it("支配节点的引用直接取值，只在某一分支上运行的节点加 isExecuted 判断", () => {
    const wf = exportOk(branchIr);
    expect(JSON.stringify(node(wf, "分支甲").parameters)).toContain("=有：{{ $('拉取').item.json.orders }}");
    expect(JSON.stringify(node(wf, "合并结果").parameters)).toContain("=结果：{{ ($('分支甲').isExecuted ? $('分支甲').item.json.summary : '') }}");
  });

  it("IF 的左值引用未必执行过的节点时同样加保护", () => {
    const cond: WorkflowIR = {
      ...branchIr,
      nodes: branchIr.nodes.map((n) =>
        n.id === "n4" ? { ...n, action: { kind: "transform", template: "{{n2.summary}}" } } : n,
      ),
      edges: branchIr.edges.map((e) => (e.from === "m" ? e : e)),
    };
    const wf = exportOk(cond);
    expect(JSON.stringify(node(wf, "合并结果").parameters)).toContain("$('分支甲').isExecuted");
  });
});

describe("n8nExporter：自然语言的数据整理", () => {
  it("字段拼接的模板仍映射为 Set，句子式的指令改为占位节点", () => {
    const prose: WorkflowIR = {
      ...branchIr,
      nodes: branchIr.nodes.map((n) =>
        n.id === "n3"
          ? { ...n, action: { kind: "transform", template: "对 {{n1.orders}} 逐行判断金额异常，保留异常类型标签，输出异常订单列表。" } }
          : n,
      ),
    };
    const wf = exportOk(prose);
    expect(node(wf, "分支乙").type).toBe("n8n-nodes-base.noOp");
    expect(node(wf, "分支甲").type).toBe("n8n-nodes-base.set");
    expect(wf.nodes.some((n) => n.type === "n8n-nodes-base.stickyNote" && String(n.parameters.content).includes("逐行判断金额异常"))).toBe(true);

    const graph = lower(prose);
    expect(checkExport(n8nExporter, graph).some((i) => i.level === "warning" && i.message.includes("「数据整理」导出后会有损失"))).toBe(true);
    expect(n8nExporter.requirements(graph).some((r) => r.includes("分支乙") && r.includes("占位节点"))).toBe(true);
  });
});

/** 查询 ERP 订单：listOrders 有 api 写法，unknownOp 没有 */
const erpIr: WorkflowIR = {
  version: 2,
  kind: "automation",
  slug: "erp-orders",
  name: "拉取ERP订单",
  description: "拉取当日订单。当用户需要拉取订单时使用。",
  trigger: { type: "manual", detail: "手动" },
  inputs: [{ name: "export_date", type: "string", required: true, description: "导出日期" }],
  integrations: [{ id: "erp", name: "ERP订单", access: "api", purpose: "查询订单" }],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    {
      id: "n1",
      type: "step",
      title: "查询当日订单",
      executor: "deterministic",
      integration: "erp",
      instructions: "调用ERP查询订单",
      action: {
        kind: "integration",
        integration: "erp",
        operation: "listOrders",
        params: { start: "{{input.export_date}}", end: "{{input.export_date}}" },
      },
      outputs: [{ name: "orders", type: "array", description: "订单" }],
    },
    {
      id: "n2",
      type: "step",
      title: "未知操作",
      executor: "deterministic",
      integration: "erp",
      instructions: "没有 api 写法的操作",
      action: { kind: "integration", integration: "erp", operation: "unknownOp", params: {} },
    },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "e" },
  ],
  source: { painPointIds: [] },
};

describe("n8nExporter：ERP 集成", () => {
  it("有 api 写法的集成操作映射为 HTTP Request，查询参数来自输入，鉴权使用 Header Auth 凭证", () => {
    const wf = exportOk(erpIr);
    const http = node(wf, "查询当日订单");
    expect(http.type).toBe("n8n-nodes-base.httpRequest");
    expect(http.parameters.method).toBe("GET");
    expect(http.parameters.url).toBe("={{ $env.ERP_BASE_URL }}<订单接口路径，待对接时确认>");
    expect(http.parameters.sendQuery).toBe(true);
    expect(http.parameters.queryParameters).toEqual({
      parameters: [
        { name: "start", value: "={{ $('触发器（手动触发）').item.json.export_date }}" },
        { name: "end", value: "={{ $('触发器（手动触发）').item.json.export_date }}" },
      ],
    });
    expect(http.credentials).toEqual({ httpHeaderAuth: { name: "ERP 订单" } });
  });

  it("接口路径未确认时附便签，说明需要替换的路径和凭证的配置方法", () => {
    const wf = exportOk(erpIr);
    const note = wf.nodes.find((n) => n.type === "n8n-nodes-base.stickyNote" && String(n.parameters.content).includes("查询当日订单"));
    expect(note).toBeDefined();
    expect(String(note!.parameters.content)).toContain("接口路径尚未确认");
    expect(String(note!.parameters.content)).toContain("Authorization");
  });

  it("没有 api 写法的集成操作保持占位", () => {
    const wf = exportOk(erpIr);
    expect(node(wf, "未知操作").type).toBe("n8n-nodes-base.noOp");
  });

  it("需求清单写明环境变量、基地址和未确认的接口路径", () => {
    const reqs = n8nExporter.requirements(lower(erpIr));
    expect(reqs.some((r) => r.includes("N8N_BLOCK_ENV_ACCESS_IN_NODE"))).toBe(true);
    expect(reqs.some((r) => r.includes("接口路径尚未确认"))).toBe(true);
  });
});
