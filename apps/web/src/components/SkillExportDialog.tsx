import { useEffect, useMemo, useRef, useState } from "react";
import type { ExportFile, WorkflowIR } from "@aif/workflow-ir";
import { api, ApiError } from "../lib/api";
import * as ex from "../lib/exporters";
import { exportSkill, type SkillExportResult, type SkillStage } from "../lib/skillExport";
import { ExportPreview } from "./ExportPreview";
import { GapsForm } from "./GapsForm";
import { useI18n } from "../i18n";

const STAGES: SkillStage[] = ["analyze", "write", "validate"];

interface Shown {
  files: ExportFile[];
  filename: string;
  notes: string[];
}

/**
 * 导出 Agent Skill：弹窗里完成，不跳页面。
 * 有缺口（判断标准、模板）时先让用户补充；然后由服务端让模型撰写并校验，完成后预览文件、下载 zip。
 * 服务端没有启用（503）或没有 workflowId 时直接用浏览器内的基础版本；其他失败可以重试，也可以改用基础版本。
 */
export function SkillExportDialog({
  ir,
  workflowId,
  version,
  onSaved,
  onClose,
}: {
  ir: WorkflowIR;
  workflowId?: string;
  version?: number;
  onSaved?: (version: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // 以打开时的版本为基准；保存为新版本后换成已保存的内容，表单随之清空
  const [base, setBase] = useState(ir);
  const [curVersion, setCurVersion] = useState(version);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<SkillStage | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(false);

  const gaps = useMemo(() => ex.promptGaps(base), [base]);
  const filled = useMemo(() => Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim())), [answers]);
  const hasAnswers = Object.keys(filled).length > 0;
  const running = stage !== null;

  // 卸载时取消请求，并允许重新挂载后再次自动开始（开发模式的 StrictMode 会先卸载再挂载一次）
  useEffect(
    () => () => {
      abort.current?.abort();
      started.current = false;
    },
    [],
  );

  /** 浏览器内的基础版本：不经过模型 */
  const basic = async (reason?: string) => {
    setErr("");
    setStage("analyze");
    try {
      const s = await ex.buildSkill(ex.applyPromptAnswers(base, filled), { target: "generic", packaging: "zip" });
      setShown({
        files: s.files,
        filename: s.filename,
        notes: [...(reason ? [reason] : []), ...s.warnings.map((w) => t("exp.warn", { w }))],
      });
    } catch (e) {
      setStage(null);
      setErr((e as Error).message || t("skillExport.failed"));
    }
  };

  const fromServer = (r: SkillExportResult): Shown => ({
    files: r.files,
    filename: r.filename,
    notes: [
      ...(r.fallback ? [t("skillExport.fallback", { reason: r.fallbackReason ?? "" })] : []),
      ...r.issues.map((i) => t("exp.warn", { w: ex.issueText(i) })),
      ...r.warnings.map((w) => t("exp.warn", { w })),
      ...r.todo.map((x) => t("skillExport.todo", { x })),
    ],
  });

  const start = async () => {
    setErr("");
    if (!workflowId) return basic(t("skillExport.localFallback"));
    setStage("analyze");
    abort.current = new AbortController();
    try {
      const r = await exportSkill(
        workflowId,
        { ...(curVersion ? { version: curVersion } : {}), target: "generic", packaging: "zip", ...(hasAnswers ? { answers: filled } : {}) },
        setStage,
        abort.current.signal,
      );
      setShown(fromServer(r));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // 服务端没有启用模型：不打扰用户，直接给基础版本
      if (e instanceof ApiError && e.status === 503) return basic(t("skillExport.localFallback"));
      setStage(null);
      setErr((e as Error).message || t("skillExport.failed"));
    }
  };

  // 没有需要补充的内容时直接开始
  useEffect(() => {
    if (started.current || gaps.length > 0) return;
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!workflowId) return;
    setSaving(true);
    setMsg(null);
    try {
      const patched = ex.applyPromptAnswers(base, filled);
      const r = await api.post<{ version: number }>(`/workflows/${workflowId}/versions`, { ir: patched });
      setBase(patched);
      setAnswers({});
      setCurVersion(r.version);
      setMsg({ kind: "ok", text: t("exp.saved", { v: r.version }) });
      onSaved?.(r.version);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message || t("exp.saveFail") });
    } finally {
      setSaving(false);
    }
  };

  /** 生成进行中关掉弹窗会取消生成（服务端随之停止），先确认 */
  const close = () => {
    if (running && !shown && !window.confirm(t("skillExport.confirmClose"))) return;
    onClose();
  };

  if (shown) {
    return (
      <ExportPreview
        spec={{
          title: t("exp.skillPreview"),
          files: shown.files,
          notes: shown.notes,
          downloadLabel: t("exp.downloadZip"),
          onDownload: async () => ex.download(await ex.zipFiles(shown.files), shown.filename),
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="modal-back" onClick={() => !running && onClose()}>
      <div className="card modal n8n-export" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("skillExport.title")}>
        <button className="x" onClick={close} aria-label={t("common.close")}>✕</button>
        <h2>{t("skillExport.title")}</h2>
        <div className="n8n-export-start">
          {!running && (
            <>
              <p className="muted">{t("skillExport.intro")}</p>
              <GapsForm
                gaps={gaps}
                answers={answers}
                onChange={(id, v) => setAnswers((a) => ({ ...a, [id]: v }))}
                hint={t("skillExport.gapsHint")}
                onSave={workflowId ? save : undefined}
                canSave={hasAnswers}
                saving={saving}
                msg={msg}
              />
              <button className="btn btn-ink" onClick={start}>{err ? t("skillExport.retry") : t("skillExport.start")}</button>
              {err && <button className="btn btn-line" onClick={() => basic()}>{t("skillExport.useBasic")}</button>}
            </>
          )}
          {running && (
            <ol className="n8n-export-steps" aria-label={t("skillExport.progress")}>
              {STAGES.map((s, i) => {
                const at = STAGES.indexOf(stage!);
                return <li key={s} className={i < at ? "done" : i === at ? "now" : ""}>{t(`skillExport.stage.${s}`)}</li>;
              })}
            </ol>
          )}
        </div>
        {err && <div className="notice-error" style={{ marginTop: 14 }} role="alert">{err}</div>}
      </div>
    </div>
  );
}
