import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";

interface MyShare { id: string; token: string; workflowId: string; workflowName: string; version: number | null; visibility: string; expiresAt: string | null; revokedAt: string | null; viewCount: number; url: string }

export function ShareModal({
  workflowId,
  workflowName,
  selectedVersion,
  latestVersion,
  allowPublic,
  onClose,
}: {
  workflowId: string;
  workflowName: string;
  selectedVersion: number;
  latestVersion: number;
  allowPublic: boolean;
  onClose: () => void;
}) {
  const [lockVersion, setLockVersion] = useState(true);
  const [visibility, setVisibility] = useState<"internal" | "public">("internal");
  const [expires, setExpires] = useState<7 | 30 | null>(30);
  const [withPain, setWithPain] = useState(false);
  const [created, setCreated] = useState<string>("");
  const [err, setErr] = useState("");
  const [existing, setExisting] = useState<MyShare[]>([]);

  const loadExisting = () =>
    api.get<MyShare[]>("/shares").then((list) => setExisting(list.filter((s) => s.workflowId === workflowId && !s.revokedAt))).catch(() => {});

  useEffect(() => {
    void loadExisting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  const create = async () => {
    setErr("");
    try {
      const r = await api.post<{ url: string }>(`/workflows/${workflowId}/shares`, {
        version: lockVersion ? selectedVersion : null,
        visibility,
        expiresInDays: expires,
        includePainPoints: withPain,
      });
      setCreated(r.url);
      void loadExisting();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "创建分享失败");
    }
  };

  const revoke = async (id: string) => {
    await api.delete(`/shares/${id}`).catch(() => {});
    void loadExisting();
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="分享工作流">
        <button className="x" onClick={onClose} aria-label="关闭">✕</button>
        <h2>分享工作流</h2>
        <div className="muted" style={{ marginTop: 2 }}>{workflowName} · 同事打开链接即可查看流程图和每一步的说明</div>

        <div className="mrow">
          <label>分享哪个版本</label>
          <div className="seg">
            <button className={lockVersion ? "on" : ""} onClick={() => setLockVersion(true)}>锁定 v{selectedVersion}</button>
            <button className={!lockVersion ? "on" : ""} onClick={() => setLockVersion(false)}>始终显示最新 v{latestVersion}</button>
          </div>
        </div>

        <div className="mrow">
          <label>谁能看</label>
          <div className="vis">
            <button className={`o ${visibility === "internal" ? "sel" : ""}`} onClick={() => setVisibility("internal")}>
              <b>公司内</b><span>需要用 ERP 账号登录后查看</span>
            </button>
            <button className={`o ${visibility === "public" ? "sel" : ""}`} disabled={!allowPublic} onClick={() => setVisibility("public")}>
              <b>任何拿到链接的人</b><span>{allowPublic ? "任何人都能看到流程中的业务细节" : "管理员未开启公开分享"}</span>
            </button>
          </div>
        </div>

        <div className="mrow">
          <label>有效期</label>
          <div className="seg">
            {([7, 30, null] as const).map((d) => (
              <button key={String(d)} className={expires === d ? "on" : ""} onClick={() => setExpires(d)}>{d ? `${d} 天` : "永久"}</button>
            ))}
          </div>
        </div>

        <label className="check">
          <input type="checkbox" checked={withPain} onChange={(e) => setWithPain(e.target.checked)} />
          同时分享来源痛点摘要（默认不分享）
        </label>

        {err && <div className="notice-error" style={{ marginTop: 14 }}>{err}</div>}
        <div className="linkbox">
          <input readOnly value={created || "创建后显示链接"} onFocus={(e) => e.currentTarget.select()} aria-label="分享链接" />
          <button className="btn btn-ink" disabled={!!created} onClick={create}>{created ? "已创建" : "生成链接"}</button>
          {created && <button className="btn btn-line" onClick={() => void navigator.clipboard?.writeText(created)}>复制</button>}
        </div>

        <div className="existing">
          <div className="h">这个工作流已有的分享</div>
          {existing.length === 0 && <div className="muted">还没有分享。</div>}
          {existing.map((s) => (
            <div className="ex-row" key={s.id}>
              <span className="st">生效中</span>
              <span>{s.version ? `v${s.version}` : "最新"} · {s.visibility === "public" ? "公开" : "公司内"} · {s.expiresAt ? `到 ${new Date(s.expiresAt).toLocaleDateString("zh-CN")}` : "永久"}</span>
              <span className="muted mono">访问 {s.viewCount} 次</span>
              <button className="btn-danger" onClick={() => revoke(s.id)}>撤销</button>
            </div>
          ))}
        </div>
        <div className="muted" style={{ marginTop: 14 }}>对话记录不会被分享。</div>
      </div>
    </div>
  );
}
