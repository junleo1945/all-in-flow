import { useI18n } from "../i18n";
import { durationLabel, freqLabel, rankPainPoints, type PainPoint, type Profile } from "../lib/types";
import { Select } from "./ui/Select";

const SCORE_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }));

export function ProfilePanel({
  profile,
  onPatchPain,
  readOnly = false,
}: {
  profile: Profile;
  onPatchPain: (id: string, patch: Partial<Pick<PainPoint, "severity" | "automatable">>) => void;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const ranked = rankPainPoints(profile.painPoints);
  const taskTitle = (id?: string) => profile.tasks.find((x) => x.id === id)?.title;
  return (
    <div className="profile">
      <div className="card pcard">
        <h3>{t("profile.basic")}</h3>
        <dl className="kv">
          <dt>{t("profile.role")}</dt><dd>{profile.role.role || <span className="muted">{t("profile.noRecord")}</span>}</dd>
          <dt>{t("profile.team")}</dt><dd>{profile.role.team || <span className="muted">—</span>}</dd>
          <dt>{t("profile.systems")}</dt>
          <dd>{profile.role.systems.length ? profile.role.systems.map((s) => <span key={s} className="tag">{s}</span>) : <span className="muted">—</span>}</dd>
          {profile.role.summary && (<><dt>{t("profile.summary")}</dt><dd style={{ color: "var(--ink-2)" }}>{profile.role.summary}</dd></>)}
        </dl>
      </div>

      <div className="card pcard">
        <h3>{t("profile.tasks")}<span>{t("profile.taskCount", { n: profile.tasks.length })}</span></h3>
        {profile.tasks.length === 0 && <div className="empty">{t("profile.noTasks")}</div>}
        {profile.tasks.length > 0 && (
          <table className="tasks">
            <thead><tr><th>{t("profile.colTask")}</th><th>{t("profile.colFreq")}</th><th className="num">{t("profile.colDuration")}</th></tr></thead>
            <tbody>
              {profile.tasks.map((task) => (
                <tr key={task.id}>
                  <td>{task.title}</td>
                  <td>{freqLabel(task.frequency)}</td>
                  <td className="num">{durationLabel(task)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card pcard wide">
        <h3>{t("profile.pains")}<span>{t("profile.painsSub")}</span></h3>
        {ranked.length === 0 && <div className="empty">{t("profile.noPains")}</div>}
        {ranked.map((p, i) => (
          <div className="pain" key={p.id}>
            <div className="rank">{i + 1}</div>
            <div>
              <b>{p.title}</b>
              <div className="ev">{taskTitle(p.taskId) ? t("profile.ofTask", { title: taskTitle(p.taskId) ?? "" }) : ""}{p.evidence ? `　“${p.evidence}”` : ""}</div>
            </div>
            <div className="scores">
              <label className="muted">
                {t("profile.severity")}
                <Select
                  ariaLabel={t("profile.severity")}
                  style={{ marginLeft: 6 }}
                  value={p.severity}
                  disabled={readOnly}
                  options={SCORE_OPTIONS}
                  onChange={(v) => onPatchPain(p.id, { severity: v })}
                />
              </label>
              <label className="muted" style={{ display: "block", marginTop: 6 }}>
                {t("profile.automatable")}
                <Select
                  ariaLabel={t("profile.automatableAria")}
                  style={{ marginLeft: 6 }}
                  value={p.automatable}
                  disabled={readOnly}
                  options={SCORE_OPTIONS}
                  onChange={(v) => onPatchPain(p.id, { automatable: v })}
                />
              </label>
            </div>
            <div className="prio">
              <span className="v" title={p.assumed ? t("profile.unquantifiedHint") : undefined}>{p.score === null ? "—" : `${p.assumed ? "≈ " : ""}${p.score}`}</span>
              <small>{p.assumed ? `${t("profile.priority")} · ${t("profile.unquantified")}` : t("profile.priority")}</small>
            </div>
          </div>
        ))}
        {!readOnly && ranked.length > 0 && <div className="muted" style={{ marginTop: 10 }}>{t("profile.recalcHint")}</div>}
      </div>
    </div>
  );
}
