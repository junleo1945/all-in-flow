/**
 * 由种子生成稳定的 UUID 形式的 id，同一个工作流多次导出结果一致。
 * 不用 node:crypto，插件要在浏览器里运行。
 */
export function stableId(seed: string): string {
  const hex = (offset: number) => {
    let h = offset;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  const raw = hex(0x811c9dc5) + hex(0x5bd1e995) + hex(0x27d4eb2f) + hex(0x165667b1);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}
