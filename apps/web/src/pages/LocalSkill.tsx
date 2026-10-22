import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { copyText } from "../lib/clipboard";
import {
  accessTokensApi,
  buildSkillZip,
  connectSnippet,
  localSkillApi,
  mcpUrl,
  saveBlob,
  type AccessToken,
  type ClientKind,
  type CreatedToken,
  type SkillPackage,
} from "../lib/localSkill";
import { Topbar } from "../components/Topbar";
import { useI18n } from "../i18n";

const CLIENTS: ClientKind[] = ["claude-code", "codex", "json"];
const TTL_OPTIONS = [30, 90, 365];

/** 复制按钮：点击后短暂显示「已复制」 */
function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="btn btn-line skill-copy"
      onClick={() =>
        copyText(text).then(
          () => setState("done"),
          () => setState("fail"),
        )
      }
    >
      {state === "done" ? t("skill.copied") : state === "fail" ? t("skill.copyFailed") : t("skill.copy")}
    </button>
  );
}

function CodeBlock({ label, text }: { label?: string; text: string }) {
  return (
    <div className="skill-code">
      {label && <div className="muted">{label}</div>}
      <div className="skill-code-row">
        <pre>{text}</pre>
        <CopyButton text={text} />
      </div>
    </div>
  );
}

export default function LocalSkillPage() {
  const { t } = useI18n();
  const [pkg, setPkg] = useState<SkillPackage | null>(null);
  const [pkgErr, setPkgErr] = useState("");
  const [packing, setPacking] = useState(false);
  const [downloadErr, setDownloadErr] = useState("");

  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [max, setMax] = useState(5);
  const [tokensLoaded, setTokensLoaded] = useState(false);
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** 刚生成的令牌：明文只在这里出现，关闭后就没有了 */
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [client, setClient] = useState<ClientKind>("claude-code");

  const message = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

  const loadTokens = () =>
    accessTokensApi
      .list()
      .then((r) => {
        setTokens(r.items);
        setMax(r.max);
      })
      .catch((e) => setErr(message(e, t("skill.loadFailed"))))
      .finally(() => setTokensLoaded(true));

  useEffect(() => {
    localSkillApi.get().then(setPkg).catch((e) => setPkgErr(message(e, t("skill.loadFailed"))));
    void loadTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = async () => {
    if (!pkg) return;
    setPacking(true);
    setDownloadErr("");
    try {
      saveBlob(await buildSkillZip(pkg), `${pkg.name}.zip`);
    } catch (e) {
      setDownloadErr(message(e, t("skill.downloadFailed")));
    } finally {
      setPacking(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setErr("");
    try {
      const made = await accessTokensApi.create({ name: name.trim(), expiresInDays: days });
      setCreated(made);
      setName("");
      await loadTokens();
    } catch (e) {
      setErr(message(e, t("skill.loadFailed")));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (item: AccessToken) => {
    if (!window.confirm(t("skill.confirmRevoke", { name: item.name }))) return;
    setBusy(true);
    setErr("");
    try {
      await accessTokensApi.remove(item.id);
      if (created?.id === item.id) setCreated(null);
      await loadTokens();
    } catch (e) {
      setErr(message(e, t("skill.loadFailed")));
    } finally {
      setBusy(false);
    }
  };

  const url = mcpUrl(window.location.origin);
  const blocks = connectSnippet(client, { url, token: created?.token });
  const date = (iso: string) => new Date(iso).toLocaleDateString(t("home.dateLocale"));
  const skillMd = pkg?.files.find((f) => f.path === "SKILL.md");

  return (
    <div className="page">
      <Topbar />
      <main className="skill-page">
        <h1>{t("skill.title")}</h1>
        <p className="skill-intro">{t("skill.intro")}</p>

        <section className="card skill-step" aria-labelledby="skill-step1">
          <h2 id="skill-step1">{t("skill.step1")}</h2>
          <p className="muted">{t("skill.step1Desc")}</p>
          <div className="skill-actions">
            <button type="button" className="btn btn-ink" disabled={!pkg || packing} onClick={download}>
              {packing ? t("skill.downloading") : t("skill.download")}
            </button>
            {pkg && <span className="muted">{t("skill.version", { v: pkg.version })}</span>}
          </div>
          {(pkgErr || downloadErr) && <div className="notice-error" role="alert">{pkgErr || downloadErr}</div>}
          <div className="skill-install">
            <div>{t("skill.installTitle")}</div>
            <ul>
              <li>{t("skill.installClaude")}</li>
              <li>{t("skill.installCodex")}</li>
              <li>{t("skill.installOther")}</li>
            </ul>
            <div className="muted">{t("skill.installNote")}</div>
          </div>
          {pkg && skillMd && (
            <details className="skill-files">
              <summary>{t("skill.viewFiles", { n: pkg.files.length })}</summary>
              <ul>
                {pkg.files.map((f) => (
                  <li key={f.path}><code>{pkg.name}/{f.path}</code></li>
                ))}
              </ul>
              <pre>{skillMd.content}</pre>
            </details>
          )}
        </section>

        <section className="card skill-step" aria-labelledby="skill-step2">
          <h2 id="skill-step2">{t("skill.step2")}</h2>
          <p className="muted">{t("skill.step2Desc")}</p>

          <div className="skill-token-form">
            <label className="n8n-field">
              <span>{t("skill.tokenName")}</span>
              <input className="input" value={name} maxLength={60} placeholder={t("skill.tokenNamePlaceholder")} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="n8n-field">
              <span>{t("skill.expires")}</span>
              <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {TTL_OPTIONS.map((n) => (
                  <option key={n} value={n}>{t("skill.days", { n })}</option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-ink" disabled={busy || !name.trim() || tokens.length >= max} onClick={create}>
              {busy ? t("skill.creating") : t("skill.createToken")}
            </button>
          </div>
          <div className="muted">{t("skill.tokensLimit", { n: max })}</div>
          {err && <div className="notice-error" role="alert">{err}</div>}

          {created && (
            <div className="skill-created" role="status">
              <b>{t("skill.createdTitle", { name: created.name })}</b>
              <div className="notice">{t("skill.createdWarn")}</div>
              <CodeBlock text={created.token} />
              <button type="button" className="btn btn-line" onClick={() => setCreated(null)}>{t("skill.dismiss")}</button>
            </div>
          )}

          <h3>{t("skill.connectTitle")}</h3>
          <p className="muted">{t("skill.connectHint")}</p>
          <div className="skill-tabs" role="tablist">
            {CLIENTS.map((c) => (
              <button key={c} type="button" role="tab" aria-selected={client === c} className={client === c ? "on" : ""} onClick={() => setClient(c)}>
                {t(`skill.client.${c}`)}
              </button>
            ))}
          </div>
          {blocks.map((b) => (
            <CodeBlock key={b.id} label={t(`skill.block.${b.id}`)} text={b.text} />
          ))}

          <h3>{t("skill.tokensTitle")}</h3>
          <ul className="auth-list" aria-label={t("skill.tokensTitle")}>
            {tokensLoaded && tokens.length === 0 && <li className="muted">{t("skill.tokensEmpty")}</li>}
            {tokens.map((item) => (
              <li key={item.id}>
                <div className="auth-main">
                  <b>{item.name}</b>
                  <span className="muted">
                    {item.prefix}… · {t("skill.expiresAt", { date: date(item.expiresAt) })} · {item.lastUsedAt ? t("skill.lastUsed", { date: date(item.lastUsedAt) }) : t("skill.neverUsed")}
                  </span>
                </div>
                <div className="auth-actions">
                  <button type="button" className="btn btn-line" disabled={busy} onClick={() => revoke(item)}>{t("skill.revoke")}</button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="card skill-step" aria-labelledby="skill-step3">
          <h2 id="skill-step3">{t("skill.step3")}</h2>
          <p>{t("skill.step3Desc")}</p>
          <CodeBlock text={t("skill.step3Prompt")} />
          <p className="muted">{t("skill.step3After")}</p>
        </section>
      </main>
    </div>
  );
}
