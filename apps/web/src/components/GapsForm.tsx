import type { PromptGap } from "../lib/exporters";
import { useI18n } from "../i18n";

/**
 * 导出前补充信息的表单：判断标准、输出模板。对话提示词和 Agent Skill 两个导出共用。
 * 补充的内容可以保存为工作流的新版本，下次导出就不用再填；不填也能导出。
 */
export function GapsForm({
  gaps,
  answers,
  onChange,
  hint,
  onSave,
  canSave,
  saving,
  msg,
}: {
  gaps: PromptGap[];
  answers: Record<string, string>;
  onChange: (nodeId: string, value: string) => void;
  /** 标题旁的说明：不填会怎样 */
  hint: string;
  /** 没有所属工作流（例如只读场景）时不传，不显示保存按钮 */
  onSave?: () => void;
  canSave?: boolean;
  saving?: boolean;
  msg?: { kind: "ok" | "err"; text: string } | null;
}) {
  const { t } = useI18n();
  if (gaps.length === 0 && !msg) return null;
  return (
    <section className="ep-gaps" aria-label={t("exp.gapsLabel")}>
      {gaps.length > 0 && (
        <>
          <div className="ep-gaps-h">
            <b>{t("exp.gapsTitle")}</b>
            <span className="muted">{hint}</span>
          </div>
          {gaps.map((g) => (
            <label key={g.nodeId} className="ep-gap">
              <span>{g.question}</span>
              <textarea
                rows={2}
                value={answers[g.nodeId] ?? ""}
                placeholder={g.kind === "criteria" ? t("exp.phCriteria") : t("exp.phTemplate")}
                onChange={(e) => onChange(g.nodeId, e.target.value)}
              />
            </label>
          ))}
          {onSave && (
            <div className="ep-gap-actions">
              <button className="btn btn-line" disabled={!canSave || saving} onClick={onSave}>
                {saving ? t("exp.saving") : t("exp.saveNew")}
              </button>
            </div>
          )}
        </>
      )}
      {msg && <div className={msg.kind === "err" ? "notice-error" : "muted"}>{msg.text}</div>}
    </section>
  );
}
