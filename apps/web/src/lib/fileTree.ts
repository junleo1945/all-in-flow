export interface TreeNode {
  name: string;
  /** 从根目录起的完整路径 */
  path: string;
  file: boolean;
  children: TreeNode[];
}

/**
 * 把文件路径列表整理成目录树。保持输入的顺序：导出时的文件顺序（例如 SKILL.md 排在最前）就是预览的顺序。
 */
export function buildFileTree(paths: string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let level = roots;
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const file = i === parts.length - 1;
      let node = level.find((n) => n.name === name && n.file === file);
      if (!node) {
        node = { name, path, file, children: [] };
        level.push(node);
      }
      level = node.children;
    });
  }
  return roots;
}
