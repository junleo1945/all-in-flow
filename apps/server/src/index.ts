import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { buildContainer } from "./container.js";

const config = loadConfig();
await runMigrations(config.databaseUrl);

const { app, registry, auth } = await buildContainer(config);

// 空闲的会话从内存释放（数据已在数据库，之后可恢复）；过期的登录会话定期清理
setInterval(() => registry.sweepIdle(), 5 * 60 * 1000).unref();
setInterval(() => void auth.purgeExpired().catch(() => {}), 60 * 60 * 1000).unref();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`all-in-flow server listening on http://localhost:${info.port}`);
});
