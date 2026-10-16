import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { BrandMark } from "../components/Topbar";
import { useI18n } from "../i18n";

export default function LoginPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const redirect = params.get("redirect") || "/";
  const [name, setName] = useState("");
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // 已经登录（例如 ERP 会话仍然有效）则直接进入
  useEffect(() => {
    api.get("/user/info").then(() => nav(redirect, { replace: true })).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      await api.post("/user/login", { UserName: name, Password: pwd });
      nav(redirect, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("login.failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="login">
        <div className="login-left">
          <div className="brand"><BrandMark />All-in-Flow</div>
          <h1>{t("login.headline1")}<br />{t("login.headline2")}<span className="mark">{t("login.headlineMark")}</span>{t("login.headline3")}</h1>
          <p className="lead">{t("login.lead")}</p>
          <div className="steps">
            <div><b>{t("login.step1")}</b>{t("login.step1Desc")}</div>
            <div><b>{t("login.step2")}</b>{t("login.step2Desc")}</div>
            <div><b>{t("login.step3")}</b>{t("login.step3Desc")}</div>
            <div><b>{t("login.step4")}</b>{t("login.step4Desc")}</div>
          </div>
        </div>
        <div className="login-right">
          <form className="card login-card" onSubmit={submit}>
            <h2>{t("login.title")}</h2>
            <div className="muted" style={{ marginTop: 4 }}>{t("login.subtitle")}</div>
            <div className="field">
              <label htmlFor="u">{t("login.account")}</label>
              <input id="u" className="input" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="p">{t("login.password")}</label>
              <input id="p" className="input" type="password" autoComplete="current-password" value={pwd} onChange={(e) => setPwd(e.target.value)} required />
            </div>
            {err && <div className="notice-error" style={{ marginTop: 16 }}>{err}</div>}
            <button className="btn btn-ink" disabled={loading}>{loading ? t("login.submitting") : t("login.title")}</button>
            <div className="notice">{t("login.notice")}</div>
          </form>
        </div>
      </div>
    </div>
  );
}
