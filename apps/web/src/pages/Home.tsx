import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { Topbar } from "../components/Topbar";
import { formatTokens, useMe } from "../lib/useMe";
import { STAGE_LABELS } from "../lib/types";

interface ConvItem { id: string; title: string; stage: string; updatedAt: string }
interface WfItem { id: string; name: string; latestVersion: number; conversationId: string; updatedAt: string }
interface ShareItem { id: string; token: string; workflowName: string; version: number | null; visibility: string; expiresAt: string | null; revokedAt: string | null; viewCount: number; url: string }

const SCENARIOS = [
  { role: "通用", title: "周报 / 日报汇总", desc: "从多个系统收集数据写报告", prompt: "我每周都要从几个系统收集数据写周报，" },
  { role: "销售", title: "订单异常跟进", desc: "发现异常、找人核对、跟进结果", prompt: "我们每周要处理一批异常订单，" },
  { role: "财务", title: "报销单据核对", desc: "票据、金额、审批信息逐一比对", prompt: "每个月报销单据要逐一核对票据和金额，" },
  { role: "人事", title: "简历初筛", desc: "按岗位要求筛选并通知面试", prompt: "招聘时要先筛选大量简历，" },
];

export default function HomePage() {
  const nav = useNavigate();
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
      setErr(e instanceof ApiError ? e.message : "创建失败，请稍后再试");
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
            {me ? `你好，${me.DisplayName}` : "你好"}
            <small>今天想聊聊哪件让你头疼的工作？</small>
          </div>

          <div className="card starter">
            <textarea
              ref={focusRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="比如：每周五下午都在做销售周报，要从 ERP 导数据、在 Excel 里透视，再挨个问销售异常单……"
              aria-label="描述你的工作"
            />
            <div className="starter-foot">
              <span className="muted" style={{ marginRight: 4 }}>或者按场景开始：</span>
              {SCENARIOS.map((s) => (
                <button key={s.title} className="chip" onClick={() => { setText(s.prompt); focusRef.current?.focus(); }}>{s.role}</button>
              ))}
              <button className="btn btn-ink" style={{ marginLeft: "auto" }} onClick={start} disabled={!text.trim() || creating}>
                {creating ? "创建中…" : "开始访谈 →"}
              </button>
            </div>
            {err && <div className="notice-error" style={{ marginTop: 10 }}>{err}</div>}
          </div>

          <div className="sec-title"><h3>从常见场景开始</h3><span>AI 顾问会带着这个场景的背景向你提问</span></div>
          <div className="convs" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
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

          <div className="sec-title"><h3>最近的访谈</h3><span>共 {convs.length} 个</span></div>
          {convs.length === 0 && <div className="empty">还没有访谈，从上面开始一个吧。</div>}
          <div className="convs">
            {convs.slice(0, 6).map((c) => {
              const idx = STAGE_LABELS.findIndex((s) => s.key === c.stage);
              return (
                <button key={c.id} className="card conv" onClick={() => nav(`/c/${c.id}`)}>
                  <div className="body">
                    <h4>{c.title}</h4>
                    <div className="meta"><span>{new Date(c.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
                    <div className="muted" style={{ marginTop: 10 }}>{idx >= 0 ? `${idx + 1}. ${STAGE_LABELS[idx]!.label}` : "刚开始"}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <aside>
          <div className="card side-card">
            <h3>今日用量</h3>
            <div className="big-num">
              {formatTokens(me?.usage.tokensToday ?? 0)}
              <small> / {formatTokens(me?.usage.dailyTokenQuota ?? 0)} token</small>
            </div>
            <div className="bar"><i style={{ width: `${pct}%` }} /></div>
            <div className="muted" style={{ marginTop: 8 }}>每天 0 点重置</div>
          </div>
          <div className="card side-card">
            <h3>我的工作流</h3>
            {wfs.length === 0 && <div className="empty" style={{ padding: 0 }}>完成一次访谈后，工作流会出现在这里。</div>}
            <ul className="list">
              {wfs.slice(0, 5).map((w) => (
                <li key={w.id}>
                  <span className="dot det" />
                  <div className="grow">
                    <div>{w.name}</div>
                    <div className="s">v{w.latestVersion}</div>
                  </div>
                  <button className="act" onClick={() => nav(`/c/${w.conversationId}`)}>打开</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="card side-card">
            <h3>集成目录</h3>
            <div className="muted" style={{ marginBottom: 10 }}>查看工作流可以连接的外部系统，并测试 MCP 连接。</div>
            <Link to="/integrations" className="btn btn-line" style={{ width: "100%" }}>打开集成目录 →</Link>
          </div>
          <div className="card side-card">
            <h3>我的分享</h3>
            {activeShares.length === 0 && <div className="empty" style={{ padding: 0 }}>分享的工作流会出现在这里。</div>}
            <ul className="list">
              {activeShares.slice(0, 5).map((s) => (
                <li key={s.id}>
                  <div className="grow">
                    <div>{s.workflowName}{s.version ? ` · v${s.version}` : " · 最新"}</div>
                    <div className="s">{s.visibility === "public" ? "公开" : "公司内"} · 访问 {s.viewCount} 次</div>
                  </div>
                  <button className="act" onClick={() => void navigator.clipboard?.writeText(s.url)}>复制链接</button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
