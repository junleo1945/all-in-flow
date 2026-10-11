import type { ExecGraph, Feature } from "./lower.js";
import { FEATURE_LABELS } from "./lower.js";

export interface ExportIssue {
  level: "error" | "warning";
  nodeId?: string;
  message: string;
}

export interface ExportFile {
  /** 相对于导出包根目录的路径，例如 SKILL.md、references/workflow.mmd */
  path: string;
  content: string | Uint8Array;
}

/**
 * 导出插件接口（export-v2.md 6.2）。
 * 插件是纯函数：输入执行图，输出文件。打包成 zip 等工作由前端完成。
 */
export interface ExporterPlugin<Options = unknown> {
  type: "exporter";
  id: string;
  name: string;
  description: string;
  version: string;
  /** 目标平台版本，展示在导出菜单中，例如 "n8n >= 1.x" */
  targetVersion?: string;
  output: "file" | "zip";
  /** 默认选项；前端可以据此生成表单 */
  defaultOptions: Options;
  /**
   * 支持的能力："full" 完整导出，"degraded" 有损导出（会给出警告）。
   * 未列出的能力由 checkExport 报错，插件不需要手写这部分检查。
   */
  capabilities: Partial<Record<Feature, "full" | "degraded">>;
  /** 只写平台特有的检查，通用的能力检查由 checkExport 完成 */
  supports(graph: ExecGraph): ExportIssue[];
  compile(graph: ExecGraph, options: Options): ExportFile[] | Promise<ExportFile[]>;
  /** 运行导出产物需要的外部条件，导出后展示给用户 */
  requirements(graph: ExecGraph): string[];
}

/** 能力检查：不支持的能力报错，有损的能力给出警告 */
export function capabilityIssues(capabilities: ExporterPlugin["capabilities"], features: ExecGraph["features"]): ExportIssue[] {
  const issues: ExportIssue[] = [];
  for (const [feature, nodeIds] of features) {
    const level = capabilities[feature];
    const label = FEATURE_LABELS[feature];
    const where = nodeIds.length ? `（节点：${nodeIds.join("、")}）` : "";
    if (level === undefined) {
      issues.push({ level: "error", nodeId: nodeIds[0], message: `不支持导出「${label}」${where}` });
    } else if (level === "degraded") {
      issues.push({ level: "warning", nodeId: nodeIds[0], message: `「${label}」导出后会有损失${where}` });
    }
  }
  return issues;
}

/** 导出前的完整检查：通用能力检查 + 插件自己的检查 */
export function checkExport(plugin: ExporterPlugin<any>, graph: ExecGraph): ExportIssue[] {
  return [...capabilityIssues(plugin.capabilities, graph.features), ...plugin.supports(graph)];
}

export class ExporterRegistry {
  private plugins = new Map<string, ExporterPlugin<any>>();

  register(plugin: ExporterPlugin<any>) {
    if (this.plugins.has(plugin.id)) throw new Error(`导出插件 id 重复：${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
    return this;
  }

  /** 只返回启用列表中的插件（EXPORT_PLUGINS） */
  enabled(enabledIds: string[]): ExporterPlugin<any>[] {
    return enabledIds.map((id) => this.plugins.get(id)).filter((p): p is ExporterPlugin<any> => !!p);
  }

  get(id: string): ExporterPlugin<any> | undefined {
    return this.plugins.get(id);
  }
}

export function createExporterRegistry(plugins: ExporterPlugin<any>[] = []) {
  const reg = new ExporterRegistry();
  for (const p of plugins) reg.register(p);
  return reg;
}
