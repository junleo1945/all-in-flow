import { describe, expect, it } from "vitest";
import { durationLabel } from "../lib/types";

describe("表格里的耗时显示", () => {
  it("选了档位显示档位，说不准显示「说不准」，直接说的分钟数显示分钟，都没有显示 —", () => {
    expect(durationLabel({ durationBucket: "hours", minutesPerRun: 90 })).toBe("一两个小时");
    expect(durationLabel({ durationBucket: "unknown" })).toBe("说不准");
    expect(durationLabel({ minutesPerRun: 75 })).toBe("75 min");
    expect(durationLabel({})).toBe("—");
  });
});
