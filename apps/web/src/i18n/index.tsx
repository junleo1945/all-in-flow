import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { common } from "./messages/common";
import { login } from "./messages/login";
import { home } from "./messages/home";
import { workspace } from "./messages/workspace";
import { exporters } from "./messages/exporters";
import { shell } from "./messages/shell";
import { authorizations } from "./messages/authorizations";

export type Locale = "zh" | "en";

/** 每个文件一个词条集合，key 用「区域.名称」命名，zh 为源文案，en 必须有同样的 key */
export type Messages = { zh: Record<string, string>; en: Record<string, string> };

const AREAS: Messages[] = [common, login, home, workspace, exporters, shell, authorizations];
const ZH: Record<string, string> = Object.assign({}, ...AREAS.map((a) => a.zh));
const EN: Record<string, string> = Object.assign({}, ...AREAS.map((a) => a.en));

const STORAGE_KEY = "aif-locale";

/** 根据浏览器语言列表决定默认语言：首选语言是中文则用中文，否则用英文 */
export function localeFromLanguages(langs: readonly string[]): Locale {
  const first = (langs[0] ?? "").toLowerCase();
  return first.startsWith("zh") ? "zh" : "en";
}

// 用户在菜单里切换过就记住选择；否则跟随浏览器语言
function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* 无法读取存储时使用浏览器语言 */
  }
  if (typeof navigator === "undefined") return "zh";
  return localeFromLanguages(navigator.languages?.length ? navigator.languages : [navigator.language ?? ""]);
}

// 模块级的当前语言：供非组件代码（如 lib 里的标签函数）在渲染期间取词条
let current: Locale = readLocale();

/** 库里保存的默认标题是中文「新访谈」，显示时按当前语言换成对应文案；用户自己起的标题原样显示 */
export function displayTitle(title: string): string {
  return title === "新访谈" ? tr("common.newInterview") : title;
}

/** 当前界面语言，发请求时放进 X-Locale 头 */
export function currentLocale(): Locale {
  return current;
}

/** 按当前语言翻译；{name} 形式的占位符用 vars 替换，缺失的词条回退到中文 */
export function tr(key: string, vars?: Record<string, string | number>): string {
  const dict = current === "en" ? EN : ZH;
  let s = dict[key] ?? ZH[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

type Ctx = { locale: Locale; setLocale: (l: Locale) => void; t: typeof tr };
const LocaleContext = createContext<Ctx>({ locale: current, setLocale: () => {}, t: tr });

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(current);

  const setLocale = useCallback((l: Locale) => {
    current = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* 无法保存时只影响下次打开的记忆 */
    }
    setLocaleState(l);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, t: tr }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** 组件里使用：const { t, locale, setLocale } = useI18n(); */
export function useI18n(): Ctx {
  return useContext(LocaleContext);
}

export { ZH as ZH_MESSAGES, EN as EN_MESSAGES };
