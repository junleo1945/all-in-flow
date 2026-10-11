import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatTokens, useMe } from "../lib/useMe";

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
            今日
            <span className="bar" style={{ width: 70 }}>
              <i style={{ width: `${pct}%` }} />
            </span>
            {formatTokens(me.usage.tokensToday)} / {formatTokens(me.usage.dailyTokenQuota)}
          </div>
          <div className="avatar" aria-hidden="true">{me.DisplayName.slice(0, 1)}</div>
          {me.DisplayName}
        </div>
      )}
    </header>
  );
}
