import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { WorkflowIR } from "@aif/workflow-ir";
import { api, ApiError } from "../lib/api";
import { Topbar } from "../components/Topbar";
import { CanvasView, useScene } from "../components/CanvasView";
import { stageLabels } from "../lib/types";
import { useI18n } from "../i18n";

interface SharedView {
  name: string;
  owner: string;
  version: number;
  latestVersion: number;
  updatedAt: string;
  visibility: "internal" | "public";
  ir: WorkflowIR;
  painPoints?: Array<{ id: string; title: string; detail: string; severity: number; automatable: number; score: number | null }>;
  canFork: boolean;
}

export default function SharePage() {
  const { t } = useI18n();
  const { token = "" } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<SharedView | null>(null);
  const [error, setError] = useState("");
  const [forking, setForking] = useState(false);
  const scene = useScene(data?.ir ?? null);

  useEffect(() => {
    api.get<SharedView>(`/s/${token}`)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : t("share.loadFailed")));
  }, [token]);

  const fork = async () => {
    setForking(true);
    try {
      const r = await api.post<{ conversationId: string }>(`/s/${token}/fork`);
      nav(`/c/${r.conversationId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("share.forkFailed"));
      setForking(false);
    }
  };

  return (
    <div className="page">
      <Topbar showUser />
      {error && (
        <div style={{ padding: 40 }}>
          <div className="notice-error">{error}</div>
          <p style={{ marginTop: 16 }}><Link to="/">{t("common.backHome")}</Link></p>
        </div>
      )}
      {data && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 24px", borderBottom: "1px solid var(--line)", background: "var(--sheet)" }}>
            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
              <b className="serif" style={{ fontSize: 16 }}>{data.name}</b>
              <span className="muted">{t("share.sharedBy", { owner: data.owner, version: data.version, locked: data.version < data.latestVersion ? t("share.lockedOld") : "", date: new Date(data.updatedAt).toLocaleDateString(t("home.dateLocale")), vis: data.visibility === "public" ? t("share.visPublic") : t("share.visInternal") })}</span>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
              {data.canFork ? (
                <button className="btn btn-ink" onClick={fork} disabled={forking}>{forking ? t("share.forking") : t("share.fork")}</button>
              ) : (
                <Link className="btn btn-line" to={`/login?redirect=${encodeURIComponent(`/s/${token}`)}`}>{t("share.loginToFork")}</Link>
              )}
            </div>
          </div>
          <div className="share-body">
            <div className="share-canvas">
              <CanvasView scene={scene.scene} loading={scene.loading} error={scene.error} readOnly />
              <div className="ro-banner">{t("share.readOnly")}</div>
            </div>
            <aside className="share-side">
              <div className="card">
                <h3>{t("share.about")}</h3>
                <p>{data.ir.description}</p>
                <dl className="facts">
                  <dt>{t("share.trigger")}</dt><dd>{data.ir.trigger.detail}</dd>
                  <dt>{t("share.steps")}</dt><dd>{t("share.stepCount", { n: data.ir.nodes.filter((n) => n.type === "step").length })}</dd>
                </dl>
              </div>
              {data.painPoints && data.painPoints.length > 0 && (
                <div className="card">
                  <h3>{t("share.painPoints")}</h3>
                  {data.painPoints.map((p) => (
                    <div key={p.id} style={{ marginTop: 8 }}>
                      <b>{p.title}</b>
                      <div className="muted">{p.detail}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="card">
                <h3>{t("share.flowNotes")}</h3>
                {data.ir.nodes.filter((n) => n.type === "step").map((n) => (
                  <div key={n.id} style={{ marginTop: 10 }}>
                    <span className={`dot ${n.executor === "deterministic" ? "det" : n.executor === "llm" ? "llm" : "hum"}`} />{" "}
                    <b>{n.title}</b>
                    <div className="muted" style={{ marginLeft: 16 }}>{n.instructions}</div>
                  </div>
                ))}
              </div>
              <div className="muted">{stageLabels().length ? t("share.forkHint") : ""}</div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
