import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { INTEGRATION_CATALOG, type IntegrationEntry } from "@aif/integrations";
import { api, ApiError } from "../lib/api";
import { Topbar } from "../components/Topbar";

interface McpTool {
  name: string;
  description?: string;
}
interface McpTestResult {
  ok: true;
  serverName?: string;
  tools: McpTool[];
}

export default function IntegrationsPage() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<McpTestResult | null>(null);

  const test = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const r = await api.post<McpTestResult>("/integrations/mcp-test", { url: url.trim() });
      setResult(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "测试失败，请稍后再试");
    } finally {
      setBusy(false);
      setUrl(""); // 测试完成后立即清空地址，不在页面上保留
    }
  };

  return (
    <div className="page">
      <Topbar />
      <div className="home" style={{ gridTemplateColumns: "1fr", maxWidth: 820, margin: "0 auto", width: "100%" }}>
        <div>
          <div className="greet">
            集成连接测试
            <small>测试 MCP 服务能否连接，并查看它提供的工具。</small>
          </div>

          <div className="sec-title"><h3>集成目录</h3><span>{INTEGRATION_CATALOG.length} 个</span></div>
          <div className="convs" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {INTEGRATION_CATALOG.map((e) => (
              <CatalogCard key={e.id} entry={e} />
            ))}
          </div>

          <div className="sec-title"><h3>MCP 连接测试</h3><span>只用于本次测试，不保存</span></div>
          <form className="card starter" onSubmit={test}>
            <label htmlFor="mcp-url" className="muted" style={{ display: "block", marginBottom: 8 }}>MCP 服务地址（https）</label>
            <input
              id="mcp-url"
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://…/server/…?key=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <div className="starter-foot">
              <span className="muted">地址只用于本次测试，不会被保存。地址中的 key 属于凭证，请勿分享此页面的截图。</span>
              <button className="btn btn-ink" style={{ marginLeft: "auto" }} disabled={busy || !url.trim()}>
                {busy ? "测试中…" : "测试连接"}
              </button>
            </div>
          </form>

          {error && <div className="notice-error" style={{ marginTop: 16 }}>{error}</div>}

          {result && (
            <div className="card side-card" style={{ marginTop: 16 }}>
              <h3>连接成功{result.serverName ? `：${result.serverName}` : ""}</h3>
              <div className="muted" style={{ marginBottom: 12 }}>共 {result.tools.length} 个工具</div>
              <ul className="list">
                {result.tools.map((t) => (
                  <li key={t.name}>
                    <div className="grow">
                      <div className="mono" style={{ fontWeight: 600 }}>{t.name}</div>
                      {t.description && <div className="s">{t.description}</div>}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="muted" style={{ marginTop: 12 }}>
                把这些工具名告诉开发者，就可以补全集成目录里的条目。
              </div>
            </div>
          )}

          <p style={{ marginTop: 24 }}><Link to="/">返回首页</Link></p>
        </div>
      </div>
    </div>
  );
}

const ACCESS_LABEL: Record<IntegrationEntry["access"], string> = {
  mcp: "MCP",
  api: "API",
  cli: "命令行",
  webhook: "Webhook",
  manual: "人工",
};

function CatalogCard({ entry }: { entry: IntegrationEntry }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <b>{entry.name}</b>
        <span className="tag">{ACCESS_LABEL[entry.access]}</span>
        {entry.verified ? <span className="st">已验证</span> : <span className="st off">未验证</span>}
      </div>
      <div className="muted" style={{ marginBottom: 8 }}>{entry.summary}</div>
      <div className="muted">
        需要配置：{entry.fields.length ? entry.fields.map((f) => <span key={f.name} className="mono" style={{ marginRight: 8 }}>{f.name}</span>) : "无"}
      </div>
    </div>
  );
}
