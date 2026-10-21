import { z } from "zod";

// 当前版本是 v2（docs/export-v2.md 第 3 节）。v1 只保留 schema 用于迁移，见 migrate.ts。

const SlugSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug 必须是 kebab-case 英文");

/** 变量名与节点 id 都不能包含空白、花括号和点，否则无法写进 {{引用}} */
const NameSchema = z.string().min(1).regex(/^[^\s{}.]+$/, "不能包含空白、花括号或点");

/** 引用：input.x、env.X、<item 名>[.字段]、<节点 id>.<变量名>[.字段] */
export const REF_PATTERN = /^[^\s{}.]+(\.[^\s{}.]+)*$/;
export const RefSchema = z.string().regex(REF_PATTERN, "引用格式应为 input.x、env.X、<元素名>，或 <节点id>.<变量名>");

/** 节点的执行方式：决定导出时写成脚本、AI 指令，还是人工确认。 */
export const ExecutorSchema = z.enum(["deterministic", "llm", "human"]);

export const IntegrationAccessSchema = z.enum(["mcp", "api", "cli", "webhook", "manual"]);

export const TriggerSchema = z.object({
  type: z.enum(["manual", "schedule", "event"]),
  detail: z.string(),
  cron: z.string().optional(),
  /** 事件触发的来源集成，例如收到新邮件（integrations 中的 id）；没有时导出为通用 Webhook */
  integration: z.string().optional(),
  /** 来源集成中的事件名，例如 newMail */
  event: z.string().optional(),
});

export const IntegrationSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  access: IntegrationAccessSchema,
  hint: z.string().optional(),
});

export const WorkflowSourceSchema = z.object({
  painPointIds: z.array(z.string()),
  savedMinutesPerWeek: z.number().nonnegative().optional(),
});

// ———————————————— v2 ————————————————

export const VariableTypeSchema = z.enum(["string", "number", "boolean", "object", "array", "file"]);

/** 数组每一项（或对象）里的字段及其中文说明，聊天场景的提示词用它把「item.name」写成人话 */
export const VariableFieldSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
});

export const VariableSchema = z.object({
  name: NameSchema,
  type: VariableTypeSchema,
  items: VariableTypeSchema.optional(),
  description: z.string(),
  required: z.boolean().optional(),
  fields: z.array(VariableFieldSchema).optional(),
});

const FormFieldSchema = z.object({
  name: NameSchema,
  label: z.string(),
  type: z.enum(["text", "number", "select", "date"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});

/** 模板字符串，可以包含 {{引用}} */
const TemplateSchema = z.string();

export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("integration"),
    integration: z.string(),
    operation: z.string(),
    params: z.record(z.string(), TemplateSchema),
  }),
  z.object({
    kind: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
    url: TemplateSchema,
    headers: z.record(z.string(), TemplateSchema).optional(),
    body: TemplateSchema.optional(),
  }),
  z.object({
    kind: z.literal("llm"),
    prompt: TemplateSchema,
    system: z.string().optional(),
    outputSchema: z.array(VariableSchema).optional(),
  }),
  z.object({ kind: z.literal("transform"), template: TemplateSchema }),
  z.object({
    kind: z.literal("code"),
    language: z.enum(["javascript", "python"]),
    source: z.string(),
  }),
  z.object({
    kind: z.literal("human"),
    message: TemplateSchema,
    form: z.array(FormFieldSchema).optional(),
    approval: z.boolean().optional(),
  }),
]);

export type Action = z.infer<typeof ActionSchema>;

export const CONDITION_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "empty",
  "not_empty",
  "is_true",
  "is_false",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/** 条件表达式：只支持这个固定子集（export-v2.md 3.4） */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { left: string; op: ConditionOp; right?: string | number | boolean };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema) }),
    z.object({ any: z.array(ConditionSchema) }),
    z.object({
      left: RefSchema,
      op: z.enum(CONDITION_OPS),
      right: z.union([z.string(), z.number(), z.boolean()]).optional(),
    }),
  ]),
);

export const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  condition: ConditionSchema.optional(),
  default: z.boolean().optional(),
});
export type WorkflowEdge = z.infer<typeof EdgeSchema>;

const NodeIdSchema = NameSchema;
const TitleSchema = z.string().min(1);

const StartNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("start"),
  title: TitleSchema,
});

const EndNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("end"),
  title: TitleSchema,
  outputs: z
    .array(z.object({ name: NameSchema, from: RefSchema }))
    .optional(),
});

const StepNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("step"),
  title: TitleSchema,
  executor: ExecutorSchema,
  integration: z.string().optional(),
  instructions: z.string().min(1),
  /** 聊天场景下给用户看的操作说明（在哪个系统里点哪里、导出什么）；没有时导出器回退到 instructions */
  chatInstructions: z.string().optional(),
  /** 用户确认的输出模板或格式（例如周报的版式）；导出提示词时作为硬性要求写入，并免去再次询问 */
  template: z.string().optional(),
  action: ActionSchema.optional(),
  /** 说明性的输入名，不参与引用解析；真正的数据依赖写在 action 的引用里 */
  inputs: z.array(z.string()).optional(),
  outputs: z.array(VariableSchema).optional(),
});

const DecisionNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("decision"),
  title: TitleSchema,
  mode: z.enum(["expr", "llm"]),
  question: z.string().optional(),
  input: RefSchema.optional(),
});

const MergeNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("merge"),
  title: TitleSchema,
});

export interface ForeachNode {
  id: string;
  type: "foreach";
  title: string;
  over: string;
  item: string;
  body: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  outputs?: z.infer<typeof VariableSchema>[];
}

const ForeachNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.literal("foreach"),
  title: TitleSchema,
  over: RefSchema,
  item: NameSchema,
  body: z.object({
    nodes: z.array(z.lazy(() => NodeSchema)),
    edges: z.array(EdgeSchema),
  }),
  outputs: z.array(VariableSchema).optional(),
});

export type WorkflowNode =
  | z.infer<typeof StartNodeSchema>
  | z.infer<typeof EndNodeSchema>
  | z.infer<typeof StepNodeSchema>
  | z.infer<typeof DecisionNodeSchema>
  | z.infer<typeof MergeNodeSchema>
  | ForeachNode;

export const NodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    StartNodeSchema,
    EndNodeSchema,
    StepNodeSchema,
    DecisionNodeSchema,
    ForeachNodeSchema,
    MergeNodeSchema,
  ]),
);

export const WorkflowIRSchema = z.object({
  version: z.literal(2),
  kind: z.enum(["automation", "process"]),
  slug: SlugSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  trigger: TriggerSchema,
  inputs: z.array(VariableSchema),
  integrations: z.array(IntegrationSchema),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  source: WorkflowSourceSchema,
});

// ———————————————— v1（只用于迁移，见 migrate.ts） ————————————————

const V1InputSchema = z.object({
  name: z.string(),
  description: z.string(),
  required: z.boolean(),
});

const V1NodeSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["start", "step", "decision", "end"]),
    title: z.string().min(1),
    executor: ExecutorSchema.optional(),
    integration: z.string().optional(),
    instructions: z.string().optional(),
    inputs: z.array(z.string()).optional(),
    outputs: z.array(z.string()).optional(),
  })
  .superRefine((node, ctx) => {
    // step 必须声明执行方式和具体做法，否则导出的 Skill 无法执行
    if (node.type === "step") {
      if (!node.executor) {
        ctx.addIssue({ code: "custom", path: ["executor"], message: "step 节点必须有 executor" });
      }
      if (!node.instructions) {
        ctx.addIssue({ code: "custom", path: ["instructions"], message: "step 节点必须有 instructions" });
      }
    }
  });

export const WorkflowIRv1Schema = z.object({
  version: z.literal(1),
  kind: z.enum(["automation", "process"]),
  slug: SlugSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  trigger: TriggerSchema,
  inputs: z.array(V1InputSchema),
  integrations: z.array(IntegrationSchema),
  nodes: z.array(V1NodeSchema),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })),
  source: WorkflowSourceSchema,
});

// ———————————————— 类型导出 ————————————————

export type Executor = z.infer<typeof ExecutorSchema>;
export type Variable = z.infer<typeof VariableSchema>;
export type VariableField = z.infer<typeof VariableFieldSchema>;
export type VariableType = z.infer<typeof VariableTypeSchema>;
export type WorkflowIR = z.infer<typeof WorkflowIRSchema>;
export type WorkflowIRv1 = z.infer<typeof WorkflowIRv1Schema>;
/** 数据库中可能存在的任意版本 */
export type StoredWorkflowIR = WorkflowIR | WorkflowIRv1;
