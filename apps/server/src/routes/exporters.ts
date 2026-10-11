import { Hono } from "hono";
import type { ExporterPlugin } from "@aif/workflow-ir";
import type { AppVariables } from "../http/context.js";
import { ok } from "../http/envelope.js";

/** 返回启用的导出插件元信息（不包含 compile 函数） */
export function exporterRoutes(deps: { plugins: ExporterPlugin<any>[] }) {
  const r = new Hono<{ Variables: AppVariables }>();
  r.get("/", (c) =>
    ok(
      c,
      deps.plugins.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        version: p.version,
        output: p.output,
        defaultOptions: p.defaultOptions,
      })),
    ),
  );
  return r;
}
