import type { ExportFile } from "@aif/workflow-ir";
import type { SkillFacts } from "./facts.js";

/**
 * Skill 校验器。输入是 Skill 根目录下的全部文件（路径相对于根目录），
 * 纯函数，浏览器和服务端都能运行。分两层：
 * - 规范层：agentskills.io 规范与最佳实践的硬约束，任何来源的 Skill 都要满足；
 * - 忠实度层：给出事实清单时，检查 SKILL.md 的步骤与流程图一致，没有编造的工具和密钥。
 * 每条问题的说明写给模型看，回喂后它应能据此修正。
 */

export interface SkillIssue {
  level: "error" | "warning";
  /** 稳定的问题类型，测试和界面据此区分 */
  code: string;
  message: string;
  file?: string;
}

export interface ValidateOptions {
  /** 期望的 name（= 目录名 = 工作流 slug）；默认取事实清单里的 name */
  name?: string;
  /** 给出时同时做忠实度检查 */
  facts?: SkillFacts;
}

export const DESCRIPTION_LIMIT = 1024;
export const COMPATIBILITY_LIMIT = 500;
export const BODY_LINE_LIMIT = 500;
export const NAME_LIMIT = 64;

/** 第三人称：不以「我」「你」「I」「You」开头 */
export const FIRST_PERSON = /^\s*(我|你|您|我们|I\b|I'|We\b|You\b|Your\b)/i;

/** description 里写了什么时候使用（中英文都认） */
export const WHEN_TO_USE = /时使用|时才使用|时调用|时触发|时启用|场景下使用|\b(?:use\s+(?:this\s+skill\s+)?(?:when|for|if|whenever)|when\s+(?:the\s+)?(?:user|you|someone)|triggers?\s+(?:when|on)|whenever)\b/i;
export const describesWhenToUse = (description: string) => WHEN_TO_USE.test(description);

const XML_TAG = /<\/?[A-Za-z][^<>]*>/;
const RESERVED_NAME = /claude|anthropic/i;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const text = (f: ExportFile) => (typeof f.content === "string" ? f.content : new TextDecoder().decode(f.content));

// ——— frontmatter ———

export function parseFrontmatter(md: string): { fields: Record<string, string>; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return undefined;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2]!.trim();
    if (!raw) continue; // metadata: 这类映射的表头，下面缩进的内容不解析
    let value = raw;
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw) as string;
      } catch {
        value = raw.replace(/^"|"$/g, "");
      }
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      value = raw.slice(1, -1).replace(/''/g, "'");
    }
    fields[kv[1]!] = value;
  }
  return { fields, body: md.slice(m[0].length) };
}

// ——— 密钥与地址 ———

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/https?:\/\/[^\s)>"'`]+/i, "包含 http(s) 地址（地址可能带访问凭证，只能写占位符）"],
  [/\bBearer\s+(?!<)[A-Za-z0-9._~+/-]{8,}/, "包含疑似令牌（Bearer …）"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, "包含疑似密钥"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "包含疑似 GitHub 令牌"],
  [/\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\b\s*[:=]\s*["']?(?![<${])[A-Za-z0-9._~+/-]{12,}/i, "包含疑似凭证赋值"],
];

/** 文本里的地址或疑似密钥；返回问题说明 */
export function findSecrets(content: string): string[] {
  return SECRET_PATTERNS.filter(([re]) => re.test(content)).map(([, why]) => why);
}

// ——— 引用的文件 ———

const ROOT_FILES = "INSTALL\\.md";

/** 正文里引用的相对路径：反引号里的、Markdown 链接里的、行内直接写的 */
export function referencedPaths(content: string): string[] {
  const found = new Set<string>();
  const add = (p: string) => found.add(p.replace(/^\.\//, "").replace(/[.,;:，。；：)）]+$/, ""));
  for (const m of content.matchAll(/`((?:scripts|references|assets)\/[^`\s<>*]+)`/g)) add(m[1]!);
  for (const m of content.matchAll(new RegExp("`(" + ROOT_FILES + ")`", "g"))) add(m[1]!);
  for (const m of content.matchAll(/\]\((?!https?:|mailto:|#)([^)\s#]+)(?:#[^)]*)?\)/g)) add(m[1]!);
  for (const m of content.matchAll(/(?:^|[\s(（])((?:scripts|references|assets)\/[\w./-]+\.\w+)/gm)) add(m[1]!);
  return [...found];
}

// ——— 步骤解析 ———

const STEP_LINE = /^\s*(\d+(?:\.\d+)*)\.\s+\*\*(.+?)\*\*/;

interface Block {
  number: string;
  heading: string;
  text: string;
}

function stepBlocks(body: string): Block[] | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+执行步骤\s*$/.test(l));
  if (start < 0) return undefined;
  const blocks: Block[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const m = STEP_LINE.exec(line);
    if (m) blocks.push({ number: m[1]!, heading: m[2]!, text: line });
    else if (blocks.length) blocks[blocks.length - 1]!.text += `\n${line}`;
  }
  return blocks;
}

const HUMAN_WAIT = /等(?:待)?用户|用户(?:回复|确认|同意)|暂停|wait for the user/i;
const CALLS_API = /调用[^。，；\n]{0,16}(?:接口|API)/i;
/** 代码块里允许出现的命令：解释器、基础工具，以及 Skill 自带的脚本 */
const SAFE_COMMANDS = new Set(["bash", "sh", "node", "python", "python3", "curl", "cp", "mv", "cat", "echo", "ls", "cd", "chmod", "mkdir", "jq", "grep", "head", "tail", "sed", "awk", "test", "export", "source"]);

function codeCommands(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const raw of m[1]!.split("\n")) {
      let line = raw.trim().replace(/^\$\s+/, "");
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      line = line.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
      const cmd = /^[^\s|;&<>]+/.exec(line)?.[0];
      if (cmd) out.push(cmd);
    }
  }
  return out;
}

// ——— 入口 ———

export function validateSkill(files: ExportFile[], options: ValidateOptions = {}): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const add = (level: SkillIssue["level"], code: string, message: string, file?: string) => issues.push({ level, code, message, ...(file ? { file } : {}) });
  const expectedName = options.name ?? options.facts?.name;
  const byPath = new Map(files.map((f) => [f.path, f]));

  const skill = byPath.get("SKILL.md");
  if (!skill) {
    add("error", "skill-md-missing", "缺少 SKILL.md");
    return issues;
  }
  const md = text(skill);
  const parsed = parseFrontmatter(md);
  if (!parsed) {
    add("error", "frontmatter", "SKILL.md 必须以 YAML frontmatter（--- 包裹）开头", "SKILL.md");
    return issues;
  }
  const { fields, body } = parsed;

  // name：来自工作流的 slug，模型改不了，所以格式问题只警告；和期望不一致说明被改坏了，是错误
  const name = fields.name ?? "";
  if (!name) add("error", "name-missing", "frontmatter 缺少 name", "SKILL.md");
  else {
    if (expectedName && name !== expectedName) add("error", "name-mismatch", `name 必须是「${expectedName}」（与目录名一致），现在是「${name}」`, "SKILL.md");
    if (!NAME_PATTERN.test(name)) add("warning", "name-format", "name 只能由小写字母、数字和单个连字符组成，不能以连字符开头或结尾", "SKILL.md");
    if (name.length > NAME_LIMIT) add("warning", "name-length", `name 超过 ${NAME_LIMIT} 个字符`, "SKILL.md");
    if (RESERVED_NAME.test(name)) add("warning", "name-reserved", "name 不能包含 claude 或 anthropic（Claude Code 会拒绝加载）", "SKILL.md");
  }

  const description = fields.description ?? "";
  if (!description.trim()) add("error", "description-missing", "frontmatter 缺少 description", "SKILL.md");
  else {
    if (description.length > DESCRIPTION_LIMIT) add("error", "description-length", `description 有 ${description.length} 个字符，必须不超过 ${DESCRIPTION_LIMIT}`, "SKILL.md");
    if (XML_TAG.test(description)) add("error", "description-xml", "description 不能包含 XML 标签", "SKILL.md");
    if (FIRST_PERSON.test(description)) add("error", "description-person", "description 要用第三人称描述这个 Skill 做什么，不要以「我」「你」「I」「You」开头", "SKILL.md");
    if (!describesWhenToUse(description)) {
      add(options.facts ? "error" : "warning", "description-when", "description 必须写明什么时候使用（例如「……时使用」或 “Use when …”），Agent 靠这一句决定是否触发", "SKILL.md");
    }
  }

  const compatibility = fields.compatibility;
  if (compatibility !== undefined && compatibility.length > COMPATIBILITY_LIMIT) {
    add("error", "compatibility-length", `compatibility 有 ${compatibility.length} 个字符，必须不超过 ${COMPATIBILITY_LIMIT}`, "SKILL.md");
  }

  const bodyLines = body.replace(/\s+$/, "").split(/\r?\n/).length;
  if (bodyLines > BODY_LINE_LIMIT) add("error", "body-length", `SKILL.md 正文有 ${bodyLines} 行，必须不超过 ${BODY_LINE_LIMIT} 行；把详细内容移到 references/ 下的文件，并在正文里说明什么时候读它`, "SKILL.md");

  // 引用的文件必须存在；references 里的文件不要再引用别的 references（保持一层深）
  const paths = new Set(byPath.keys());
  for (const p of referencedPaths(md)) {
    if (!paths.has(p)) add("error", "missing-file", `正文引用了不存在的文件 ${p}`, "SKILL.md");
  }
  for (const f of files) {
    if (!/^references\/.+\.md$/.test(f.path)) continue;
    for (const p of referencedPaths(text(f))) {
      if (p !== f.path && /^references\//.test(p)) add("warning", "nested-reference", `${f.path} 又引用了 ${p}；引用应当从 SKILL.md 直接出发，只有一层`, f.path);
    }
  }

  // 参考文件要在 SKILL.md 里被提到，否则 Agent 不知道有它，也不知道什么时候该读
  const mentioned = new Set(referencedPaths(md));
  for (const f of files) {
    if (/^references\/.+\.md$/.test(f.path) && !mentioned.has(f.path)) {
      add(options.facts ? "error" : "warning", "reference-unlinked", `${f.path} 没有在 SKILL.md 里被引用；在用到它的步骤旁写明什么时候读它`, f.path);
    }
  }

  // 地址与密钥：文档类文件里一律不允许（references/workflow.json 是流程图原文，不在此列）
  for (const f of files) {
    if (!f.path.endsWith(".md")) continue;
    for (const why of findSecrets(text(f))) add("error", "secret", `${f.path} ${why}`, f.path);
  }

  if (options.facts) faithfulness(md, body, options.facts, add);
  return issues;
}

// ——— 忠实度层 ———

function faithfulness(md: string, body: string, facts: SkillFacts, add: (level: SkillIssue["level"], code: string, message: string, file?: string) => void) {
  const blocks = stepBlocks(body);
  if (!blocks) {
    add("error", "steps-missing", "缺少「## 执行步骤」一节", "SKILL.md");
  } else {
    const known = new Set(facts.steps.map((s) => s.number));
    for (const b of blocks) {
      if (!known.has(b.number)) add("error", "step-unknown", `出现了流程图里没有的步骤 ${b.number}「${b.heading}」`, "SKILL.md");
    }
    for (const step of facts.steps) {
      const hits = blocks.filter((b) => b.number === step.number);
      if (hits.length === 0) {
        add("error", "step-missing", `缺少第 ${step.number} 步「${step.heading}」；每个步骤都要写，编号和标题按流程图，格式为「${step.number}. **${step.heading}**」`, "SKILL.md");
        continue;
      }
      if (hits.length > 1) add("error", "step-duplicate", `第 ${step.number} 步出现了 ${hits.length} 次，每个步骤只写一次`, "SKILL.md");
      const block = hits[0]!;
      if (block.heading !== step.heading) add("error", "step-heading", `第 ${step.number} 步的标题应为「${step.heading}」，现在是「${block.heading}」`, "SKILL.md");

      for (const b of step.branches ?? []) {
        if (!block.text.includes(b.label)) add("error", "branch-missing", `第 ${step.number} 步（判断）缺少分支「${b.label}」`, "SKILL.md");
        else if (b.target !== "结束" && !block.text.includes(`第 ${b.target} 步`)) add("error", "branch-target", `第 ${step.number} 步的分支「${b.label}」应指向第 ${b.target} 步`, "SKILL.md");
      }
      if (step.script && !block.text.includes(step.script.path)) {
        add("error", "script-unreferenced", `第 ${step.number} 步有脚本 ${step.script.path}，要在这一步里写明运行它`, "SKILL.md");
      }
      if (step.executor === "human" && !HUMAN_WAIT.test(block.text)) {
        add("error", "human-wait", `第 ${step.number} 步需要用户确认，要写明「等用户回复后再继续」`, "SKILL.md");
      }
      if (step.executor === "deterministic" && !step.script && CALLS_API.test(block.text)) {
        add("error", "no-script-call", `第 ${step.number} 步没有脚本，不能写成「调用接口」；写明向用户索取这一步需要的数据`, "SKILL.md");
      }
    }
    const seen: string[] = [];
    for (const b of blocks) if (known.has(b.number) && !seen.includes(b.number)) seen.push(b.number);
    const expected = facts.steps.map((s) => s.number).filter((n) => seen.includes(n));
    if (seen.some((n, i) => n !== expected[i])) add("error", "step-order", `步骤顺序必须与流程图一致：${facts.steps.map((s) => s.number).join("、")}`, "SKILL.md");
  }

  // 流程图之外的 MCP 工具和命令行工具
  if (/\bmcp__[\w-]+__[\w-]+/.test(md)) add("error", "unknown-tool", "提到了 MCP 工具名；Skill 里不要写具体的工具名，工具名由使用者的环境决定", "SKILL.md");
  const allowed = (cmd: string) => SAFE_COMMANDS.has(cmd) || /^(?:\.\/)?scripts\//.test(cmd);
  for (const cmd of new Set(codeCommands(md))) {
    if (!allowed(cmd)) add("error", "unknown-command", `代码块里出现了流程图之外的命令 ${cmd}；只能使用解释器、基础工具和本 Skill 的脚本`, "SKILL.md");
  }
}
