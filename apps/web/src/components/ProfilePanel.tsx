import { FREQ_LABEL, rankPainPoints, type PainPoint, type Profile } from "../lib/types";
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
  const ranked = rankPainPoints(profile.painPoints);
  const taskTitle = (id?: string) => profile.tasks.find((t) => t.id === id)?.title;
  return (
    <div className="profile">
      <div className="card pcard">
        <h3>基本信息</h3>
        <dl className="kv">
          <dt>岗位</dt><dd>{profile.role.role || <span className="muted">还没有记录</span>}</dd>
          <dt>团队</dt><dd>{profile.role.team || <span className="muted">—</span>}</dd>
          <dt>常用系统</dt>
          <dd>{profile.role.systems.length ? profile.role.systems.map((s) => <span key={s} className="tag">{s}</span>) : <span className="muted">—</span>}</dd>
          {profile.role.summary && (<><dt>概括</dt><dd style={{ color: "var(--ink-2)" }}>{profile.role.summary}</dd></>)}
        </dl>
      </div>

      <div className="card pcard">
        <h3>工作清单<span>{profile.tasks.length} 项</span></h3>
        {profile.tasks.length === 0 && <div className="empty">还没有记录的工作。</div>}
        {profile.tasks.length > 0 && (
          <table className="tasks">
            <thead><tr><th>工作</th><th>频率</th><th className="num">单次耗时</th></tr></thead>
            <tbody>
              {profile.tasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td>{FREQ_LABEL[t.frequency]}</td>
                  <td className="num">{t.minutesPerRun !== undefined ? `${t.minutesPerRun} min` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card pcard wide">
        <h3>痛点<span>按 频率 × 耗时 × 痛苦程度 × 可自动化程度 排序</span></h3>
        {ranked.length === 0 && <div className="empty">还没有记录的痛点。</div>}
        {ranked.map((p, i) => (
          <div className="pain" key={p.id}>
            <div className="rank">{i + 1}</div>
            <div>
              <b>{p.title}</b>
              <div className="ev">{taskTitle(p.taskId) ? `所属工作：${taskTitle(p.taskId)}` : ""}{p.evidence ? `　“${p.evidence}”` : ""}</div>
            </div>
            <div className="scores">
              <label className="muted">
                痛苦程度
                <Select
                  ariaLabel="痛苦程度"
                  style={{ marginLeft: 6 }}
                  value={p.severity}
                  disabled={readOnly}
                  options={SCORE_OPTIONS}
                  onChange={(v) => onPatchPain(p.id, { severity: v })}
                />
              </label>
              <label className="muted" style={{ display: "block", marginTop: 6 }}>
                可自动化
                <Select
                  ariaLabel="可自动化程度"
                  style={{ marginLeft: 6 }}
                  value={p.automatable}
                  disabled={readOnly}
                  options={SCORE_OPTIONS}
                  onChange={(v) => onPatchPain(p.id, { automatable: v })}
                />
              </label>
            </div>
            <div className="prio">
              <span className="v">{p.score === null ? "—" : p.score}</span>
              <small>优先级</small>
            </div>
          </div>
        ))}
        {!readOnly && ranked.length > 0 && <div className="muted" style={{ marginTop: 10 }}>修改评分后优先级会自动重算，AI 顾问在下一轮对话中会看到这些变化。</div>}
      </div>
    </div>
  );
}
