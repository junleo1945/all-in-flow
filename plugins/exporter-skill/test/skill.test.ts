import { describe, expect, it } from "vitest";
import { FEATURE_LABELS, lower, migrateIr, validateWorkflow, type WorkflowIR, type WorkflowIRv1 } from "@aif/workflow-ir";
import { skillExporter, renderSkillMd, orderSteps } from "../src/index.js";

const salesReportV1: WorkflowIRv1 = {
  version: 1,
  kind: "automation",
  slug: "weekly-sales-report",
  name: "销售周报自动汇总",
  description: "每周汇总 ERP 订单数据并生成销售周报。当用户需要写周报时使用。",
  trigger: { type: "schedule", detail: "每周五 17:00", cron: "0 17 * * 5" },
  inputs: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    { id: "n1", type: "step", title: "拉取本周订单", executor: "deterministic", instructions: "调用 ERP 订单接口" },
    { id: "n2", type: "decision", title: "有异常订单？" },
    { id: "n3", type: "step", title: "人工核对异常", executor: "human", instructions: "列出异常订单，请用户确认" },
    { id: "n4", type: "step", title: "生成周报", executor: "llm", instructions: "按模板汇总" },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3", label: "有" },
    { from: "n2", to: "n4", label: "没有" },
    { from: "n3", to: "n4" },
    { from: "n4", to: "e" },
  ],
  source: { painPointIds: ["p1"] },
};

// 导出器只接受 v2：v1 数据在进入导出前迁移
const salesReport: WorkflowIR = migrateIr(salesReportV1);

describe("Agent Skill 导出", () => {
  it("输出 SKILL.md、references 和安装说明", () => {
    const files = skillExporter.compile(lower(salesReport), { target: "generic" });
    expect(files.map((f) => f.path)).toEqual([
      "weekly-sales-report/SKILL.md",
      "weekly-sales-report/references/workflow.mmd",
      "weekly-sales-report/references/workflow.json",
      "weekly-sales-report/INSTALL.md",
    ]);
    const json = JSON.parse(files[2]!.content);
    expect(json.slug).toBe("weekly-sales-report");
  });

  it("frontmatter 符合 Agent Skills 规范：name 与目录名一致，description 有值且不超长", () => {
    const md = renderSkillMd(salesReport);
    const fm = md.split("---")[1]!;
    expect(fm).toMatch(/^name: weekly-sales-report$/m);
    const desc = /^description: (.*)$/m.exec(fm)![1]!;
    expect(JSON.parse(desc)).toContain("每周汇总");
    expect(desc.length).toBeLessThan(1024);
    expect(fm).toMatch(/generated-by: all-in-flow/);
  });

  it("步骤按遍历顺序编号，决策分支写明目标步骤", () => {
    const md = renderSkillMd(salesReport);
    expect(md).toMatch(/1\. \*\*拉取本周订单\*\*〔脚本〕/);
    expect(md).toMatch(/2\. \*\*判断：有异常订单？\*\*/);
    expect(md).toMatch(/- 有 → 第 3 步/);
    expect(md).toMatch(/- 没有 → 第 4 步/);
    expect(md).toMatch(/3\. \*\*人工核对异常\*\*〔需要确认〕.*等用户回复后再继续/);
    expect(md).toMatch(/4\. \*\*生成周报\*\*〔AI〕.*至此流程结束。/);
  });

  it("每个步骤只出现一次（分支汇合点不重复编号）", () => {
    const { order } = orderSteps(salesReport);
    expect(order.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("没有脚本时不写 compatibility，也没有前置条件一节", () => {
    const md = renderSkillMd(salesReport);
    expect(md).not.toContain("compatibility:");
    expect(md).not.toContain("## 前置条件");
  });

  it("只导出 Skill 本身的文件，不生成连接说明、环境变量清单或 MCP 模板", () => {
    const paths = skillExporter.compile(lower(salesReport), { target: "generic" }).map((f) => f.path);
    for (const name of ["CONNECTIONS.md", ".env.example", "mcp.json.template"]) expect(paths.some((p) => p.endsWith(name))).toBe(false);
  });

  it("supports：非 automation 给出错误", () => {
    const process = { ...structuredClone(salesReport), kind: "process" as const };
    expect(skillExporter.supports(lower(process)).some((i) => i.level === "error")).toBe(true);
    expect(skillExporter.supports(lower(salesReport)).filter((i) => i.level === "error")).toEqual([]);
  });

  it("导出的示例 IR 本身通过校验", () => {
    expect(validateWorkflow(salesReport).ok).toBe(true);
  });

  it("循环：回边写成引用已有步骤编号，不无限展开", () => {
    const loop = structuredClone(salesReport);
    loop.edges.push({ from: "n4", to: "n2" }); // 生成后回到判断
    const md = renderSkillMd(loop);
    expect(md.match(/判断：有异常订单/g)!.length).toBe(1);
  });
});

describe("导出能力声明", () => {
  it("每一种能力都有明确的 full / degraded 声明，新增能力时必须同步声明", () => {
    for (const f of Object.keys(FEATURE_LABELS)) {
      expect(skillExporter.capabilities[f as keyof typeof FEATURE_LABELS], f).toBeDefined();
    }
  });
});

describe("并行分支的编号", () => {
  // 两条分支长度不同：x1→x2→x3 与 y1，汇合后出报告
  const parallel = (): WorkflowIR => ({
    version: 2,
    kind: "automation",
    slug: "parallel-check",
    name: "并行检查",
    description: "并行拉取数据后汇总。当用户需要并行汇总数据时使用。",
    trigger: { type: "manual", detail: "手动" },
    inputs: [],
    nodes: [
      { id: "s", type: "start", title: "开始" },
      { id: "x1", type: "step", title: "拉取订单", executor: "deterministic", instructions: "拉取订单" },
      { id: "x2", type: "step", title: "清洗订单", executor: "deterministic", instructions: "清洗订单字段" },
      { id: "x3", type: "step", title: "统计订单", executor: "llm", instructions: "统计订单金额" },
      { id: "y1", type: "step", title: "拉取库存", executor: "deterministic", instructions: "拉取库存快照" },
      { id: "m", type: "merge", title: "汇合" },
      { id: "z", type: "step", title: "出报告", executor: "llm", instructions: "合并订单与库存出报告" },
      { id: "e", type: "end", title: "结束" },
    ],
    edges: [
      { from: "s", to: "x1" },
      { from: "s", to: "y1" },
      { from: "x1", to: "x2" },
      { from: "x2", to: "x3" },
      { from: "x3", to: "m" },
      { from: "y1", to: "m" },
      { from: "m", to: "z" },
      { from: "z", to: "e" },
    ],
    source: { painPointIds: [] },
  });

  it("每条分支的步骤连续编号，汇合点排在所有分支之后", () => {
    const { order } = orderSteps(parallel());
    expect(order.map((n) => n.title)).toEqual(["拉取订单", "清洗订单", "统计订单", "拉取库存", "汇合", "出报告"]);
  });

  it("同时进行的步骤互相标注编号区间", () => {
    const md = renderSkillMd(parallel());
    expect(md).toContain("1. **拉取订单**〔脚本〕 拉取订单。与第 4 步同时进行。完成后进入第 2 步。");
    expect(md).toContain("4. **拉取库存**〔脚本〕 拉取库存快照。与第 1 至 3 步同时进行。完成后进入第 5 步。");
    expect(md).toContain("5. **汇合** 等待前面的并行分支全部完成。完成后进入第 6 步。");
  });
});

describe("嵌套并行", () => {
  // 外层：a1 与 c1 并行；a1 内部再并行 b1、b2，汇合后做 a2；外层最后汇合再出报告
  const nested = (): WorkflowIR => ({
    version: 2,
    kind: "automation",
    slug: "nested-parallel",
    name: "嵌套并行",
    description: "嵌套并行处理数据。当用户需要嵌套并行汇总时使用。",
    trigger: { type: "manual", detail: "手动" },
    inputs: [],
    nodes: [
      { id: "s", type: "start", title: "开始" },
      { id: "a1", type: "step", title: "准备分区", executor: "deterministic", instructions: "切分数据分区" },
      { id: "b1", type: "step", title: "处理分区一", executor: "deterministic", instructions: "处理第一个分区" },
      { id: "b2", type: "step", title: "处理分区二", executor: "deterministic", instructions: "处理第二个分区" },
      { id: "mB", type: "merge", title: "汇合分区" },
      { id: "a2", type: "step", title: "合并分区结果", executor: "llm", instructions: "合并两个分区的结果" },
      { id: "c1", type: "step", title: "拉取基准", executor: "deterministic", instructions: "拉取基准数据" },
      { id: "mA", type: "merge", title: "汇合全部" },
      { id: "f", type: "step", title: "出报告", executor: "llm", instructions: "对比基准出报告" },
      { id: "e", type: "end", title: "结束" },
    ],
    edges: [
      { from: "s", to: "a1" },
      { from: "s", to: "c1" },
      { from: "a1", to: "b1" },
      { from: "a1", to: "b2" },
      { from: "b1", to: "mB" },
      { from: "b2", to: "mB" },
      { from: "mB", to: "a2" },
      { from: "a2", to: "mA" },
      { from: "c1", to: "mA" },
      { from: "mA", to: "f" },
      { from: "f", to: "e" },
    ],
    source: { painPointIds: [] },
  });

  it("编号：内层分支先走完再回到外层，汇合点在上游全部完成后才编号", () => {
    const { order } = orderSteps(nested());
    expect(order.map((n) => n.title)).toEqual(["准备分区", "处理分区一", "处理分区二", "汇合分区", "合并分区结果", "拉取基准", "汇合全部", "出报告"]);
  });

  it("标注：内层与外层的并行关系都能看出来，扇出处写明同时进入哪些步骤", () => {
    const md = renderSkillMd(nested());
    // 准备分区 是外层分支，与拉取基准同时进行；它之后同时进入内层两步
    expect(md).toContain("1. **准备分区**〔脚本〕 切分数据分区。与第 6 步同时进行。完成后同时进入第 2 至 3 步。");
    // 两个分区互相并行，只和彼此标注
    expect(md).toContain("2. **处理分区一**〔脚本〕 处理第一个分区。与第 3 步同时进行。完成后进入第 4 步。");
    expect(md).toContain("3. **处理分区二**〔脚本〕 处理第二个分区。与第 2 步同时进行。完成后进入第 4 步。");
    // 拉取基准 与外层的整条分支并行
    expect(md).toContain("6. **拉取基准**〔脚本〕 拉取基准数据。与第 1 至 3、5 步同时进行。完成后进入第 7 步。");
    expect(md).toContain("4. **汇合分区** 等待前面的并行分支全部完成。完成后进入第 5 步。");
    // 内层汇合之后的 合并分区结果 仍属于外层分支，应与 拉取基准 同时进行
    expect(md).toContain("5. **合并分区结果**〔AI〕 合并两个分区的结果。与第 6 步同时进行。完成后进入第 7 步。");
  });
});

describe("并行分支中含判断节点", () => {
  // 分支 A：读取订单 → 判断金额 → 人工复核 / 自动入账（互斥）→ 汇合；分支 B：拉取库存 → 汇合
  const withDecision = (): WorkflowIR => ({
    version: 2,
    kind: "automation",
    slug: "parallel-decision",
    name: "并行与判断",
    description: "并行读取订单和库存，超标订单需复核。当用户需要核对订单与库存时使用。",
    trigger: { type: "manual", detail: "手动" },
    inputs: [],
    nodes: [
      { id: "s", type: "start", title: "开始" },
      { id: "a1", type: "step", title: "读取订单", executor: "deterministic", instructions: "读取本周订单", outputs: [{ name: "orders", type: "array", description: "订单" }] },
      { id: "d", type: "decision", title: "金额超标？", mode: "expr" },
      { id: "a2", type: "step", title: "人工复核", executor: "human", instructions: "请财务复核超标订单" },
      { id: "a3", type: "step", title: "自动入账", executor: "deterministic", instructions: "把订单写入账目" },
      { id: "b1", type: "step", title: "拉取库存", executor: "deterministic", instructions: "拉取库存快照", outputs: [{ name: "stock", type: "array", description: "库存" }] },
      { id: "m", type: "merge", title: "汇合" },
      { id: "f", type: "step", title: "出报告", executor: "llm", instructions: "汇总账目与库存出报告" },
      { id: "e", type: "end", title: "结束" },
    ],
    edges: [
      { from: "s", to: "a1" },
      { from: "s", to: "b1" },
      { from: "a1", to: "d" },
      { from: "d", to: "a2", label: "超标", condition: { left: "a1.orders", op: "not_empty" } },
      { from: "d", to: "a3", label: "正常", default: true },
      { from: "a2", to: "m" },
      { from: "a3", to: "m" },
      { from: "b1", to: "m" },
      { from: "m", to: "f" },
      { from: "f", to: "e" },
    ],
    source: { painPointIds: [] },
  });

  it("编号：分支 A 的判断与两条互斥步骤连续编号，分支 B 排在其后", () => {
    const { order } = orderSteps(withDecision());
    expect(order.map((n) => n.title)).toEqual(["读取订单", "金额超标？", "人工复核", "自动入账", "拉取库存", "汇合", "出报告"]);
  });

  it("标注：判断节点标注并行关系；另一分支的标注说明其中步骤只执行其一", () => {
    const md = renderSkillMd(withDecision());
    expect(md).toContain("1. **读取订单**〔脚本〕 读取本周订单。输出：`orders`（array，订单）。与第 5 步同时进行。完成后进入第 2 步。");
    expect(md).toContain("2. **判断：金额超标？** 与第 5 步同时进行。");
    expect(md).toContain("3. **人工复核**〔需要确认〕 请财务复核超标订单。与第 5 步同时进行。");
    expect(md).toContain("5. **拉取库存**〔脚本〕 拉取库存快照。输出：`stock`（array，库存）。与第 1 至 4 步同时进行（判断后的分支只执行其一）。完成后进入第 6 步。");
  });
});

describe("循环穿过并行区域", () => {
  // 拉取订单 → 并行：[清洗订单 → 统计订单] 与 [拉取库存] → 汇合 → 对账平衡？ 不平衡则回到拉取订单
  const loopOverParallel = (): WorkflowIR => ({
    version: 2,
    kind: "automation",
    slug: "reconcile-loop",
    name: "对账循环",
    description: "并行拉取订单与库存并对账，不平衡时重新拉取。当用户需要反复对账直到平衡时使用。",
    trigger: { type: "manual", detail: "手动" },
    inputs: [],
    nodes: [
      { id: "s", type: "start", title: "开始" },
      { id: "a1", type: "step", title: "拉取订单", executor: "deterministic", instructions: "拉取本周订单", outputs: [{ name: "orders", type: "array", description: "订单" }] },
      { id: "b1", type: "step", title: "清洗订单", executor: "deterministic", instructions: "清洗订单字段" },
      { id: "b2", type: "step", title: "统计订单", executor: "llm", instructions: "统计订单金额" },
      { id: "c1", type: "step", title: "拉取库存", executor: "deterministic", instructions: "拉取库存快照", outputs: [{ name: "stock", type: "array", description: "库存" }] },
      { id: "m", type: "merge", title: "汇合" },
      { id: "d", type: "decision", title: "对账平衡？", mode: "llm", question: "订单金额与库存数量是否对得上" },
      { id: "r", type: "step", title: "出报告", executor: "llm", instructions: "出对账报告" },
      { id: "e", type: "end", title: "结束" },
    ],
    edges: [
      { from: "s", to: "a1" },
      { from: "a1", to: "b1" },
      { from: "a1", to: "c1" },
      { from: "b1", to: "b2" },
      { from: "b2", to: "m" },
      { from: "c1", to: "m" },
      { from: "m", to: "d" },
      { from: "d", to: "a1", label: "不平衡", condition: { left: "d.balanced", op: "is_false" } },
      { from: "d", to: "r", label: "平衡", default: true },
      { from: "r", to: "e" },
    ],
    source: { painPointIds: [] },
  });

  it("编号：并行分支各自连续，汇合后判断，回边不改变编号", () => {
    const { order } = orderSteps(loopOverParallel());
    expect(order.map((n) => n.title)).toEqual(["拉取订单", "清洗订单", "统计订单", "拉取库存", "汇合", "对账平衡？", "出报告"]);
  });

  it("标注：回边写成回到第 1 步，并行关系不因循环而错乱", () => {
    const md = renderSkillMd(loopOverParallel());
    // 循环起点标注循环体范围；循环体内其他步骤不重复标注
    expect(md).toContain("1. **拉取订单**〔脚本〕 拉取本周订单。输出：`orders`（array，订单）。循环起点：循环体为第 1 至 6 步。完成后同时进入第 2、4 步。");
    expect(md.match(/循环起点/g)!.length).toBe(1);
    // 循环终点：回边的来源判断节点标注循环在此结束
    expect(md).toContain("6. **判断：对账平衡？**（判断问题：订单金额与库存数量是否对得上） 循环终点：循环体在此结束。");
    expect(md.match(/循环终点/g)!.length).toBe(1);
    expect(md).toContain("2. **清洗订单**〔脚本〕 清洗订单字段。与第 4 步同时进行。完成后进入第 3 步。");
    expect(md).toContain("3. **统计订单**〔AI〕 统计订单金额。与第 4 步同时进行。完成后进入第 5 步。");
    expect(md).toContain("4. **拉取库存**〔脚本〕 拉取库存快照。输出：`stock`（array，库存）。与第 2 至 3 步同时进行。完成后进入第 5 步。");
    expect(md).toContain("   - 不平衡（条件：`d.balanced` 为假） → 回到第 1 步");
    expect(md).toContain("   - 平衡（其他情况） → 第 7 步");
  });
});

describe("循环体范围：不包含同一编号区间内、但不在循环里的步骤", () => {
  // 拉取订单 → 汇合（与并行的拉取库存在汇合前完成）→ 对账 → 不平衡则只回到拉取订单，拉取库存不重复执行
  const partialLoop = (): WorkflowIR => ({
    version: 2,
    kind: "automation",
    slug: "partial-loop",
    name: "局部循环",
    description: "拉取订单并与库存汇合对账，不平衡时重新拉取订单。当用户需要反复对账时使用。",
    trigger: { type: "manual", detail: "手动" },
    inputs: [],
    nodes: [
      { id: "s", type: "start", title: "开始" },
      { id: "x1", type: "step", title: "拉取订单", executor: "deterministic", instructions: "拉取本周订单" },
      { id: "x2", type: "step", title: "清洗订单", executor: "deterministic", instructions: "清洗订单字段" },
      { id: "c1", type: "step", title: "拉取库存", executor: "deterministic", instructions: "拉取库存快照" },
      { id: "m", type: "merge", title: "汇合" },
      { id: "d", type: "decision", title: "对账平衡？", mode: "llm", question: "订单与库存是否对得上" },
      { id: "r", type: "step", title: "出报告", executor: "llm", instructions: "出对账报告" },
      { id: "e", type: "end", title: "结束" },
    ],
    edges: [
      { from: "s", to: "x1" },
      { from: "x1", to: "x2" },
      { from: "x2", to: "m" },
      { from: "s", to: "c1" },
      { from: "c1", to: "m" },
      { from: "m", to: "d" },
      { from: "d", to: "x1", label: "不平衡", condition: { left: "d.balanced", op: "is_false" } },
      { from: "d", to: "r", label: "平衡", default: true },
      { from: "r", to: "e" },
    ],
    source: { painPointIds: [] },
  });

  it("循环体只包含从循环起点能到达、并能回到回边来源的步骤", () => {
    const md = renderSkillMd(partialLoop());
    // 编号：1 拉取订单，2 清洗订单，3 拉取库存，4 汇合，5 对账，6 出报告
    expect(md).toContain("循环起点：循环体为第 1 至 2、4 至 5 步");
    expect(md).not.toContain("循环体为第 1 至 5 步");
  });
});
