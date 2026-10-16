import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { tr } from "../i18n";
import type { Me } from "./types";

/** 对话过程中服务端会推送 usage 事件，用它实时更新今日用量 */
export const USAGE_EVENT = "aif:usage";

export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(() => {
    api.get<Me>("/user/info").then(setMe).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const onUsage = (e: Event) => {
      const d = (e as CustomEvent<{ tokensToday: number; costUsdToday: number }>).detail;
      setMe((m) => (m ? { ...m, usage: { ...m.usage, tokensToday: d.tokensToday, costUsdToday: d.costUsdToday } } : m));
    };
    window.addEventListener(USAGE_EVENT, onUsage);
    return () => window.removeEventListener(USAGE_EVENT, onUsage);
  }, [refresh]);
  return { me, refresh };
}

export function formatTokens(n: number) {
  if (n >= 10_000) return tr("common.tokensWan", { n: Math.round(n / 10_000) });
  return String(n);
}
