import { api } from "./api";

/** 授权管理：用户添加的 MCP 服务（导出 n8n 用的是 n8n 的 MCP）。token 只在添加时提交，之后不会再返回 */
export interface Authorization {
  id: string;
  kind: "mcp";
  name: string;
  url: string;
  createdAt: string;
}

export interface AuthorizationList {
  /** 服务端是否启用了授权管理（配置了 AUTH_SECRET_KEY） */
  enabled: boolean;
  items: Authorization[];
}

export const authorizationsApi = {
  list: () => api.get<AuthorizationList>("/authorizations"),
  create: (body: { kind: "mcp"; name: string; url: string; secret: string }) => api.post<Authorization>("/authorizations", body),
  rename: (id: string, name: string) => api.patch<Authorization>(`/authorizations/${id}`, { name }),
  remove: (id: string) => api.delete<null>(`/authorizations/${id}`),
};

/** 从 MCP 配置 JSON 里识别出的授权字段 */
export interface ParsedMcpConfig {
  name: string;
  url: string;
  secret: string;
}

/**
 * 识别常见的 MCP 配置（Claude Code 的 .mcp.json、Cursor、Claude Desktop 都是 {"mcpServers": {名称: {...}}}）：
 * 取其中的 n8n 服务（名称里带 n8n，没有就取第一个），读出 url 和 headers.Authorization 里的 Bearer token。
 * 也认只有一个服务本身的对象（{"url": ..., "headers": ...}）。识别不了时返回 undefined。
 */
export function parseMcpConfig(text: string): ParsedMcpConfig | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const root = data as Record<string, unknown>;
  const servers = (root.mcpServers ?? root.servers) as Record<string, unknown> | undefined;
  let name = "";
  let server: unknown = root;
  if (servers && typeof servers === "object") {
    const entries = Object.entries(servers).filter(([, v]) => v && typeof v === "object");
    const picked = entries.find(([k]) => /n8n/i.test(k)) ?? entries[0];
    if (!picked) return undefined;
    [name, server] = picked;
  }
  const s = server as { url?: unknown; serverUrl?: unknown; headers?: Record<string, unknown> };
  const url = typeof s.url === "string" ? s.url : typeof s.serverUrl === "string" ? s.serverUrl : "";
  if (!url) return undefined;
  const headers = s.headers && typeof s.headers === "object" ? s.headers : {};
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
  const auth = authKey ? String(headers[authKey]) : "";
  const secret = auth.replace(/^Bearer\s+/i, "").trim();
  if (!secret) return undefined;
  return { name: name || "", url: url.trim(), secret };
}
