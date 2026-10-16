import type { Context } from "hono";
import { messages } from "./messages.js";

export type Locale = "zh" | "en";

/** 客户端通过 X-Locale 头告诉服务端界面语言；缺失或无法识别时用中文（与前端默认一致） */
export const LOCALE_HEADER = "X-Locale";

export function parseLocale(v: string | undefined | null): Locale {
  return v?.trim().toLowerCase() === "en" ? "en" : "zh";
}

/** 服务端面向用户的文案：zh 为源文案，en 必须有同样的 key。由 messages 文件按区域注册 */
export const SERVER_MESSAGES: Record<Locale, Record<string, string>> = { zh: { ...messages.zh }, en: { ...messages.en } };

/** 按语言取文案；缺失时回退中文，占位符 {name} 用 vars 替换 */
export function tm(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let s = SERVER_MESSAGES[locale][key] ?? SERVER_MESSAGES.zh[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export function localeOf(c: Context): Locale {
  return parseLocale(c.req.header(LOCALE_HEADER));
}

let zhIndex: { exact: Map<string, string>; templates: Array<{ key: string; re: RegExp; names: string[] }> } | undefined;
function index() {
  if (zhIndex) return zhIndex;
  const exact = new Map<string, string>();
  const templates: Array<{ key: string; re: RegExp; names: string[] }> = [];
  for (const [key, zh] of Object.entries(SERVER_MESSAGES.zh)) {
    if (!zh.includes("{")) {
      exact.set(zh, key);
      continue;
    }
    const names: string[] = [];
    const src = zh
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        names.push(m[1]!);
        return "([\\s\\S]+?)";
      })
      .join("");
    templates.push({ key, re: new RegExp(`^${src}$`), names });
  }
  return (zhIndex = { exact, templates });
}

/**
 * 翻译由服务层以中文抛出的错误文案（服务层没有请求上下文）：
 * 命中已注册的中文文案（含 {占位符} 模板）则按 locale 返回，否则原样返回。
 */
export function tr(locale: Locale, text: string): string {
  if (locale === "zh") return text;
  const { exact, templates } = index();
  const k = exact.get(text);
  if (k) return tm(locale, k);
  for (const t of templates) {
    const m = t.re.exec(text);
    if (m) return tm(locale, t.key, Object.fromEntries(t.names.map((n, i) => [n, m[i + 1]!])));
  }
  const i = text.indexOf("：");
  if (i > 0) {
    const head = tr(locale, text.slice(0, i));
    if (head !== text.slice(0, i)) return `${head}: ${tr(locale, text.slice(i + 1))}`;
  }
  return text;
}
