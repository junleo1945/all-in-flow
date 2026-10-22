import { api } from "./api";

/** 下载包：文件清单由服务端生成，浏览器里打成 zip */
export interface SkillPackage {
  name: string;
  /** 内容摘要，内容变了就变 */
  version: string;
  files: Array<{ path: string; content: string }>;
}

/** 个人访问令牌（列表里没有令牌本身） */
export interface AccessToken {
  id: string;
  name: string;
  /** 令牌开头几位，用来辨认 */
  prefix: string;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
}
export type CreatedToken = AccessToken & { token: string };
export interface AccessTokenList {
  /** 同时有效的令牌上限 */
  max: number;
  items: AccessToken[];
}

export const localSkillApi = {
  get: () => api.get<SkillPackage>("/local-skill"),
};

export const accessTokensApi = {
  list: () => api.get<AccessTokenList>("/access-tokens"),
  create: (body: { name: string; expiresInDays: number }) => api.post<CreatedToken>("/access-tokens", body),
  remove: (id: string) => api.delete<null>(`/access-tokens/${id}`),
};

/** 平台 MCP 端点的完整地址；origin 是用户当前访问网站用的地址 */
export const mcpUrl = (origin: string) => `${origin.replace(/\/+$/, "")}/api/mcp`;

export const MCP_SERVER_NAME = "all-in-flow";
/** 还没有生成令牌时，连接配置里用这个占位 */
export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";
/** Codex 读取令牌用的环境变量名 */
export const CODEX_TOKEN_ENV = "AIF_TOKEN";

export type ClientKind = "claude-code" | "codex" | "json";
export interface SnippetBlock {
  /** 界面据此显示这一块的说明 */
  id: "command" | "env" | "toml" | "json";
  text: string;
}

/**
 * 各类客户端的连接配置。token 为空时用占位符。
 * - Claude Code：一条命令；
 * - Codex：令牌放环境变量（不落在配置文件里），配置文件里只写地址和变量名；
 * - 其他：.mcp.json 风格的 JSON（Cursor、Claude Desktop 等通用）。
 */
export function connectSnippet(kind: ClientKind, opts: { url: string; token?: string }): SnippetBlock[] {
  const token = opts.token || TOKEN_PLACEHOLDER;
  switch (kind) {
    case "claude-code":
      return [{ id: "command", text: `claude mcp add --transport http ${MCP_SERVER_NAME} ${opts.url} --header "Authorization: Bearer ${token}"` }];
    case "codex":
      return [
        { id: "env", text: `export ${CODEX_TOKEN_ENV}="${token}"` },
        { id: "toml", text: `[mcp_servers.${MCP_SERVER_NAME}]\nurl = "${opts.url}"\nbearer_token_env_var = "${CODEX_TOKEN_ENV}"` },
      ];
    case "json":
      return [
        {
          id: "json",
          text: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: opts.url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
        },
      ];
  }
}

/** 把下载包打成 zip，里面是一个以 Skill 名命名的文件夹（解压到 skills 目录即可） */
export async function buildSkillZip(pkg: SkillPackage): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const f of pkg.files) zip.file(`${pkg.name}/${f.path}`, f.content);
  return zip.generateAsync({ type: "blob" });
}

/** 触发浏览器下载 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
