import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** 图片存储接口：本地磁盘为默认实现，之后可替换为 OSS */
export interface AttachmentStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export function createLocalStorage(rootDir: string): AttachmentStorage {
  const root = resolve(rootDir);
  // key 由服务端生成（会话 id/附件 id），这里仍然禁止越出根目录
  const pathFor = (key: string) => {
    const full = resolve(root, key);
    if (!full.startsWith(root + sep)) throw new Error("非法的存储路径");
    return full;
  };
  return {
    async put(key, data) {
      const full = pathFor(key);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data, { mode: 0o600 });
    },
    get: (key) => readFile(pathFor(key)),
    delete: (key) => rm(pathFor(key), { force: true }),
  };
}

export const joinKey = (...parts: string[]) => join(...parts).split(sep).join("/");
