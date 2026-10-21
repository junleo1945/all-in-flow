import { findIntegration, findOperation, type IntegrationEntry, type Operation } from "@aif/integrations";
import { orderSteps, type Action, type WorkflowIR, type WorkflowNode } from "@aif/workflow-ir";

/** 一个确定性步骤对应的脚本（export-v2.md 7.1） */
export interface ScriptPlan {
  stepId: string;
  /** 相对于 Skill 根目录的路径，例如 scripts/01-listOrders.sh */
  path: string;
  content: string;
  /** 参数对应的原始写法，按顺序排列，SKILL.md 中据此说明每个参数从哪里来 */
  args: string[];
  /** 不属于位置参数的调用说明（例如代码步骤通过 JSON 传入上游输出），SKILL.md 中跟在运行命令后面 */
  usage?: string;
}

export interface ScriptPlanResult {
  plans: Map<string, ScriptPlan>;
  /** 无法生成脚本的步骤及原因，导出时以文字说明代替 */
  unsupported: Array<{ stepId: string; title: string; reason: string }>;
}

const TEMPLATE = /\{\{\s*[^{}]*?\s*\}\}/g;

/**
 * 为所有确定性步骤生成脚本。numbers 为顶层步骤编号（与 SKILL.md 一致）。
 * foreach 子流程里的步骤按子流程自己的顺序编号：文件名为 03-01-xxx（第 3 步的第 1 个子步骤），
 * 脚本头部和 SKILL.md 里写作「第 3.1 步」，这样不同子步骤的脚本不会重名。
 */
export function planScripts(ir: WorkflowIR, numbers: Map<string, number>): ScriptPlanResult {
  const plans = new Map<string, ScriptPlan>();
  const unsupported: ScriptPlanResult["unsupported"] = [];
  const visit = (nodes: WorkflowNode[], nums: Map<string, number>, filePrefix: string | undefined, labelPrefix: string) => {
    for (const n of nodes) {
      const num = nums.get(n.id) ?? 0;
      const prefix = filePrefix ? `${filePrefix}-${pad(num)}` : pad(num);
      const label = `${labelPrefix}${num}`;
      if (n.type === "foreach") {
        const body = { ...ir, nodes: n.body.nodes, edges: n.body.edges };
        visit(n.body.nodes, orderSteps(body).number, prefix, `${label}.`);
        continue;
      }
      if (n.type !== "step" || !n.action) continue;
      const result = planFor(n, n.action, prefix, label);
      if ("reason" in result) {
        if (n.executor === "deterministic") unsupported.push({ stepId: n.id, title: n.title, reason: result.reason });
      } else {
        plans.set(n.id, result);
      }
    }
  };
  visit(ir.nodes, numbers, undefined, "");
  return { plans, unsupported };
}

const pad = (k: number) => String(k).padStart(2, "0");

/** 代码步骤的调用说明：上游输出以 JSON 传入，结果以 JSON 打印 */
const CODE_USAGE = "把直接上游步骤的输出（JSON）作为第一个参数传入，也可以通过标准输入传入；结果以 JSON 打印到标准输出";

function planFor(n: Extract<WorkflowNode, { type: "step" }>, action: Action, prefix: string, label: string): ScriptPlan | { reason: string } {
  const title = n.title;

  if (action.kind === "transform") {
    const parts = action.template.split(TEMPLATE);
    const args = refsIn(action.template);
    const file = `scripts/${prefix}-transform.mjs`;
    return {
      stepId: n.id,
      path: file,
      args,
      content: [
        `// 由 all-in-flow 生成：第 ${label} 步「${title}」数据整理`,
        `// 用法：node ${file} ${argUsage(args)}`,
        `const args = process.argv.slice(2);`,
        `if (args.length !== ${args.length}) { console.error("用法：node ${file} ${argUsage(args)}"); process.exit(1); }`,
        `const parts = ${JSON.stringify(parts)};`,
        `let out = parts[0];`,
        `for (let i = 1; i < parts.length; i++) out += (args[i - 1] ?? "") + parts[i];`,
        `process.stdout.write(out);`,
        ``,
      ].join("\n"),
    };
  }

  if (action.kind === "code") {
    const py = action.language === "python";
    const file = `scripts/${prefix}-code.${py ? "py" : "mjs"}`;
    const content = py ? pythonWrapper(file, label, title, action.source) : nodeWrapper(file, label, title, action.source);
    return { stepId: n.id, path: file, args: [], usage: CODE_USAGE, content };
  }

  if (action.kind === "integration") {
    const entry = findIntegration(action.integration);
    const op = findOperation(action.integration, action.operation);
    if (!entry || !op) return { reason: `集成或操作未登记：${action.integration}.${action.operation}` };
    const missing = op.params.filter((p) => p.required && !(p.name in action.params)).map((p) => p.name);
    if (missing.length) return { reason: `缺少必填参数：${missing.join("、")}` };
    const args = op.params.map((p) => action.params[p.name] ?? "");
    const file = `scripts/${prefix}-${op.id}.sh`;
    const body = scriptFor(entry, op);
    if ("reason" in body) return body;
    return {
      stepId: n.id,
      path: file,
      args,
      content: [
        `#!/usr/bin/env bash`,
        `# 由 all-in-flow 生成：第 ${label} 步「${title}」→ ${entry.name}·${op.title}（${op.id}）`,
        `# 用法：${file} ${argUsage(args)}`,
        `# 参数顺序：${op.params.map((p, i) => `$${i + 1}=${p.name}（${p.description}）`).join("；") || "无"}`,
        `set -euo pipefail`,
        `ROOT="$(cd "$(dirname "$0")/.." && pwd)"`,
        ...ENV_LOADER,
        `[ $# -eq ${op.params.length} ] || { echo "用法：$0 ${argUsage(args)}" >&2; exit 1; }`,
        ...body.lines,
        ``,
      ].join("\n"),
    };
  }

  // http / llm / human：没有确定性的脚本可以生成
  if (action.kind === "http") return { reason: "普通 HTTP 请求尚未支持生成脚本" };
  return { reason: "这类步骤由 Agent 或用户完成，不生成脚本" };
}

/**
 * 代码步骤的 JavaScript 包装。生成 IR 时约定的代码写法是：用 $input.first().json 读上游输出，
 * 用 return [{ json: {...} }] 返回，所以源码必须放进函数体里，不能直接接在脚本顶层。
 */
function nodeWrapper(file: string, label: string, title: string, source: string): string {
  return [
    `// 由 all-in-flow 生成：第 ${label} 步「${title}」代码`,
    `// 用法：node ${file} '<上游输出的 JSON>'（也可以通过标准输入传入）`,
    `// 输入：直接上游步骤的输出。JSON 数组的每个元素算一项，其他 JSON 值算一项。`,
    `// 输出：结果的 JSON 打印到标准输出；运行出错时打印原因并以非 0 退出。`,
    `import { readFileSync } from "node:fs";`,
    ``,
    `function readInput() {`,
    `  const raw = process.argv.length > 2 ? process.argv[2] : readFileSync(0, "utf8");`,
    `  try {`,
    `    return JSON.parse(raw);`,
    `  } catch (e) {`,
    `    console.error("输入不是合法的 JSON：" + e.message);`,
    `    process.exit(1);`,
    `  }`,
    `}`,
    ``,
    `const data = readInput();`,
    `const items = (Array.isArray(data) ? data : [data]).map((json) => ({ json }));`,
    `const $input = { first: () => items[0], last: () => items[items.length - 1], all: () => items };`,
    ``,
    `async function run($input) {`,
    source,
    `}`,
    ``,
    `let result;`,
    `try {`,
    `  result = await run($input);`,
    `} catch (e) {`,
    `  console.error("代码执行失败：" + e.message);`,
    `  process.exit(1);`,
    `}`,
    `const out = (Array.isArray(result) ? result : [result]).map((item) => (item && typeof item === "object" && "json" in item ? item.json : item));`,
    `process.stdout.write(JSON.stringify(out.length === 1 ? out[0] : out));`,
    ``,
  ].join("\n");
}

/** 代码步骤的 Python 包装：源码放进 run() 函数体，可以使用 input_json、input_items，用 return 返回结果 */
function pythonWrapper(file: string, label: string, title: string, source: string): string {
  const body = (source.trim() ? source : "pass")
    .split("\n")
    .map((line) => (line.trim() ? `    ${line}` : ""))
    .join("\n");
  return [
    `# 由 all-in-flow 生成：第 ${label} 步「${title}」代码`,
    `# 用法：python3 ${file} '<上游输出的 JSON>'（也可以通过标准输入传入）`,
    `# 代码里可以使用 input_json（第一项的数据）和 input_items（全部项的数据列表），用 return 返回结果。`,
    `import json`,
    `import sys`,
    ``,
    `def _read_input():`,
    `    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()`,
    `    try:`,
    `        return json.loads(raw)`,
    `    except ValueError as e:`,
    `        sys.stderr.write("输入不是合法的 JSON：%s\\n" % e)`,
    `        sys.exit(1)`,
    ``,
    `_data = _read_input()`,
    `input_items = _data if isinstance(_data, list) else [_data]`,
    `input_json = input_items[0] if input_items else None`,
    ``,
    `def run(input_json, input_items):`,
    body,
    ``,
    `sys.stdout.write(json.dumps(run(input_json, input_items), ensure_ascii=False))`,
    ``,
  ].join("\n");
}

/**
 * 读取 .env，但不覆盖已经在 shell 中设置的变量（显式设置的优先）。
 * 不用 `. .env`，因为它会无条件覆盖。
 */
const ENV_LOADER = [
  `if [ -f "$ROOT/.env" ]; then`,
  `  while IFS= read -r line || [ -n "$line" ]; do`,
  `    case "$line" in ""|"#"*) continue ;; esac`,
  `    key="\${line%%=*}"`,
  `    [ -z "\${!key+x}" ] && export "$line"`,
  `  done < "$ROOT/.env"`,
  `fi`,
];

/** 按访问方式生成脚本主体；只支持能直接用 curl 或命令行完成的情况 */
function scriptFor(entry: IntegrationEntry, op: Operation): { lines: string[] } | { reason: string } {
  if (entry.access === "api" && op.api) {
    if (op.api.method !== "GET") return { reason: `暂不支持 ${op.api.method} 接口的脚本` };
    const auth = entry.api?.auth;
    const baseField = entry.api?.baseUrlField ?? "BASE_URL";
    const lines: string[] = [];
    lines.push(`: "\${${baseField}:?请在 .env 中填写 ${baseField}}"`);
    if (auth) lines.push(`: "\${${auth.field}:?请在 .env 中填写 ${auth.field}}"`);
    if (op.api.path.includes("<")) {
      // 接口路径尚未确认：通过环境变量覆盖，未填写时明确报错
      const pathEnv = `${entry.id.replace(/-/g, "_").toUpperCase()}_${op.id.toUpperCase()}_PATH`;
      lines.push(`API_PATH="\${${pathEnv}:?接口路径尚未确认，请在 .env 中填写 ${pathEnv}}"`);
    } else {
      lines.push(`API_PATH=${shellQuote(op.api.path)}`);
    }
    // 需要展开 $1、$ERP_TOKEN，所以用双引号；键名和配置项名都来自集成目录，只含字母、数字和下划线
    const query = Object.entries(op.api.query ?? {}).map(([key, param]) => {
      const idx = op.params.findIndex((p) => p.name === param);
      return `  --data-urlencode "${key}=$${idx + 1}"`;
    });
    const header = auth ? `  -H "${auth.header}: ${auth.scheme === "Bearer" ? "Bearer " : ""}$${auth.field}"` : undefined;
    lines.push(
      `curl -sS --fail-with-body -G "$${baseField}$API_PATH" \\`,
      ...query.map((q) => `${q} \\`),
      ...(header ? [`${header} \\`] : []),
      `  -H "Accept: application/json"`,
    );
    return { lines };
  }

  if (entry.access === "webhook" && op.webhook && entry.webhook) {
    const urlField = entry.webhook.urlField;
    const template = JSON.stringify(op.webhook.body);
    const lines: string[] = [`: "\${${urlField}:?请在 .env 中填写 ${urlField}}"`];
    lines.push(`BODY=${shellQuote(template)}`);
    op.params.forEach((p, i) => {
      lines.push(`ESC${i + 1}="$(printf '%s' "$${i + 1}" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')"`);
      lines.push(`BODY="\${BODY//<${p.name}>/$ESC${i + 1}}"`);
    });
    lines.push(`curl -sS --fail-with-body -X POST "$${urlField}" -H "Content-Type: application/json" -d "$BODY"`);
    return { lines };
  }

  if (entry.access === "cli" && op.cli && entry.cli) {
    const command = op.cli.command.replace(/<([^>]+)>/g, (_, name: string) => {
      const idx = op.params.findIndex((p) => p.name === name);
      return idx >= 0 ? `"$${idx + 1}"` : `<${name}>`;
    });
    return {
      lines: [
        `command -v ${entry.cli.command} >/dev/null || { echo "请先安装 ${entry.cli.command}（见 CONNECTIONS.md）" >&2; exit 1; }`,
        command,
      ],
    };
  }

  return { reason: "这个集成的操作没有可直接执行的访问方式" };
}

/** 环境变量清单：每个集成的配置项（值留空）+ 接口路径覆盖项 */
export function renderEnvExample(ir: WorkflowIR): string | undefined {
  const lines: string[] = ["# 复制为 .env 后填写。不要把 .env 提交到代码仓库。", ""];
  let any = false;
  for (const i of ir.integrations) {
    const entry = findIntegration(i.id);
    if (!entry || entry.fields.length === 0) continue;
    any = true;
    lines.push(`# ${entry.name}`);
    for (const f of entry.fields) lines.push(`# ${f.description}`, `${f.name}=`);
    for (const op of entry.operations) {
      if (op.api?.path.includes("<")) {
        const pathEnv = `${entry.id.replace(/-/g, "_").toUpperCase()}_${op.id.toUpperCase()}_PATH`;
        lines.push(`# ${op.title}的接口路径尚未确认，填写实际路径（不含域名）`, `${pathEnv}=`);
      }
    }
    lines.push("");
  }
  return any ? lines.join("\n") : undefined;
}

// ———————————————— 工具 ————————————————

/** 模板中出现的引用，按出现顺序（重复的也保留）。返回原始写法，例如 {{input.week}} */
export function refsIn(template: string): string[] {
  return [...template.matchAll(TEMPLATE)].map((m) => m[0]);
}

function argUsage(args: string[]): string {
  return args.length ? args.map((_, i) => `<参数${i + 1}>`).join(" ") : "";
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
