import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { BrandMark } from "../components/Topbar";

export default function LoginPage() {
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
      setErr(e instanceof ApiError ? e.message : "登录失败，请稍后再试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="login">
        <div className="login-left">
          <div className="brand"><BrandMark />All-in-Flow</div>
          <h1>把每天重复的工作，<br />画成<span className="mark">能运行</span>的流程图。</h1>
          <p className="lead">和 AI 顾问聊聊你的日常工作。它会追问细节、找出最耗时的环节，并把能自动化的部分整理成工作流，导出后直接交给你的 Agent 执行。</p>
          <div className="steps">
            <div><b>聊</b>像和同事一样描述你的一天</div>
            <div><b>挖</b>AI 追问出真正的痛点和耗时</div>
            <div><b>画</b>生成一目了然的工作流</div>
            <div><b>用</b>导出 Skill，放进本地 Agent</div>
          </div>
        </div>
        <div className="login-right">
          <form className="card login-card" onSubmit={submit}>
            <h2>登录</h2>
            <div className="muted" style={{ marginTop: 4 }}>使用 ERP 账号登录</div>
            <div className="field">
              <label htmlFor="u">ERP 账号</label>
              <input id="u" className="input" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="p">密码</label>
              <input id="p" className="input" type="password" autoComplete="current-password" value={pwd} onChange={(e) => setPwd(e.target.value)} required />
            </div>
            {err && <div className="notice-error" style={{ marginTop: 16 }}>{err}</div>}
            <button className="btn btn-ink" disabled={loading}>{loading ? "登录中…" : "登录"}</button>
            <div className="notice">访谈内容会发送给第三方大模型处理，请不要输入密码、客户隐私等敏感信息。</div>
          </form>
        </div>
      </div>
    </div>
  );
}
