import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authSessions, users } from "../db/schema/index.js";
import type { ErpClient, ErpUser } from "./erp.js";
import { ErpAuthError } from "./erp.js";

export const SESSION_MAX_AGE_SECONDS = 86400;

export interface CurrentUser {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export interface AuthServiceOptions {
  db: Db;
  erp: ErpClient;
  adminUsernames: string[];
  verifyIntervalSeconds: number;
  now?: () => Date;
}

export function createAuthService(opts: AuthServiceOptions) {
  const now = opts.now ?? (() => new Date());
  const admins = new Set(opts.adminUsernames.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const isAdmin = (username: string) => admins.has(username.toLowerCase());

  async function upsertUser(u: ErpUser) {
    await opts.db
      .insert(users)
      .values({ id: u.userId, username: u.username, displayName: u.displayName, lastLoginAt: now() })
      .onConflictDoUpdate({
        target: users.id,
        set: { username: u.username, displayName: u.displayName, lastLoginAt: now() },
      });
  }

  return {
    isAdmin,

    /** 登录：校验 ERP 账号，创建本地会话，返回 aif_sid 与用户信息 */
    async login(username: string, password: string) {
      const erpUser = await opts.erp.authenticate(username, password);
      await upsertUser(erpUser);

      const sid = randomBytes(32).toString("base64url");
      const maxAge = Math.min(erpUser.expireSeconds, SESSION_MAX_AGE_SECONDS);
      const expiresAt = new Date(now().getTime() + maxAge * 1000);
      await opts.db.insert(authSessions).values({
        sid,
        userId: erpUser.userId,
        erpSid: erpUser.erpSid,
        expiresAt,
        verifiedAt: now(),
      });
      return {
        sid,
        maxAgeSeconds: maxAge,
        user: { id: erpUser.userId, username: erpUser.username, displayName: erpUser.displayName, isAdmin: isAdmin(erpUser.username) },
      };
    },

    /** 校验 aif_sid：本地未过期；距上次校验超过间隔则向 ERP 复核 */
    async verify(sid: string): Promise<CurrentUser | null> {
      const t = now();
      const [row] = await opts.db
        .select({ session: authSessions, user: users })
        .from(authSessions)
        .innerJoin(users, eq(users.id, authSessions.userId))
        .where(and(eq(authSessions.sid, sid), gt(authSessions.expiresAt, t)));
      if (!row) return null;

      const age = (t.getTime() - row.session.verifiedAt.getTime()) / 1000;
      if (age >= opts.verifyIntervalSeconds) {
        try {
          const fresh = await opts.erp.verify(row.session.erpSid);
          if (fresh.userId !== row.user.id) throw new ErpAuthError("身份不一致");
          await opts.db.update(authSessions).set({ verifiedAt: t }).where(eq(authSessions.sid, sid));
        } catch (e) {
          if (e instanceof ErpAuthError) {
            await this.destroy(sid);
            return null;
          }
          throw e; // 上游故障不踢人，交给调用方返回 502
        }
      }
      return { id: row.user.id, username: row.user.username, displayName: row.user.displayName, isAdmin: isAdmin(row.user.username) };
    },

    async destroy(sid: string) {
      await opts.db.delete(authSessions).where(eq(authSessions.sid, sid));
    },

    /** 清理过期会话，可定时调用 */
    async purgeExpired() {
      await opts.db.delete(authSessions).where(lt(authSessions.expiresAt, now()));
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
