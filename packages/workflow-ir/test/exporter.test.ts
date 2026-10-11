import { describe, expect, it } from "vitest";
import { capabilityIssues, checkExport, lower, type ExporterPlugin } from "../src/index.js";
import { v2Sample } from "./fixtures-v2.js";

const plugin = (capabilities: ExporterPlugin["capabilities"], supports: ExporterPlugin["supports"] = () => []): ExporterPlugin =>
  ({
    type: "exporter",
    id: "t",
    name: "t",
    description: "t",
    version: "1",
    output: "file",
    defaultOptions: {},
    capabilities,
    supports,
    compile: () => [],
    requirements: () => [],
  }) as ExporterPlugin;

describe("能力检查（export-v2.md 6.2）", () => {
  it("未声明的能力报错，并带上节点", () => {
    const issues = capabilityIssues({}, lower(v2Sample()).features);
    const err = issues.find((i) => i.message.includes("条件分支"));
    expect(err).toMatchObject({ level: "error", nodeId: "n3" });
    expect(issues.every((i) => i.level === "error")).toBe(true);
  });

  it("声明为 degraded 的能力只给警告", () => {
    const issues = capabilityIssues({ foreach: "degraded" }, lower(v2Sample()).features);
    expect(issues.find((i) => i.message.includes("循环"))).toMatchObject({ level: "warning", nodeId: "n2" });
  });

  it("全部声明为 full 时没有问题", () => {
    const all = Object.fromEntries(
      [...lower(v2Sample()).features.keys()].map((f) => [f, "full"]),
    ) as ExporterPlugin["capabilities"];
    expect(capabilityIssues(all, lower(v2Sample()).features)).toEqual([]);
  });

  it("checkExport 合并能力检查和插件自己的检查", () => {
    const p = plugin({}, () => [{ level: "warning", message: "插件自己的提醒" }]);
    const issues = checkExport(p, lower(v2Sample()));
    expect(issues.some((i) => i.message === "插件自己的提醒")).toBe(true);
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });
});
