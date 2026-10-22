import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { Topbar } from "../components/Topbar";
import { formatTokens, useMe } from "../lib/useMe";
import { stageLabels } from "../lib/types";
import { displayTitle, useI18n } from "../i18n";

interface ConvItem { id: string; title: string; stage: string; updatedAt: string }
interface WfItem { id: string; name: string; latestVersion: number; conversationId: string; updatedAt: string }
interface ShareItem { id: string; token: string; workflowName: string; version: number | null; visibility: string; expiresAt: string | null; revokedAt: string | null; viewCount: number; url: string }

// 场景文案随语言变化，必须在渲染时构建
function buildScenarios(t: (key: string) => string) {
  return [
    { role: t("home.scenario.general"), title: t("home.scenario.generalTitle"), desc: t("home.scenario.generalDesc"), prompt: t("home.scenario.generalPrompt") },
    { role: t("home.scenario.sales"), title: t("home.scenario.salesTitle"), desc: t("home.scenario.salesDesc"), prompt: t("home.scenario.salesPrompt") },
    { role: t("home.scenario.finance"), title: t("home.scenario.financeTitle"), desc: t("home.scenario.financeDesc"), prompt: t("home.scenario.financePrompt") },
    { role: t("home.scenario.hr"), title: t("home.scenario.hrTitle"), desc: t("home.scenario.hrDesc"), prompt: t("home.scenario.hrPrompt") },
  ];
}

export default function HomePage() {
  const nav = useNavigate();
  const { t } = useI18n();
  const SCENARIOS = buildScenarios(t);
  const { me } = useMe();
  const [text, setText] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  const [convs, setConvs] = useState<ConvItem[]>([]);
  const [wfs, setWfs] = useState<WfItem[]>([]);
  const [shares, setShares] = useState<ShareItem[]>([]);
  const focusRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.get<ConvItem[]>("/conversations").then(setConvs).catch(() => {});
    api.get<WfItem[]>("/workflows").then(setWfs).catch(() => {});
    api.get<ShareItem[]>("/shares").then(setShares).catch(() => {});
  }, []);

  const start = async () => {
    if (!text.trim() || creating) return;
    setCreating(true);
    setErr("");
    try {
      const conv = await api.post<{ id: string }>("/conversations");
      nav(`/c/${conv.id}`, { state: { initial: text.trim() } });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("home.createFailed"));
      setCreating(false);
    }
  };

  const activeShares = shares.filter((s) => !s.revokedAt);
  const pct = me ? Math.min(100, (me.usage.tokensToday / me.usage.dailyTokenQuota) * 100) : 0;

  return (
    <div className="page">
      <Topbar />
      <div className="home">
        <div>
          <div className="greet">
            {me ? t("home.hello", { name: me.DisplayName }) : t("home.helloAnon")}
            <small>{t("home.greetSub")}</small>
          </div>

          <div className="card starter">
            <textarea
              ref={focusRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("home.placeholder")}
              aria-label={t("home.describeWork")}
            />
            <div className="starter-foot">
              <span className="muted" style={{ marginRight: 4 }}>{t("home.orScenario")}</span>
              {SCENARIOS.map((s) => (
                <button key={s.title} className="chip" onClick={() => { setText(s.prompt); focusRef.current?.focus(); }}>{s.role}</button>
              ))}
              <button className="btn btn-ink" style={{ marginLeft: "auto" }} onClick={start} disabled={!text.trim() || creating}>
                {creating ? t("home.creating") : t("home.start")}
              </button>
            </div>
            {err && <div className="notice-error" style={{ marginTop: 10 }}>{err}</div>}
          </div>

          <div className="sec-title"><h3>{t("home.commonScenarios")}</h3><span>{t("home.commonScenariosHint")}</span></div>
          <div className="convs scenarios">
            {SCENARIOS.map((s) => (
              <button key={s.title} className="card conv" onClick={() => { setText(s.prompt); focusRef.current?.focus(); }}>
                <div className="body">
                  <span className="tag" style={{ float: "right" }}>{s.role}</span>
                  <h4>{s.title}</h4>
                  <div className="muted" style={{ marginTop: 4 }}>{s.desc}</div>
                </div>
              </button>
            ))}
          </div>

          <div className="sec-title"><h3>{t("home.recent")}</h3><span>{t("home.total", { n: convs.length })}</span></div>
          {convs.length === 0 && <div className="empty">{t("home.noConvs")}</div>}
          <div className="convs">
            {convs.slice(0, 6).map((c) => {
              const idx = stageLabels().findIndex((s) => s.key === c.stage);
              return (
                <button key={c.id} className="card conv" onClick={() => nav(`/c/${c.id}`)}>
                  <div className="body">
                    <h4>{displayTitle(c.title)}</h4>
                    <div className="meta"><span>{new Date(c.updatedAt).toLocaleString(t("home.dateLocale"), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
                    <div className="muted" style={{ marginTop: 10 }}>{idx >= 0 ? `${idx + 1}. ${stageLabels()[idx]!.label}` : t("home.justStarted")}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <aside>
          <div className="card side-card">
            <h3>{t("home.usageToday")}</h3>
            <div className="big-num">
              {formatTokens(me?.usage.tokensToday ?? 0)}
              <small> / {formatTokens(me?.usage.dailyTokenQuota ?? 0)}{t("home.tokenSuffix")}</small>
            </div>
            <div className="bar"><i style={{ width: `${pct}%` }} /></div>
            <div className="muted" style={{ marginTop: 8 }}>{t("home.resetDaily")}</div>
          </div>
          <div className="card side-card">
            <h3>{t("skill.homeCardTitle")}</h3>
            <div className="muted" style={{ marginBottom: 10 }}>{t("skill.homeCardDesc")}</div>
            <button type="button" className="btn btn-line" onClick={() => nav("/skill")}>{t("skill.homeCardOpen")}</button>
          </div>
          <div className="card side-card">
            <h3>{t("home.myWorkflows")}</h3>
            {wfs.length === 0 && <div className="empty" style={{ padding: 0 }}>{t("home.noWorkflows")}</div>}
            <ul className="list">
              {wfs.slice(0, 5).map((w) => (
                <li key={w.id}>
                  <span className="dot det" />
                  <div className="grow">
                    <div>{w.name}</div>
                    <div className="s">v{w.latestVersion}</div>
                  </div>
                  <button className="act" onClick={() => nav(`/c/${w.conversationId}`)}>{t("home.open")}</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="card side-card">
            <h3>{t("home.myShares")}</h3>
            {activeShares.length === 0 && <div className="empty" style={{ padding: 0 }}>{t("home.noShares")}</div>}
            <ul className="list">
              {activeShares.slice(0, 5).map((s) => (
                <li key={s.id}>
                  <div className="grow">
                    <div>{s.workflowName}{s.version ? ` · v${s.version}` : t("home.latest")}</div>
                    <div className="s">{s.visibility === "public" ? t("home.public") : t("home.internal")} · {t("home.views", { n: s.viewCount })}</div>
                  </div>
                  <button className="act" onClick={() => void navigator.clipboard?.writeText(s.url)}>{t("home.copyLink")}</button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
