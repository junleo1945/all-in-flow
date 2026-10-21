import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { authorizationsApi, parseMcpConfig, type Authorization } from "../lib/authorizations";
import { useI18n } from "../i18n";

/** 授权管理：增删改查授权。目前只有 n8n 的 MCP token；token 提交后不再显示 */
export function AuthorizationsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Authorization[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", secret: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [pasted, setPasted] = useState("");
  const [pasteErr, setPasteErr] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const message = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : t("auth.failed"));
  const load = () =>
    authorizationsApi
      .list()
      .then((r) => {
        setItems(r.items);
        setEnabled(r.enabled);
      })
      .catch((e) => setErr(message(e)))
      .finally(() => setLoaded(true));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 粘贴 MCP 配置 JSON：识别出名称、地址、token 就填进表单 */
  const onPaste = (text: string) => {
    setPasted(text);
    if (text.trim() === "") return setPasteErr(false);
    const parsed = parseMcpConfig(text);
    setPasteErr(!parsed);
    if (parsed) setForm((f) => ({ name: f.name.trim() || parsed.name, url: parsed.url, secret: parsed.secret }));
  };

  const add = async () => {
    setBusy(true);
    setErr("");
    try {
      await authorizationsApi.create({ kind: "mcp", name: form.name.trim(), url: form.url.trim(), secret: form.secret.trim() });
      setForm({ name: "", url: "", secret: "" });
      setPasted("");
      setPasteErr(false);
      setAdding(false);
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!editing || !editing.name.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await authorizationsApi.rename(editing.id, editing.name.trim());
      setEditing(null);
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: Authorization) => {
    if (!window.confirm(t("auth.confirmDelete", { name: item.name }))) return;
    setBusy(true);
    setErr("");
    try {
      await authorizationsApi.remove(item.id);
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = form.name.trim() && form.url.trim() && form.secret.trim();

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="card modal auth-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("auth.title")}>
        <button className="x" onClick={onClose} aria-label={t("common.close")}>✕</button>
        <h2>{t("auth.title")}</h2>
        <div className="muted" style={{ marginTop: 2 }}>{t("auth.subtitle")}</div>

        {!enabled && loaded && <div className="notice-error" style={{ marginTop: 14 }}>{t("auth.disabled")}</div>}

        <ul className="auth-list" aria-label={t("auth.title")}>
          {loaded && items.length === 0 && enabled && <li className="muted">{t("auth.empty")}</li>}
          {items.map((item) => (
            <li key={item.id}>
              <div className="auth-main">
                {editing?.id === item.id ? (
                  <input className="input" autoFocus value={editing.name} aria-label={t("auth.name")} maxLength={60} onChange={(e) => setEditing({ id: item.id, name: e.target.value })} />
                ) : (
                  <b>{item.name}</b>
                )}
                <span className="muted">{item.url}</span>
              </div>
              <div className="auth-actions">
                {editing?.id === item.id ? (
                  <>
                    <button className="btn btn-line" disabled={busy} onClick={() => setEditing(null)}>{t("common.cancel")}</button>
                    <button className="btn btn-ink" disabled={busy || !editing.name.trim()} onClick={rename}>{t("auth.save")}</button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-line" disabled={busy} onClick={() => setEditing({ id: item.id, name: item.name })}>{t("auth.rename")}</button>
                    <button className="btn btn-line" disabled={busy} onClick={() => remove(item)}>{t("auth.delete")}</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>

        {adding ? (
          <div className="auth-form">
            <label className="n8n-field">
              <span>{t("auth.paste")}</span>
              <textarea className="input auth-paste" rows={8} spellCheck={false} value={pasted} placeholder={'{ "mcpServers": { "n8n": { "url": "…", "headers": { "Authorization": "Bearer …" } } } }'} onChange={(e) => onPaste(e.target.value)} />
              <small className={pasteErr ? "notice-error" : "muted"}>{pasteErr ? t("auth.pasteFail") : t("auth.pasteHelp")}</small>
            </label>
            <label className="n8n-field">
              <span>{t("auth.name")}</span>
              <input className="input" value={form.name} maxLength={60} placeholder={t("auth.namePlaceholder")} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="n8n-field">
              <span>{t("auth.url")}</span>
              <input className="input" value={form.url} placeholder="https://n8n.example.com" spellCheck={false} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </label>
            <label className="n8n-field">
              <span>{t("auth.token")}</span>
              <input className="input" type="password" autoComplete="off" spellCheck={false} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
              <small className="muted">{t("auth.tokenHelp")}</small>
            </label>
            <div className="auth-actions">
              <button className="btn btn-line" disabled={busy} onClick={() => { setAdding(false); setErr(""); }}>{t("common.cancel")}</button>
              <button className="btn btn-ink" disabled={busy || !ready} onClick={add}>{busy ? t("auth.checking") : t("auth.add")}</button>
            </div>
          </div>
        ) : (
          enabled && <button className="btn btn-ink" style={{ marginTop: 14 }} onClick={() => setAdding(true)}>{t("auth.addMcp")}</button>
        )}

        {err && <div className="notice-error" style={{ marginTop: 14 }} role="alert">{err}</div>}
      </div>
    </div>
  );
}
