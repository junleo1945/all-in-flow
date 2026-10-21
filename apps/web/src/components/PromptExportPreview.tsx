import { useEffect, useMemo, useState } from "react";
import type { WorkflowIR } from "@aif/workflow-ir";
import { api } from "../lib/api";
import * as ex from "../lib/exporters";
import { ExportPreview, type PreviewFile } from "./ExportPreview";
import { useI18n } from "../i18n";
import { Select } from "./ui/Select";

/** 常见的聊天 AI：不同的 AI 长期使用的地方不一样，说明也不同 */
const AIS = ["chatgpt", "doubao", "deepseek", "claude", "gemini", "other"] as const;
type Ai = (typeof AIS)[number];
const AI_KEY = "aif-prompt-ai";

function readAi(): Ai {
  try {
    const v = localStorage.getItem(AI_KEY);
    if (v && (AIS as readonly string[]).includes(v)) return v as Ai;
  } catch {
    /* 读不到就用默认 */
  }
  return "chatgpt";
}

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
  // 用户只需要选「怎么用」，不需要知道背后是两个文件
  const [variant, setVariant] = useState<"full" | "short">("full");
  const [ai, setAi] = useState<Ai>(readAi);
  const [notes, setNotes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const gaps = useMemo(() => ex.promptGaps(base), [base]);
  const patched = useMemo(() => ex.applyPromptAnswers(base, answers), [base, answers]);
  const prep = useMemo(() => ex.promptPrep(patched), [patched]);
  const filled = Object.values(answers).some((v) => v.trim());

  useEffect(() => {
    let live = true;
    ex.exportPrompt(patched)
      .then((r) => {
        if (!live) return;
        setFiles(r.files);
        setNotes([
          ...r.requirements.map((q) => t("exp.reqUse", { q })),
          ...r.warnings.map((w) => t("exp.warn", { w })),
        ]);
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

  const pickAi = (v: Ai) => {
    setAi(v);
    try {
      localStorage.setItem(AI_KEY, v);
    } catch {
      /* 无法保存时只在本次生效 */
    }
  };
  // 使用说明按用户用的 AI 变化
  const howTo = [t("exp.pNote", { ai: t(`exp.ai.${ai}`) }), t(`exp.tip.${ai}`)];
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const shown = files.filter((f) => f.path.endsWith(variant === "short" ? ".prompt-short.md" : ".prompt.md"));
  const switcher = (
    <div className="ep-variants" role="group" aria-label={t("exp.varLabel")}>
      <span className="muted">{t("exp.varLabel")}</span>
      <div className="seg">
        <button type="button" className={variant === "full" ? "on" : ""} aria-pressed={variant === "full"} onClick={() => setVariant("full")}>
          {t("exp.varFull")}
        </button>
        <button type="button" className={variant === "short" ? "on" : ""} aria-pressed={variant === "short"} onClick={() => setVariant("short")}>
          {t("exp.varShort")}
        </button>
      </div>
    </div>
  );

  const aiPicker = (
    <div className="ep-variants">
      <span className="muted">{t("exp.aiLabel")}</span>
      <Select ariaLabel={t("exp.aiLabel")} value={ai} options={AIS.map((a) => ({ value: a, label: t(`exp.ai.${a}`) }))} onChange={pickAi} />
    </div>
  );

  const prepItems = [...prep.inputs, ...prep.materials];
  const prepList =
    prepItems.length > 0 ? (
      <section className="ep-prep" aria-label={t("exp.prepTitle")}>
        <b>{t("exp.prepTitle")}</b>
        <span className="muted">{t("exp.prepHint")}</span>
        <ul>
          {prepItems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </section>
    ) : null;

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
      top={<>{aiPicker}{switcher}{prepList}{form}</>}
      spec={{
        title: t("exp.promptPreview"),
        files: shown,
        notes: [...howTo, ...notes],
        copyPrimary: true,
        hidePath: true,
        renderDoc: true,
        downloadLabel: t("exp.downloadTxt"),
        onShare: canShare ? () => navigator.share({ title: patched.name, text: typeof shown[0]?.content === "string" ? shown[0].content : "" }) : undefined,
        // 下载的是当前选中的这一份，纯文本，任何电脑都能直接打开
        onDownload: () => {
          const f = shown[0];
          if (f && typeof f.content === "string") ex.download(new Blob([f.content], { type: "text/plain;charset=utf-8" }), f.path.replace(/\.md$/, ".txt"));
        },
      }}
      onClose={onClose}
    />
  );
}
