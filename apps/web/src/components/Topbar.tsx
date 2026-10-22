import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { formatTokens, useMe } from "../lib/useMe";
import { useI18n } from "../i18n";
import { AuthorizationsDialog } from "./AuthorizationsDialog";

export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" stroke="#1C1B18" strokeWidth={2} aria-hidden="true">
      <rect x="2" y="3" width="9" height="7" rx="2" />
      <rect x="15" y="16" width="9" height="7" rx="2" />
      <path d="M6.5 10v5.5a3 3 0 0 0 3 3H15" strokeLinecap="round" />
    </svg>
  );
}

export function Topbar({ children, showUser = true }: { children?: ReactNode; showUser?: boolean }) {
  const { me } = useMe();
  const { t } = useI18n();
  const navigate = useNavigate();
  const logout = async () => {
    // 即使请求失败也回到登录页：服务端的会话过期后同样需要重新登录
    await api.post("/user/logout").catch(() => {});
    navigate("/login", { replace: true });
  };
  const pct = me ? Math.min(100, (me.usage.tokensToday / me.usage.dailyTokenQuota) * 100) : 0;
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <BrandMark />
        All-in-Flow
      </Link>
      {children}
      {showUser && me && (
        <div className="user">
          <div className="meter">
            {t("shell.today")}
            <span className="bar" style={{ width: 70 }}>
              <i style={{ width: `${pct}%` }} />
            </span>
            {formatTokens(me.usage.tokensToday)} / {formatTokens(me.usage.dailyTokenQuota)}
          </div>
          <UserMenu name={me.DisplayName} />
          <button type="button" className="logout" onClick={logout}>{t("shell.logout")}</button>
        </div>
      )}
    </header>
  );
}

/** 头像菜单：左键或右键点击头像和用户名弹出，放与访谈无关的工具入口 */
export function UserMenu({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const { t, locale, setLocale } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        <span className="avatar" aria-hidden="true">{name.slice(0, 1)}</span>
        {name}
      </button>
      {open && (
        <div className="pop-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => go("/mermaid")}>{t("shell.mermaidPreview")}</button>
          <button type="button" role="menuitem" onClick={() => go("/skill")}>{t("shell.localSkill")}</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setAuthOpen(true); }}>{t("shell.authorizations")}</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setLocale(locale === "zh" ? "en" : "zh"); }}>{t("shell.language")}</button>
        </div>
      )}
      {authOpen && <AuthorizationsDialog onClose={() => setAuthOpen(false)} />}
    </div>
  );
}
