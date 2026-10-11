import { describe, expect, it } from "vitest";
import { applyEvent, applyProfilePatch, closeStreaming, historyToItems, type Item } from "../lib/timeline";
import type { Profile } from "../lib/types";

const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};

describe("applyEvent", () => {
  it("文字增量拼接到同一个流式气泡", () => {
    const next = ids();
    let items: Item[] = [];
    items = applyEvent(items, { event: "text_delta", data: { delta: "你" } }, next);
    items = applyEvent(items, { event: "text_delta", data: { delta: "好" } }, next);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "msg", role: "assistant", text: "你好", streaming: true });
  });

  it("done 结束流式输出，之后的文字另起气泡", () => {
    const next = ids();
    let items: Item[] = applyEvent([], { event: "text_delta", data: { delta: "第一轮" } }, next);
    items = applyEvent(items, { event: "done", data: {} }, next);
    items = applyEvent(items, { event: "text_delta", data: { delta: "第二轮" } }, next);
    expect(items.filter((i) => i.kind === "msg")).toHaveLength(2);
    expect((items[0] as any).streaming).toBe(false);
  });

  it("工具调用打断文字，并把同一批工具合并显示", () => {
    const next = ids();
    let items: Item[] = applyEvent([], { event: "text_delta", data: { delta: "我先记一下" } }, next);
    items = applyEvent(items, { event: "tool", data: { id: "t1", name: "record_task", status: "start" } }, next);
    items = applyEvent(items, { event: "tool", data: { id: "t2", name: "record_pain_point", status: "start" } }, next);
    items = applyEvent(items, { event: "tool", data: { id: "t1", name: "record_task", status: "end" } }, next);
    const tools = items.find((i) => i.kind === "tools") as any;
    expect(tools.tools.map((t: any) => `${t.name}:${t.status}`)).toEqual(["record_task:end", "record_pain_point:start"]);
    expect((items[0] as any).streaming).toBe(false);
  });

  it("选择题、方案、工作流、错误都会加入时间线", () => {
    const next = ids();
    let items: Item[] = [];
    items = applyEvent(items, { event: "choices", data: { question: "多久一次？", options: ["每天", "每周"], multi: false, allowOther: true } }, next);
    items = applyEvent(items, { event: "state_patch", data: { candidates: [{ id: "c1", title: "方案", painPointIds: [], summary: "", systems: [] }] } }, next);
    items = applyEvent(items, { event: "workflow", data: { workflowId: "w1", version: 2, ir: { name: "周报" } } }, next);
    items = applyEvent(items, { event: "error", data: { message: "出错了" } }, next);
    expect(items.map((i) => i.kind)).toEqual(["choices", "proposals", "workflow", "error"]);
    expect((items[2] as any)).toMatchObject({ workflowId: "w1", version: 2, name: "周报" });
  });

  it("不修改原数组", () => {
    const before: Item[] = [{ kind: "msg", id: "x", role: "user", text: "hi" }];
    const copy = JSON.stringify(before);
    applyEvent(before, { event: "text_delta", data: { delta: "a" } }, ids());
    expect(JSON.stringify(before)).toBe(copy);
  });
});

describe("closeStreaming / historyToItems", () => {
  it("closeStreaming 只关闭末尾的流式气泡", () => {
    const items: Item[] = [{ kind: "msg", id: "a", role: "assistant", text: "x", streaming: true }];
    expect((closeStreaming(items)[0] as any).streaming).toBe(false);
    expect(closeStreaming([{ kind: "msg", id: "b", role: "user", text: "y" }])).toHaveLength(1);
  });

  it("历史消息转换为时间线项", () => {
    const items = historyToItems([{ role: "user", text: "你好" }], ids());
    expect(items[0]).toMatchObject({ kind: "msg", role: "user", text: "你好" });
  });
});

describe("applyProfilePatch", () => {
  const base: Profile = { role: { systems: [] }, tasks: [], painPoints: [], candidates: [] };

  it("角色信息合并，不覆盖未提供的字段", () => {
    const p = applyProfilePatch({ ...base, role: { role: "销售", systems: ["ERP"] } }, { profile: { role: { team: "华南" } } });
    expect(p.role).toEqual({ role: "销售", systems: ["ERP"], team: "华南" });
  });

  it("任务与痛点按 id 新增或替换", () => {
    const task = { id: "t1", title: "周报", frequency: "weekly", steps: [], systems: [] };
    let p = applyProfilePatch(base, { task });
    p = applyProfilePatch(p, { task: { ...task, minutesPerRun: 210 } });
    expect(p.tasks).toHaveLength(1);
    expect(p.tasks[0]!.minutesPerRun).toBe(210);

    const pain = { id: "p1", title: "透视", detail: "", severity: 4, automatable: 5, score: 4200 };
    p = applyProfilePatch(p, { painPoint: pain });
    p = applyProfilePatch(p, { painPoint: { ...pain, score: 100 } });
    expect(p.painPoints).toEqual([{ ...pain, score: 100 }]);
  });
});
