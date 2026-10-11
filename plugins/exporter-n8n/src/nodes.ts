import { findIntegration, findOperation } from "@aif/integrations";
import type { Action, Condition, WorkflowNode } from "@aif/workflow-ir";
import { quote, toArrayValue, toIfConditions, toN8nValue, type ExprCtx } from "./expr.js";
import { stableId } from "./ids.js";

/** 一个 IR 节点映射出的 n8n 节点（不含名字、位置、id，由 workflow.ts 补上） */
export interface MappedNode {
  type: string;
  typeVersion: number;
  parameters: Record<string, unknown>;
  /** 需要凭证的节点，导入后 n8n 会显示为待配置 */
  credentials?: Record<string, { id?: string; name: string }>;
  /** 附带一张便签提醒用户补全（没有自动映射的节点，或映射需要人工确认的节点） */
  placeholder?: { note: string };
}

type IntegrationAction = Extract<Action, { kind: "integration" }>;

/** 集成操作能否映射为 HTTP Request：集成目录中有 api 写法的才可以 */
export function canMapIntegration(action: IntegrationAction): boolean {
  return findOperation(action.integration, action.operation)?.api !== undefined;
}

/**
 * 集成的 api 写法映射为 HTTP Request（鉴权用 Header Auth 凭证，基地址来自环境变量）。
 * 接口路径在目录中尚未确认，URL 中保留 <…> 占位，没替换就会请求失败，不会静默调错接口。
 */
function integrationHttp(title: string, instructions: string, action: IntegrationAction, ctx: ExprCtx): MappedNode {
  const integration = findIntegration(action.integration)!;
  const api = findOperation(action.integration, action.operation)!.api!;
  const baseUrlField = integration.api?.baseUrlField ?? "ERP_BASE_URL";
  const query = Object.entries(api.query ?? {}).map(([name, param]) => ({ name, value: toN8nValue(action.params[param] ?? "", ctx) }));
  const pending = api.path.includes("<");
  const pendingLine = pending ? `接口路径尚未确认：URL 中的 ${api.path} 需要替换为真实路径。\n` : "";
  return {
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    parameters: {
      method: api.method,
      url: `={{ $env.${baseUrlField} }}${api.path}`,
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendQuery: query.length > 0,
      queryParameters: { parameters: query },
      options: {},
    },
    credentials: { httpHeaderAuth: { name: integration.name } },
    placeholder: {
      note: `${title}（集成：${integration.name}）\n${pendingLine}请在 n8n 中创建 Header Auth 凭证「${integration.name}」：Header 名为 Authorization，值为 Bearer 加上 ${baseUrlField} 对应的令牌。\n\n${instructions}`,
    },
  };
}

/**
 * transform 的模板是否像字段拼接（可以直接写进 Set 节点）。
 * 去掉 {{引用}} 后剩下的文字很短且没有句读；写成句子的指令（"对…逐行判断…"）不能当作数据处理。
 */
export function isSimpleTemplate(template: string): boolean {
  const literal = template.replace(/\{\{[^{}]*\}\}/g, "");
  return literal.length <= 20 && !/[。，,；;！!？?]/.test(literal);
}

/** 可以直接映射的节点类型（supports() 与 capabilities 据此保持一致） */
export type MappableNode = Exclude<WorkflowNode, { type: "foreach" } | { type: "start" }>;

const noOp = (): MappedNode => ({ type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {} });

function placeholder(title: string, note: string): MappedNode {
  return { ...noOp(), placeholder: { note: `${title}\n\n${note}` } };
}

/**
 * 映射单个 IR 节点（export-v2.md 8.2 的子集）。
 * decision 的条件来自它的第一条"真"出边，由调用方传入；merge 的入边数由调用方传入。
 */
export function mapNode(node: MappableNode, condition: Condition | undefined, ctx: ExprCtx, seed: string, incoming = 0): MappedNode {
  switch (node.type) {
    case "end":
      return noOp();

    case "merge":
      // Merge 默认只有两个输入；入边更多时需要显式设置输入数量（numberInputs 在目标 n8n 版本上待验证，见 export-v2.md 8.4）
      return { type: "n8n-nodes-base.merge", typeVersion: 3, parameters: incoming > 2 ? { numberInputs: incoming } : {} };

    case "decision": {
      if (node.mode !== "expr") {
        return placeholder(node.title, `判断方式为大模型（${node.question ?? "未填写问题"}），导入后请替换为 Text Classifier 节点。`);
      }
      if (!condition) throw new Error(`条件分支「${node.title}」缺少条件`);
      return {
        type: "n8n-nodes-base.if",
        typeVersion: 2.2,
        parameters: {
          conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "loose" }, ...toIfConditions(condition, ctx, seed) },
          options: {},
        },
      };
    }

    case "step": {
      const action = node.action;
      if (!action) return placeholder(node.title, node.instructions);

      switch (action.kind) {
        case "http": {
          const headers = Object.entries(action.headers ?? {});
          const hasBody = action.method !== "GET" && action.body !== undefined;
          return {
            type: "n8n-nodes-base.httpRequest",
            typeVersion: 4.2,
            parameters: {
              method: action.method,
              url: toN8nValue(action.url, ctx),
              sendHeaders: headers.length > 0,
              headerParameters: {
                parameters: headers.map(([name, value]) => ({ name, value: toN8nValue(value, ctx) })),
              },
              sendBody: hasBody,
              specifyBody: "json",
              jsonBody: hasBody ? toN8nValue(action.body!, ctx) : undefined,
            },
          };
        }

        case "transform":
          if (!isSimpleTemplate(action.template)) {
            return placeholder(node.title, `数据整理（模板是描述而非字段拼接，导入后请改写为 Code 或 Set 节点）：\n${action.template}\n\n${node.instructions}`);
          }
          return {
            type: "n8n-nodes-base.set",
            typeVersion: 3.4,
            parameters: {
              assignments: {
                assignments: [{ id: seed, name: "result", value: toN8nValue(action.template, ctx), type: "string" }],
              },
              options: {},
            },
          };

        case "code":
          if (action.language !== "javascript") {
            return placeholder(node.title, `代码语言为 ${action.language}，导入后请改写为 Code 节点。\n\n${node.instructions}`);
          }
          return { type: "n8n-nodes-base.code", typeVersion: 2, parameters: { jsCode: action.source } };

        // 以下类型尚未映射，放置占位节点
        case "integration":
          if (canMapIntegration(action)) return integrationHttp(node.title, node.instructions, action, ctx);
          return placeholder(node.title, `集成操作：${action.integration}.${action.operation}\n\n${node.instructions}`);
        case "llm":
          return placeholder(node.title, `大模型调用，导入后请替换为 Basic LLM Chain。\n\n${node.instructions}`);
        case "human":
          return placeholder(node.title, `人工确认，导入后请替换为 Wait（表单）节点。\n\n${node.instructions}`);
      }
    }
  }
}

/** 循环数据放在这个字段下，再由 Split Out 拆成多条 */
const LOOP_FIELD = "__items";

export interface LoopNodes {
  prepare: MappedNode;
  gate: MappedNode;
  split: MappedNode;
  loop: MappedNode;
  collect: MappedNode;
  empty: MappedNode;
  merge: MappedNode;
}

/**
 * foreach 展开为七个节点（export-v2.md 8.2）：
 * 准备（Set：取出 over 的数组）→ 有数据？（IF）→ 拆分（Split Out）→ Loop Over Items → 汇总（Aggregate）
 * 没有数据时走"空结果"（Set，输出空数组）。两条路径汇入合并（Merge），下游从合并节点取结果。
 * 有数据才进入拆分，因为 Split Out 对空值会输出一条空数据，而不是零条。
 * 嵌套循环每轮外层迭代都要从头开始，因此由拆分节点进入时重置。
 */
export function loopNodes(node: Extract<WorkflowNode, { type: "foreach" }>, ctx: ExprCtx, seed: string, resetFrom?: string): LoopNodes {
  const field = node.outputs?.[0]?.name ?? "results";
  return {
    prepare: {
      type: "n8n-nodes-base.set",
      typeVersion: 3.4,
      parameters: {
        assignments: {
          assignments: [{ id: stableId(`${seed}:prepare`), name: LOOP_FIELD, value: toArrayValue(node.over, ctx), type: "array" }],
        },
        options: {},
      },
    },
    gate: {
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
          combinator: "and",
          conditions: [{ id: stableId(`${seed}:gate`), leftValue: `={{ $json.${LOOP_FIELD} }}`, operator: { type: "array", operation: "notEmpty", singleValue: true } }],
        },
        options: {},
      },
    },
    split: {
      type: "n8n-nodes-base.splitOut",
      typeVersion: 1,
      parameters: { fieldToSplitOut: LOOP_FIELD, include: "noOtherFields", options: { destinationFieldName: node.item } },
    },
    loop: {
      type: "n8n-nodes-base.splitInBatches",
      typeVersion: 3,
      parameters: { batchSize: 1, options: resetFrom ? { reset: `={{ $prevNode.name === '${quote(resetFrom)}' }}` } : {} },
    },
    collect: {
      type: "n8n-nodes-base.aggregate",
      typeVersion: 1,
      parameters: { aggregate: "aggregateAllItemData", destinationFieldName: field },
    },
    empty: {
      type: "n8n-nodes-base.set",
      typeVersion: 3.4,
      parameters: {
        assignments: { assignments: [{ id: stableId(`${seed}:empty`), name: field, value: "={{ [] }}", type: "array" }] },
        options: {},
      },
    },
    merge: { type: "n8n-nodes-base.merge", typeVersion: 3, parameters: {} },
  };
}
