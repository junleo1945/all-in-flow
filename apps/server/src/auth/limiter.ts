/** 固定窗口限流（进程内存）。登录接口按 IP 和用户名分别限流，防止暴力破解。 */
export class FixedWindowLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** 返回 true 表示放行 */
  hit(key: string): boolean {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.limit;
  }
}
