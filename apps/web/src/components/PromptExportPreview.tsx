import { useEffect, useMemo, useState } from "react";
import type { WorkflowIR } from "@aif/workflow-ir";
import { api } from "../lib/api";
import * as ex from "../lib/exporters";
import { ExportPreview, type PreviewFile } from "./ExportPreview";

/**
 * 对话提示词预览：缺少判断标准或模板时，直接在预览上方补充，提示词随输入实时更新。
 * 补充的内容可以保存为工作流的新版本，下次导出就不用再填。
 */
export function PromptExportPreview({
  ir,
  workflowId,
  onSaved,
  onClose,
}: {
  ir: WorkflowIR;
  /** 没有所属工作流（例如只读场景）时不显示保存按钮 */
  workflowId?: string;
  onSaved?: (version: number) => void;
  onClose: () => void;
}) {
  // 以打开时的版本为基准；保存后换成已保存的内容，表单随之清空
  const [base, setBase] = useState(ir);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<PreviewFile[]>([]);
  const [meta, setMeta] = useState<{ filename: string; notes: string[] }>({ filename: `${ir.slug}.prompt.zip`, notes: [] });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const gaps = useMemo(() => ex.promptGaps(base), [base]);
  const patched = useMemo(() => ex.applyPromptAnswers(base, answers), [base, answers]);
  const filled = Object.values(answers).some((v) => v.trim());

  useEffect(() => {
    let live = true;
    ex.exportPrompt(patched)
      .then((r) => {
        if (!live) return;
        setFiles(r.files);
        setMeta({
          filename: r.filename,
          notes: [
            "完整版：直接粘贴到聊天窗口，或放进 ChatGPT Projects、Claude Projects 等可以写长指令的地方。精简版：2000 字以内，适合放进豆包智能体、Gemini Gem 等字数有限的设定。",
            ...r.requirements.map((q) => `使用前需要：${q}`),
            ...r.warnings.map((w) => `注意：${w}`),
          ],
        });
      })
      .catch((e: Error) => live && setMsg({ kind: "err", text: e.message || "生成失败" }));
    return () => {
      live = false;
    };
  }, [patched]);

  const save = async () => {
    if (!workflowId) return;
    setSaving(true);
    setMsg(null);
    try {
      const r = await api.post<{ version: number }>(`/workflows/${workflowId}/versions`, { ir: patched });
      setBase(patched);
      setAnswers({});
      setMsg({ kind: "ok", text: `已保存为 v${r.version}，下次导出不用再填` });
      onSaved?.(r.version);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message || "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const form =
    gaps.length > 0 || msg ? (
      <section className="ep-gaps" aria-label="补充信息">
        {gaps.length > 0 && (
          <>
            <div className="ep-gaps-h">
              <b>补充后再导出</b>
              <span className="muted">不填也可以导出，AI 会在对话开始时向用户询问。</span>
            </div>
            {gaps.map((g) => (
              <label key={g.nodeId} className="ep-gap">
                <span>{g.question}</span>
                <textarea
                  rows={2}
                  value={answers[g.nodeId] ?? ""}
                  placeholder={g.kind === "criteria" ? "例如：订单状态为 abnormal，或金额超过 1 万" : "例如：三段：本周销售额、环比、Top 3 客户"}
                  onChange={(e) => setAnswers((a) => ({ ...a, [g.nodeId]: e.target.value }))}
                />
              </label>
            ))}
            {workflowId && (
              <div className="ep-gap-actions">
                <button className="btn btn-line" disabled={!filled || saving} onClick={save}>
                  {saving ? "保存中…" : "保存为新版本"}
                </button>
              </div>
            )}
          </>
        )}
        {msg && <div className={msg.kind === "err" ? "notice-error" : "muted"}>{msg.text}</div>}
      </section>
    ) : null;

  return (
    <ExportPreview
      top={form}
      spec={{
        title: "对话提示词预览",
        files,
        notes: meta.notes,
        downloadLabel: "下载 .zip",
        onDownload: async () => ex.download(await ex.zipFiles(files), meta.filename),
      }}
      onClose={onClose}
    />
  );
}
