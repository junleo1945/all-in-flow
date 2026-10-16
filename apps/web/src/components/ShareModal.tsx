import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
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
      setErr(e instanceof ApiError ? e.message : t("shareModal.createFailed"));
    }
  };

  const revoke = async (id: string) => {
    await api.delete(`/shares/${id}`).catch(() => {});
    void loadExisting();
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("shareModal.dialog")}>
        <button className="x" onClick={onClose} aria-label={t("common.close")}>✕</button>
        <h2>{t("shareModal.title")}</h2>
        <div className="muted" style={{ marginTop: 2 }}>{t("shareModal.subtitle", { name: workflowName })}</div>

        <div className="mrow">
          <label>{t("shareModal.whichVersion")}</label>
          <div className="seg">
            <button className={lockVersion ? "on" : ""} onClick={() => setLockVersion(true)}>{t("shareModal.lock", { v: selectedVersion })}</button>
            <button className={!lockVersion ? "on" : ""} onClick={() => setLockVersion(false)}>{t("shareModal.latest", { v: latestVersion })}</button>
          </div>
        </div>

        <div className="mrow">
          <label>{t("shareModal.whoCanView")}</label>
          <div className="vis">
            <button className={`o ${visibility === "internal" ? "sel" : ""}`} onClick={() => setVisibility("internal")}>
              <b>{t("shareModal.internal")}</b><span>{t("shareModal.internalDesc")}</span>
            </button>
            <button className={`o ${visibility === "public" ? "sel" : ""}`} disabled={!allowPublic} onClick={() => setVisibility("public")}>
              <b>{t("shareModal.anyone")}</b><span>{allowPublic ? t("shareModal.anyoneDesc") : t("shareModal.publicOff")}</span>
            </button>
          </div>
        </div>

        <div className="mrow">
          <label>{t("shareModal.expiry")}</label>
          <div className="seg">
            {([7, 30, null] as const).map((d) => (
              <button key={String(d)} className={expires === d ? "on" : ""} onClick={() => setExpires(d)}>{d ? t("shareModal.days", { n: d }) : t("shareModal.forever")}</button>
            ))}
          </div>
        </div>

        <label className="check">
          <input type="checkbox" checked={withPain} onChange={(e) => setWithPain(e.target.checked)} />
          {t("shareModal.withPain")}
        </label>

        {err && <div className="notice-error" style={{ marginTop: 14 }}>{err}</div>}
        <div className="linkbox">
          <input readOnly value={created || t("shareModal.linkPlaceholder")} onFocus={(e) => e.currentTarget.select()} aria-label={t("shareModal.linkLabel")} />
          <button className="btn btn-ink" disabled={!!created} onClick={create}>{created ? t("shareModal.created") : t("shareModal.generate")}</button>
          {created && <button className="btn btn-line" onClick={() => void navigator.clipboard?.writeText(created)}>{t("shareModal.copy")}</button>}
        </div>

        <div className="existing">
          <div className="h">{t("shareModal.existing")}</div>
          {existing.length === 0 && <div className="muted">{t("shareModal.noneYet")}</div>}
          {existing.map((s) => (
            <div className="ex-row" key={s.id}>
              <span className="st">{t("shareModal.active")}</span>
              <span>{s.version ? `v${s.version}` : t("shareModal.latestShort")} · {s.visibility === "public" ? t("shareModal.public") : t("shareModal.internalShort")} · {s.expiresAt ? t("shareModal.until", { date: new Date(s.expiresAt).toLocaleDateString(t("home.dateLocale")) }) : t("shareModal.forever")}</span>
              <span className="muted mono">{t("shareModal.views", { n: s.viewCount })}</span>
              <button className="btn-danger" onClick={() => revoke(s.id)}>{t("shareModal.revoke")}</button>
            </div>
          ))}
        </div>
        <div className="muted" style={{ marginTop: 14 }}>{t("shareModal.noChat")}</div>
      </div>
    </div>
  );
}
