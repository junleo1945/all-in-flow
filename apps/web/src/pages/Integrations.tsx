import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { INTEGRATION_CATALOG, type IntegrationEntry } from "@aif/integrations";
import { api, ApiError } from "../lib/api";
import { Topbar } from "../components/Topbar";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
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
      setError(err instanceof ApiError ? err.message : t("integ.testFailed"));
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
            {t("integ.title")}
            <small>{t("integ.subtitle")}</small>
          </div>

          <div className="sec-title"><h3>{t("integ.catalog")}</h3><span>{t("integ.catalogCount", { n: INTEGRATION_CATALOG.length })}</span></div>
          <div className="convs" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {INTEGRATION_CATALOG.map((e) => (
              <CatalogCard key={e.id} entry={e} />
            ))}
          </div>

          <div className="sec-title"><h3>{t("integ.mcpTest")}</h3><span>{t("integ.notSaved")}</span></div>
          <form className="card starter" onSubmit={test}>
            <label htmlFor="mcp-url" className="muted" style={{ display: "block", marginBottom: 8 }}>{t("integ.urlLabel")}</label>
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
              <span className="muted">{t("integ.urlNote")}</span>
              <button className="btn btn-ink" style={{ marginLeft: "auto" }} disabled={busy || !url.trim()}>
                {busy ? t("integ.testing") : t("integ.test")}
              </button>
            </div>
          </form>

          {error && <div className="notice-error" style={{ marginTop: 16 }}>{error}</div>}

          {result && (
            <div className="card side-card" style={{ marginTop: 16 }}>
              <h3>{result.serverName ? t("integ.connectedName", { name: result.serverName }) : t("integ.connected")}</h3>
              <div className="muted" style={{ marginBottom: 12 }}>{t("integ.toolCount", { n: result.tools.length })}</div>
              <ul className="list">
                {result.tools.map((tool) => (
                  <li key={tool.name}>
                    <div className="grow">
                      <div className="mono" style={{ fontWeight: 600 }}>{tool.name}</div>
                      {tool.description && <div className="s">{tool.description}</div>}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="muted" style={{ marginTop: 12 }}>
                {t("integ.toolHint")}
              </div>
            </div>
          )}

          <p style={{ marginTop: 24 }}><Link to="/">{t("common.backHome")}</Link></p>
        </div>
      </div>
    </div>
  );
}

function CatalogCard({ entry }: { entry: IntegrationEntry }) {
  const { t } = useI18n();
  const ACCESS_LABEL: Record<IntegrationEntry["access"], string> = {
    mcp: "MCP",
    api: "API",
    cli: t("integ.access.cli"),
    webhook: "Webhook",
    manual: t("integ.access.manual"),
  };
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <b>{entry.name}</b>
        <span className="tag">{ACCESS_LABEL[entry.access]}</span>
        {entry.verified ? <span className="st">{t("integ.verified")}</span> : <span className="st off">{t("integ.unverified")}</span>}
      </div>
      <div className="muted" style={{ marginBottom: 8 }}>{entry.summary}</div>
      <div className="muted">
        {t("integ.needConfig")}{entry.fields.length ? entry.fields.map((f) => <span key={f.name} className="mono" style={{ marginRight: 8 }}>{f.name}</span>) : t("integ.none")}
      </div>
    </div>
  );
}
