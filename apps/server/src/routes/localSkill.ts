import { Hono } from "hono";
import type { AppVariables } from "../http/context.js";
import { ok } from "../http/envelope.js";
import { buildSkillPackage } from "../skillPackage/index.js";

/**
 * 本地 Skill 的下载内容（需要登录）：返回文件清单，浏览器端打成 zip。
 * 内容对所有用户相同，只有网站地址取自配置；里面没有任何用户数据和令牌。
 */
export function localSkillRoutes(deps: { publicBaseUrl: string }) {
  const r = new Hono<{ Variables: AppVariables }>();
  r.get("/", (c) => ok(c, buildSkillPackage({ baseUrl: deps.publicBaseUrl })));
  return r;
}
