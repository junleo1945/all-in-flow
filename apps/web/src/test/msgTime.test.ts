import { describe, expect, it } from "vitest";
import { formatMsgTime, historyToItems } from "../lib/timeline";

describe("消息时间", () => {
  // 本地时间构造，避免时区影响断言
  const local = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).toISOString();

  it("当天的消息只显示 HH:mm", () => {
    const now = new Date(2026, 9, 13, 18, 0);
    expect(formatMsgTime(local(2026, 10, 13, 9, 5), now)).toBe("09:05");
  });

  it("其他日期显示 MM-DD HH:mm", () => {
    const now = new Date(2026, 9, 13, 18, 0);
    expect(formatMsgTime(local(2026, 10, 12, 23, 59), now)).toBe("10-12 23:59");
  });

  it("无效时间返回空字符串", () => {
    expect(formatMsgTime("not-a-date")).toBe("");
  });

  it("历史消息带上 createdAt 后映射为条目的 time，没有则不带", () => {
    let n = 0;
    const ids = () => `i${++n}`;
    const items = historyToItems(
      [
        { role: "user", text: "你好", createdAt: "2026-10-13T01:00:00.000Z" },
        { role: "assistant", text: "嗨" },
      ],
      ids,
    );
    expect(items[0]).toMatchObject({ kind: "msg", role: "user", time: "2026-10-13T01:00:00.000Z" });
    expect(items[1]).not.toHaveProperty("time");
  });
});
