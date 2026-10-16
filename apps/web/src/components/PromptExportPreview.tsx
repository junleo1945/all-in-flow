import { useEffect, useMemo, useState } from "react";
import type { WorkflowIR } from "@aif/workflow-ir";
import { api } from "../lib/api";
import * as ex from "../lib/exporters";
import { ExportPreview, type PreviewFile } from "./ExportPreview";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
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
            t("exp.pNote"),
            ...r.requirements.map((q) => t("exp.reqUse", { q })),
            ...r.warnings.map((w) => t("exp.warn", { w })),
          ],
        });
      })
      .catch((e: Error) => live && setMsg({ kind: "err", text: e.message || t("exp.genFail") }));
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
      setMsg({ kind: "ok", text: t("exp.saved", { v: r.version }) });
      onSaved?.(r.version);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message || t("exp.saveFail") });
    } finally {
      setSaving(false);
    }
  };

  const form =
    gaps.length > 0 || msg ? (
      <section className="ep-gaps" aria-label={t("exp.gapsLabel")}>
        {gaps.length > 0 && (
          <>
            <div className="ep-gaps-h">
              <b>{t("exp.gapsTitle")}</b>
              <span className="muted">{t("exp.gapsHint")}</span>
            </div>
            {gaps.map((g) => (
              <label key={g.nodeId} className="ep-gap">
                <span>{g.question}</span>
                <textarea
                  rows={2}
                  value={answers[g.nodeId] ?? ""}
                  placeholder={g.kind === "criteria" ? t("exp.phCriteria") : t("exp.phTemplate")}
                  onChange={(e) => setAnswers((a) => ({ ...a, [g.nodeId]: e.target.value }))}
                />
              </label>
            ))}
            {workflowId && (
              <div className="ep-gap-actions">
                <button className="btn btn-line" disabled={!filled || saving} onClick={save}>
                  {saving ? t("exp.saving") : t("exp.saveNew")}
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
        title: t("exp.promptPreview"),
        files,
        notes: meta.notes,
        downloadLabel: t("exp.downloadZip"),
        onDownload: async () => ex.download(await ex.zipFiles(files), meta.filename),
      }}
      onClose={onClose}
    />
  );
}
