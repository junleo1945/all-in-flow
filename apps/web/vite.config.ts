import { cpSync, existsSync, statSync, createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Excalidraw 的手写字体（Excalifont、中文 Xiaolai 等）默认从 esm.sh 下载，国内网络下慢或不通，
// 首次绘制会先用后备字体，看起来发虚。这里让字体随前端一起发布，并在 index.html 里把
// EXCALIDRAW_ASSET_PATH 指向 /excalidraw/：开发时由中间件直接读 node_modules，构建时复制到 dist。
const ASSET_BASE = "/excalidraw/";
function excalidrawFonts(): Plugin {
  const fontsDir = join(dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")), "fonts");
  return {
    name: "excalidraw-fonts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]);
        if (!url.startsWith(`${ASSET_BASE}fonts/`)) return next();
        const file = normalize(join(fontsDir, url.slice(`${ASSET_BASE}fonts/`.length)));
        if (!file.startsWith(fontsDir) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", extname(file) === ".woff2" ? "font/woff2" : "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      cpSync(fontsDir, join("dist", ASSET_BASE, "fonts"), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.API_TARGET ?? "http://localhost:3000", changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.ts"],
  },
} as any);
