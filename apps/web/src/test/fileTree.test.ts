import { describe, expect, it } from "vitest";
import { buildFileTree } from "../lib/fileTree";

describe("buildFileTree", () => {
  it("按目录嵌套文件，保持输入顺序", () => {
    const tree = buildFileTree(["demo/SKILL.md", "demo/references/workflow.mmd", "demo/references/workflow.json", "demo/INSTALL.md"]);
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root).toMatchObject({ name: "demo", file: false });
    expect(root.children.map((c) => c.name)).toEqual(["SKILL.md", "references", "INSTALL.md"]);
    const refs = root.children[1]!;
    expect(refs.path).toBe("demo/references");
    expect(refs.children.map((c) => c.path)).toEqual(["demo/references/workflow.mmd", "demo/references/workflow.json"]);
    expect(refs.children.every((c) => c.file)).toBe(true);
  });

  it("单个文件也是一个根节点", () => {
    expect(buildFileTree(["x.prompt.md"])).toEqual([{ name: "x.prompt.md", path: "x.prompt.md", file: true, children: [] }]);
  });
});
