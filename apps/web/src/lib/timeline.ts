import type { Candidate, PainPoint, Profile, Task } from "./types";

/** 对话时间线中的一项 */
export type Item =
  | { kind: "msg"; id: string; role: "user" | "assistant"; text: string; streaming?: boolean; attachments?: string[] }
  | { kind: "tools"; id: string; tools: Array<{ id: string; name: string; status: "start" | "end"; error?: boolean }> }
  | { kind: "choices"; id: string; question: string; options: string[]; multi: boolean; allowOther: boolean; answered?: string }
  | { kind: "proposals"; id: string; candidates: Candidate[] }
  | { kind: "workflow"; id: string; workflowId: string; version: number; name: string }
  | { kind: "error"; id: string; text: string };

export interface ServerEvent {
  event: string;
  data: any;
}

/** 把一个 SSE 事件应用到时间线上。返回新数组，不修改原数组。 */
export function applyEvent(items: Item[], e: ServerEvent, nextId: () => string): Item[] {
  switch (e.event) {
    case "text_delta": {
      const delta: string = e.data?.delta ?? "";
      if (!delta) return items;
      const last = items[items.length - 1];
      if (last && last.kind === "msg" && last.role === "assistant" && last.streaming) {
        return [...items.slice(0, -1), { ...last, text: last.text + delta }];
      }
      return [...items, { kind: "msg", id: nextId(), role: "assistant", text: delta, streaming: true }];
    }
    case "tool": {
      const { id, name, status, error } = e.data ?? {};
      // 工具调用会打断正在流式输出的文字，之后的文字另起一个气泡
      const closed = closeStreaming(items);
      const last = closed[closed.length - 1];
      if (status === "start") {
        if (last && last.kind === "tools") {
          return [...closed.slice(0, -1), { ...last, tools: [...last.tools, { id, name, status: "start" }] }];
        }
        return [...closed, { kind: "tools", id: nextId(), tools: [{ id, name, status: "start" }] }];
      }
      if (last && last.kind === "tools") {
        return [
          ...closed.slice(0, -1),
          { ...last, tools: last.tools.map((t) => (t.id === id ? { ...t, status: "end", error: !!error } : t)) },
        ];
      }
      return closed;
    }
    case "choices": {
      const closed = closeStreaming(items);
      const { question, options, multi, allowOther } = e.data ?? {};
      return [...closed, { kind: "choices", id: nextId(), question, options: options ?? [], multi: !!multi, allowOther: allowOther !== false }];
    }
    case "state_patch": {
      // 候选方案在时间线中以卡片形式出现；画像更新由 applyProfilePatch 处理
      if (Array.isArray(e.data?.candidates)) {
        const closed = closeStreaming(items);
        return [...closed, { kind: "proposals", id: nextId(), candidates: e.data.candidates }];
      }
      return items;
    }
    case "workflow": {
      const closed = closeStreaming(items);
      const ir = e.data?.ir;
      return [
        ...closed,
        { kind: "workflow", id: nextId(), workflowId: e.data?.workflowId, version: e.data?.version, name: ir?.name ?? "工作流" },
      ];
    }
    case "error":
      return [...closeStreaming(items), { kind: "error", id: nextId(), text: e.data?.message ?? "处理失败" }];
    case "done":
      return closeStreaming(items);
    default:
      return items;
  }
}

/** 结束流式输出：把最后一个流式气泡标记为完成 */
export function closeStreaming(items: Item[]): Item[] {
  const last = items[items.length - 1];
  if (last && last.kind === "msg" && last.streaming) {
    return [...items.slice(0, -1), { ...last, streaming: false }];
  }
  return items;
}

/** 把服务端的历史消息转换成时间线 */
export function historyToItems(messages: Array<{ role: "user" | "assistant"; text: string; attachments?: string[] }>, nextId: () => string): Item[] {
  return messages.map((m) => ({ kind: "msg", id: nextId(), role: m.role, text: m.text, ...(m.attachments ? { attachments: m.attachments } : {}) }));
}

/** 把 state_patch 应用到画像（与服务端的 upsert 规则保持一致） */
export function applyProfilePatch(profile: Profile, data: any): Profile {
  let next = profile;
  if (data?.profile?.role) {
    next = { ...next, role: { ...next.role, ...data.profile.role } };
  }
  if (data?.task) {
    const t = data.task as Task;
    const exists = next.tasks.some((x) => x.id === t.id);
    next = { ...next, tasks: exists ? next.tasks.map((x) => (x.id === t.id ? t : x)) : [...next.tasks, t] };
    // 工作耗时变化后，关联痛点的分数由服务端重算；这里取服务端事件里的最新画像（若有）
  }
  if (data?.painPoint) {
    const p = data.painPoint as PainPoint;
    const exists = next.painPoints.some((x) => x.id === p.id);
    next = { ...next, painPoints: exists ? next.painPoints.map((x) => (x.id === p.id ? p : x)) : [...next.painPoints, p] };
  }
  if (Array.isArray(data?.candidates)) {
    next = { ...next, candidates: data.candidates };
  }
  return next;
}
