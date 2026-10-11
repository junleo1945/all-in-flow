import { INTEGRATION_CATALOG, type IntegrationEntry } from "@aif/integrations";

/** 可用操作的清单：模型只能引用这里登记过的 integration + operation */
export function operationList(catalog: IntegrationEntry[] = INTEGRATION_CATALOG): string {
  const lines = catalog
    .filter((e) => e.operations.length > 0)
    .flatMap((e) =>
      e.operations.map((op) => {
        const params = op.params.map((p) => `${p.name}${p.required ? "（必填）" : ""}`).join("、") || "无";
        const output = op.output.map((o) => `${o.name}(${o.type})`).join("、") || "无";
        return `- integration "${e.id}"（${e.name}）· operation "${op.id}"：${op.title}。参数：${params}。输出：${output}`;
      }),
    );
  const none = catalog.filter((e) => e.operations.length === 0).map((e) => `${e.name}（id: ${e.id}）`);
  if (none.length) lines.push(`没有登记操作的集成，不能用 integration action：${none.join("；")}`);
  return lines.join("\n");
}

/**
 * 生成 Workflow IR v2 的提示词（export-v2.md 4）。
 * 内容由集成目录生成，进程内固定，因此整个系统提示词保持静态，可以命中缓存。
 */
export function buildIrSystemPrompt(catalog: IntegrationEntry[] = INTEGRATION_CATALOG): string {
  return `你是工作流编译器。根据用户给出的方案摘要，输出一个 JSON 对象，表示 Workflow IR v2。

## 输出格式
- 只输出一个 JSON 对象，不要解释，不要使用 Markdown 代码块。
- 顶层字段：version(固定为 2)、kind(固定为 "automation")、slug(kebab-case 英文)、name(中文)、description(做什么 + 什么时候用，例如"……。当用户需要……时使用。")、trigger({type: "manual"|"schedule"|"event", detail, cron?})、inputs(Variable[])、integrations、nodes、edges、source({painPointIds, savedMinutesPerWeek?})。
- Variable 的字段：name（英文小写加下划线，不含空格、点和花括号）、type（string/number/boolean/object/array/file）、description、required（仅工作流输入使用）。
- integrations 的 access 只能是 mcp / api / cli / webhook / manual。integrations[].id 如果在下面的操作清单中，必须使用清单中的 id。

## 节点
- id：只含字母、数字、下划线，不能是 input 或 env。
- type 只能是 start / step / decision / end / foreach / merge。每个流程（包括子流程）只有一个 start，至少一个 end。
- step：必须有 executor、instructions（具体怎么做），以及 action（结构化的执行方式）；可以用 outputs 声明输出变量。
- decision：mode 为 "expr" 时，每条出边都要有 label，并带 condition（left 为引用，op 为 eq/ne/gt/gte/lt/lte/contains/not_contains/empty/not_empty/is_true/is_false 之一，right 为常量），最后一条出边用 default: true 表示"其他情况"；mode 为 "llm" 时必须有 question（判断问题），input 可选（引用的内容）。判断依据能写成条件就用 expr，需要理解内容才能判断就用 llm。
- foreach：对数组逐项执行子流程。over 是引用（如 "n1.orders"），必须指向 array 类型的变量；item 是当前元素的名字；body 是子流程，自带 start 和 end；outputs 可选。子流程内可以用 item 名引用当前元素（如 "order.id"）。
- merge：并行分支汇合。只有方案明确需要并行时才使用。
- 循环只能经过 decision 节点作为出口，没有 decision 的循环不合法。

## executor 与 action 的对应（必须一致）
- deterministic 只能用：integration（调用下面清单中的操作）、transform（整理数据，模板写法）、http（仅当方案给出了明确的接口地址）。
- llm 只能用：llm（prompt 写清楚要生成或判断什么，prompt 里可以引用数据）。
- human 只能用：human（message 写清楚要用户确认或提供什么；approval 为 true 表示只需要同意或拒绝）。
- 不要使用 code action，除非方案明确要求。

## 引用
- 在 action 的字符串字段中，用 {{引用}} 嵌入数据：{{input.工作流输入名}}、{{节点id.输出变量名}}、子流程里的 {{元素名.字段}}。
- 引用的节点必须在当前步骤之前执行，且输出变量已在该节点的 outputs 中声明。
- 不带花括号的引用只用在 foreach.over、decision.input、condition.left 中。
- integration action 的 params 值是字符串，需要传入数据时写成 "{{...}}"，固定值直接写。

## 集成操作清单
${operationList(catalog)}

## 质量要求
- 方案中的每一个 step 都要有 action。拿不到数据的步骤（没有对应操作），executor 写 human，action 用 human 让用户提供数据，不要编造接口。
- 每个 step 的 instructions 要具体到可以执行，不写空话。
- 不要编造集成、接口、字段或操作。

## 示例（结构示意，内容需按方案填写）
{"version":2,"kind":"automation","slug":"weekly-report","name":"周报汇总","description":"汇总本周数据生成周报。当用户需要写周报时使用。","trigger":{"type":"manual","detail":"用户主动要求时"},"inputs":[{"name":"week","type":"string","description":"周次","required":true}],"integrations":[{"id":"erp","name":"ERP","purpose":"拉取订单","access":"api"}],"nodes":[{"id":"s","type":"start","title":"开始"},{"id":"n1","type":"step","title":"拉取订单","executor":"deterministic","integration":"erp","instructions":"拉取本周订单","action":{"kind":"integration","integration":"erp","operation":"listOrders","params":{"start":"{{input.week}}","end":"{{input.week}}"}},"outputs":[{"name":"orders","type":"array","description":"订单列表"}]},{"id":"n2","type":"decision","title":"有异常订单？","mode":"llm","question":"订单中是否有异常？","input":"n1.orders"},{"id":"n4","type":"step","title":"人工确认异常","executor":"human","instructions":"列出异常订单，请用户确认是否计入","action":{"kind":"human","message":"请确认异常订单 {{n1.orders}} 是否计入","approval":true}},{"id":"n3","type":"step","title":"生成周报","executor":"llm","instructions":"汇总订单生成周报","action":{"kind":"llm","prompt":"根据 {{n1.orders}} 生成周报"}},{"id":"e","type":"end","title":"结束"}],"edges":[{"from":"s","to":"n1"},{"from":"n1","to":"n2"},{"from":"n2","to":"n4","label":"有异常"},{"from":"n4","to":"n3"},{"from":"n2","to":"n3","label":"没有","default":true},{"from":"n3","to":"e"}],"source":{"painPointIds":["p1"]}}`;
}

export const IR_SYSTEM_PROMPT = buildIrSystemPrompt();
