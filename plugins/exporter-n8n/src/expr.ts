import type { Condition, ConditionOp } from "@aif/workflow-ir";
import { stableId } from "./ids.js";

export interface ExprCtx {
  /** 节点 id → n8n 节点名（工作流中唯一） */
  names: Map<string, string>;
  /** 触发器节点名，工作流输入（input.x）从它取值 */
  triggerName: string;
  /** foreach 子流程中的元素名 → 所在循环节点名；元素放在循环数据的同名字段下 */
  items?: Map<string, string>;
  /** foreach 节点 id → 合并节点名；foreach 的输出从合并节点取值 */
  outputs?: Map<string, string>;
  /** 本节点执行前一定已经运行过的节点 id（支配节点）；不在其中的引用需要判断是否已执行 */
  guaranteed?: Set<string>;
}

const HAS_REF = /\{\{[^{}]*\}\}/;
const REF = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * 把 IR 模板中的引用改写成 n8n 表达式（export-v2.md 8.3）：
 * `{{n1.orders}}` → `={{ $('拉取订单').item.json.orders }}`。
 * 没有引用的文本原样返回；有引用时整个值以 = 开头。
 */
export function toN8nValue(template: string, ctx: ExprCtx): string {
  if (!HAS_REF.test(template)) return template;
  const body = template.replace(REF, (_, raw: string) => `{{ ${toExpr(raw, ctx)} }}`);
  return `=${body}`;
}

/** 数据源为数组的引用：缺失或未执行时取空数组，保证拆分得到零条数据（而不是一条空数据） */
export function toArrayValue(ref: string, ctx: ExprCtx): string {
  return `={{ (${toExpr(ref, ctx, "[]")} ?? []) }}`;
}

/** fallback 是上游未执行时的取值：字符串场景取空串，数组场景取空数组 */
function toExpr(raw: string, ctx: ExprCtx, fallback = "''"): string {
  const [head, ...rest] = raw.split(".");
  const suffix = rest.length ? `.${rest.join(".")}` : "";
  if (head === "env") return `$env${suffix}`;
  if (head === "input") return `$('${quote(ctx.triggerName)}').item.json${suffix}`;
  // 与 lower() 的解析顺序一致：元素名优先于节点 id
  const loop = head ? ctx.items?.get(head) : undefined;
  if (loop !== undefined) return `$('${quote(loop)}').item.json.${head}${suffix}`;
  // foreach 的输出从合并节点取：合并节点每次都会执行，取它的第一条数据
  const output = head ? ctx.outputs?.get(head) : undefined;
  if (output !== undefined) {
    const value = `$('${quote(output)}').first().json${suffix}`;
    return ctx.guaranteed?.has(head!) ? value : `($('${quote(output)}').isExecuted ? ${value} : ${fallback})`;
  }
  const name = head ? ctx.names.get(head) : undefined;
  if (name !== undefined) {
    const value = `$('${quote(name)}').item.json${suffix}`;
    // 上游节点可能没有在本次执行中运行（例如位于未走到的分支上），这时 n8n 会报 hasn't been executed，所以先判断
    return ctx.guaranteed?.has(head!) ? value : `($('${quote(name)}').isExecuted ? ${value} : ${fallback})`;
  }
  // 无法识别的引用原样保留，导入后由用户修正
  return raw;
}

/** 转义 $('节点名') 中的节点名 */
export function quote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ———————————————— 条件（IF 节点） ————————————————

export interface IfCondition {
  id: string;
  leftValue: string;
  rightValue?: string | number | boolean;
  operator: { type: string; operation: string; singleValue?: boolean };
}

export interface IfConditions {
  combinator: "and" | "or";
  conditions: IfCondition[];
}

/**
 * 把 IR 的条件转成 n8n IF 节点（v2）的过滤器。
 * 只支持一层：单个条件，或一组 all / any 的平铺条件；嵌套组会抛错，由 supports() 报出。
 */
export function toIfConditions(cond: Condition, ctx: ExprCtx, seed: string): IfConditions {
  if ("all" in cond || "any" in cond) {
    const combinator = "all" in cond ? "and" : "or";
    const children = "all" in cond ? cond.all : cond.any;
    return {
      combinator,
      conditions: children.map((child, i) => {
        if (!("left" in child)) throw new Error("条件组不支持嵌套，请改为一层 all / any");
        return leaf(child, ctx, `${seed}:${i}`);
      }),
    };
  }
  return { combinator: "and", conditions: [leaf(cond, ctx, `${seed}:0`)] };
}

function leaf(c: { left: string; op: ConditionOp; right?: string | number | boolean }, ctx: ExprCtx, seed: string): IfCondition {
  const base = { id: stableId(seed), leftValue: toN8nValue(`{{${c.left}}}`, ctx) };
  const right = typeof c.right === "string" ? toN8nValue(c.right, ctx) : c.right;
  const valueType = typeof c.right === "number" ? "number" : typeof c.right === "boolean" ? "boolean" : "string";
  switch (c.op) {
    case "eq":
      return { ...base, rightValue: right, operator: { type: valueType, operation: "equals" } };
    case "ne":
      return { ...base, rightValue: right, operator: { type: valueType, operation: "notEquals" } };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { ...base, rightValue: right, operator: { type: "number", operation: c.op } };
    case "contains":
      return { ...base, rightValue: right, operator: { type: "string", operation: "contains" } };
    case "not_contains":
      return { ...base, rightValue: right, operator: { type: "string", operation: "notContains" } };
    case "empty":
      return { ...base, operator: { type: "string", operation: "empty", singleValue: true } };
    case "not_empty":
      return { ...base, operator: { type: "string", operation: "notEmpty", singleValue: true } };
    case "is_true":
      return { ...base, operator: { type: "boolean", operation: "true", singleValue: true } };
    case "is_false":
      return { ...base, operator: { type: "boolean", operation: "false", singleValue: true } };
  }
}
