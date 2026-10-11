import { describe, expect, it } from "vitest";
import { parseSseChunk } from "../lib/sse";

describe("parseSseChunk", () => {
  it("解析多个事件，并保留未完成的尾部", () => {
    const { events, rest } = parseSseChunk('event: text_delta\ndata: {"delta":"你"}\n\nevent: done\ndata: {}\n\nevent: tool\nda');
    expect(events).toEqual([
      { event: "text_delta", data: { delta: "你" } },
      { event: "done", data: {} },
    ]);
    expect(rest).toBe("event: tool\nda");
  });

  it("多行 data 合并，非 JSON 原样返回", () => {
    const { events } = parseSseChunk("event: x\ndata: a\ndata: b\n\n");
    expect(events).toEqual([{ event: "x", data: "a\nb" }]);
  });

  it("没有 event 字段时默认为 message", () => {
    const { events } = parseSseChunk('data: {"ok":1}\n\n');
    expect(events[0]!.event).toBe("message");
  });
});
