import type { WorkflowIR } from "@aif/workflow-ir";
import { findIntegration, type IntegrationEntry } from "@aif/integrations";

/** 需要写入 CONNECTIONS.md 的集成（API、CLI、Webhook） */
export function connectionEntries(ir: WorkflowIR): IntegrationEntry[] {
  return ir.integrations
    .map((i) => findIntegration(i.id))
    .filter((e): e is IntegrationEntry => !!e && (e.access === "api" || e.access === "cli" || e.access === "webhook"));
}

/**
 * CONNECTIONS.md：API、CLI、Webhook 的调用说明。
 * 所有地址和令牌都只以 <填写 …> 占位符出现，文件中没有任何真实值。
 */
export function renderConnections(ir: WorkflowIR): string | undefined {
  const entries = connectionEntries(ir);
  if (entries.length === 0) return undefined;

  const lines: string[] = ["# 外部连接说明", "", "以下命令中的 `<填写 …>` 是占位符，请替换为你自己的配置。不要把替换后的文件提交到代码仓库。", ""];
  for (const e of entries) {
    lines.push(`## ${e.name}`, "", e.summary, "");
    lines.push(`- 需要配置：${e.fields.map((f) => `\`${f.name}\`（${f.description}）`).join("；") || "无"}`);
    lines.push(`- 连通性检查：${e.verify}`);
    if (!e.verified) lines.push("- 注意：此连接尚未在真实环境中验证。");
    if (e.notes) lines.push(`- 说明：${e.notes}`);
    lines.push("");

    if (e.access === "api" && e.api) {
      const base = e.api.baseUrlField ? `<填写 ${e.api.baseUrlField}>` : "<填写接口地址>";
      const auth = e.api.auth ? ["-H", `"${e.api.auth.header}: ${e.api.auth.scheme === "Bearer" ? "Bearer " : ""}<填写 ${e.api.auth.field}>"`] : [];
      for (const ex of e.api.examples) {
        lines.push(`### ${ex.title}`, "", "```bash", [`curl -X ${ex.method}`, `"${base}${ex.path}"`, ...auth].join(" "), "```", "");
      }
    }

    if (e.access === "webhook" && e.webhook) {
      lines.push("### 发送消息", "", "```bash", [`curl -X POST "<填写 ${e.webhook.urlField}>"`, `-H "Content-Type: application/json"`, `-d '${JSON.stringify(e.webhook.example)}'`].join(" \\\n  "), "```", "");
    }

    if (e.access === "cli" && e.cli) {
      lines.push("### 安装与登录检查", "", "```bash", e.cli.installCheck, ...(e.cli.loginCheck ? [e.cli.loginCheck] : []), "```", "");
    }
  }
  return lines.join("\n");
}
