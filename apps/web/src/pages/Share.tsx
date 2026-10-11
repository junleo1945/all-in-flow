import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { WorkflowIR } from "@aif/workflow-ir";
import { api, ApiError } from "../lib/api";
import { Topbar } from "../components/Topbar";
import { CanvasView, useScene } from "../components/CanvasView";
import { STAGE_LABELS } from "../lib/types";

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
  const { token = "" } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<SharedView | null>(null);
  const [error, setError] = useState("");
  const [forking, setForking] = useState(false);
  const scene = useScene(data?.ir ?? null);

  useEffect(() => {
    api.get<SharedView>(`/s/${token}`)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "分享加载失败"));
  }, [token]);

  const fork = async () => {
    setForking(true);
    try {
      const r = await api.post<{ conversationId: string }>(`/s/${token}/fork`);
      nav(`/c/${r.conversationId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "复制失败");
      setForking(false);
    }
  };

  return (
    <div className="page">
      <Topbar showUser />
      {error && (
        <div style={{ padding: 40 }}>
          <div className="notice-error">{error}</div>
          <p style={{ marginTop: 16 }}><Link to="/">返回首页</Link></p>
        </div>
      )}
      {data && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 24px", borderBottom: "1px solid var(--line)", background: "var(--sheet)" }}>
            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
              <b className="serif" style={{ fontSize: 16 }}>{data.name}</b>
              <span className="muted">{data.owner} 分享 · v{data.version}{data.version < data.latestVersion ? "（已锁定旧版本）" : ""} · {new Date(data.updatedAt).toLocaleDateString("zh-CN")} 更新 · {data.visibility === "public" ? "任何人可见" : "公司内可见"}</span>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
              {data.canFork ? (
                <button className="btn btn-ink" onClick={fork} disabled={forking}>{forking ? "复制中…" : "复制到我的工作台"}</button>
              ) : (
                <Link className="btn btn-line" to={`/login?redirect=${encodeURIComponent(`/s/${token}`)}`}>登录后复制</Link>
              )}
            </div>
          </div>
          <div className="share-body">
            <div className="share-canvas">
              <CanvasView scene={scene.scene} loading={scene.loading} error={scene.error} readOnly />
              <div className="ro-banner">只读分享 · 点击节点查看说明</div>
            </div>
            <aside className="share-side">
              <div className="card">
                <h3>关于这个工作流</h3>
                <p>{data.ir.description}</p>
                <dl className="facts">
                  <dt>触发方式</dt><dd>{data.ir.trigger.detail}</dd>
                  {data.ir.integrations.length > 0 && (<><dt>前置条件</dt><dd>{data.ir.integrations.map((i) => i.name).join("、")}</dd></>)}
                  <dt>步骤</dt><dd>{data.ir.nodes.filter((n) => n.type === "step").length} 步</dd>
                </dl>
              </div>
              {data.painPoints && data.painPoints.length > 0 && (
                <div className="card">
                  <h3>来源痛点</h3>
                  {data.painPoints.map((p) => (
                    <div key={p.id} style={{ marginTop: 8 }}>
                      <b>{p.title}</b>
                      <div className="muted">{p.detail}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="card">
                <h3>流程说明</h3>
                {data.ir.nodes.filter((n) => n.type === "step").map((n) => (
                  <div key={n.id} style={{ marginTop: 10 }}>
                    <span className={`dot ${n.executor === "deterministic" ? "det" : n.executor === "llm" ? "llm" : "hum"}`} />{" "}
                    <b>{n.title}</b>
                    <div className="muted" style={{ marginLeft: 16 }}>{n.instructions}</div>
                  </div>
                ))}
              </div>
              <div className="muted">{STAGE_LABELS.length ? "复制到工作台后可以继续通过对话修改，并导出为 Skill。" : ""}</div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
