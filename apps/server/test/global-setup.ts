import { runMigrations } from "../src/db/migrate.js";

/**
 * 测试开始前：确认使用的是测试库，并把迁移应用到测试库。
 * 测试会创建和删除用户、会话等数据，绝不能指向开发数据库。
 */
export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) return; // 没有数据库时，依赖数据库的用例会自动跳过
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/_test$/.test(dbName)) {
    throw new Error(`测试必须使用 *_test 数据库，当前是 "${dbName}"，已拒绝运行以免覆盖开发数据。`);
  }
  await runMigrations(url);
}
