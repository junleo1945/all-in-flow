/**
 * ERP 公网接口登录（参考 tourmind-mail/src/api/sso.py 的本地兜底实现）。
 * 不保存密码：密码只在 authenticate 中透传给 ERP。
 */

export class ErpAuthError extends Error {}
export class ErpUpstreamError extends Error {}

export interface ErpUser {
  userId: number;
  username: string;
  displayName: string;
  /** ERP 会话的剩余秒数（上游返回纳秒，这里已换算） */
  expireSeconds: number;
  /** 仅服务端保存，用于后续复核 */
  erpSid: string;
}

export interface ErpClientOptions {
  baseUrl: string;
  appCode: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ErpClient {
  authenticate(username: string, password: string): Promise<ErpUser>;
  verify(erpSid: string): Promise<ErpUser>;
}

export function createErpClient(opts: ErpClientOptions): ErpClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const request = (url: string, init: RequestInit) =>
    doFetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }).catch((e: unknown) => {
      throw new ErpUpstreamError(`ERP request failed: ${(e as Error).message}`);
    });

  async function fetchUser(erpSid: string): Promise<ErpUser> {
    const res = await request(`${base}/user/api/get`, {
      headers: {
        Cookie: `tm_sso_sid=${erpSid}`,
        "X-Requested-With": "XMLHttpRequest",
        "X-TM-App-Code": opts.appCode,
      },
    });
    if ([401, 302, 307].includes(res.status)) throw new ErpAuthError("未登录");
    if (res.status !== 200) throw new ErpUpstreamError(`ERP /user/api/get HTTP ${res.status}`);

    const body = (await res.json().catch(() => null)) as any;
    if (!body || !body.Success) throw new ErpAuthError("ERP 获取用户信息失败");

    const d = body.Data ?? {};
    const userId = Number(d.UserId ?? 0);
    if (!userId) throw new ErpAuthError("ERP 返回的用户无效");
    const username = String(d.UserName ?? "");
    const raw = Number(d.ExpireDuration ?? 0);
    // 上游可能返回纳秒，也可能返回秒；与 tourmind-mail 的换算规则一致
    let expireSeconds = raw > 1_000_000_000 ? Math.floor(raw / 1_000_000_000) : raw;
    if (!(expireSeconds > 0)) expireSeconds = 86400;

    return {
      userId,
      username,
      displayName: String(d.FullName || username),
      expireSeconds,
      erpSid,
    };
  }

  return {
    async authenticate(username, password) {
      const res = await request(`${base}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TM-App-Code": opts.appCode },
        body: JSON.stringify({ UserName: username, Password: password }),
      });
      if (res.status === 401 || res.status === 403) throw new ErpAuthError("用户名或密码错误");
      if (res.status !== 200) throw new ErpUpstreamError(`ERP /api/login HTTP ${res.status}`);

      const body = (await res.json().catch(() => null)) as any;
      if (body && typeof body === "object") {
        if (body.ErrCode && body.ErrCode !== 0) throw new ErpAuthError(body.UserMsg || body.ErrMsg || "用户名或密码错误");
        if ("Success" in body && !body.Success) throw new ErpAuthError(body.UserMsg || body.ErrMsg || "用户名或密码错误");
      }

      const sid = extractSid(res.headers.getSetCookie?.() ?? []);
      if (!sid) throw new ErpUpstreamError("ERP 登录成功但未返回 tm_sso_sid");
      return fetchUser(sid);
    },
    verify: fetchUser,
  };
}

function extractSid(setCookies: string[]): string | undefined {
  for (const c of setCookies) {
    const m = /(?:^|;\s*)tm_sso_sid=([^;]+)/.exec(c);
    if (m) return m[1]!.trim();
  }
  return undefined;
}
