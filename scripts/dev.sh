#!/usr/bin/env bash
# 本地开发一键启动：
#   - 数据库：docker 只起 postgres（宿主机端口 5433）
#   - 服务端（默认 3000，tsx watch 改代码自动重启）、前端（默认 5173，vite 热更新）
#   - 端口可以用环境变量 PORT（服务端）、WEB_PORT（前端）修改，例如：PORT=3100 WEB_PORT=5180 ./scripts/dev.sh
#   - 登录直接使用 .env 里配置的真实 ERP 端点（ERP_BASE_URL、SSO_APP_CODE）
# 全部在宿主机运行，改代码无需重新构建镜像。Ctrl+C 一次即可全部停止。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 调用者在命令行指定的端口优先于 .env 与默认值（.env 会覆盖同名的环境变量，所以先记下）
CALLER_PORT="${PORT:-}"
CALLER_WEB_PORT="${WEB_PORT:-}"

# 读取 .env（ERP 地址、模型 key、模型地址等），再覆盖本地开发需要的值
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

docker compose up -d --wait postgres

export DATABASE_URL="postgres://${POSTGRES_USER:-aif}:${POSTGRES_PASSWORD:-aif}@localhost:${POSTGRES_PORT:-5433}/${APP_DB_NAME:-${POSTGRES_DB:-all_in_flow}}"
SERVER_PORT="${CALLER_PORT:-${PORT:-3000}}"
WEB_PORT="${CALLER_WEB_PORT:-${WEB_PORT:-5173}}"
export PORT="$SERVER_PORT"
export SESSION_COOKIE_SECURE=false
export PUBLIC_BASE_URL="http://localhost:$WEB_PORT"
export MODELS_JSON_PATH="$ROOT/config/models.json"  # 必须是绝对路径，服务端在 apps/server 下启动
export ATTACHMENT_DIR="$ROOT/.dev-uploads"
export API_TARGET="http://localhost:$SERVER_PORT"  # 前端 vite 代理到本地服务端

pids=()
# 递归结束进程树：tsx、vite 是 subshell 的子进程，只杀 subshell 会留下它们占着端口
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  trap - EXIT INT TERM
  for p in "${pids[@]}"; do kill_tree "$p"; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 直接调用本地的可执行文件，不经过 npx：pnpm 会把自己的配置（如 approve-builds）
# 以环境变量传给子进程，npm 的 npx 会对这些未知配置打印警告
(cd apps/server && exec ./node_modules/.bin/tsx watch src/index.ts) &
pids+=($!)

(cd apps/web && exec ./node_modules/.bin/vite --port "$WEB_PORT" --strictPort) &
pids+=($!)

echo "开发环境已启动：前端 http://localhost:$WEB_PORT  服务端 http://localhost:$SERVER_PORT"
echo "登录方式：真实 ERP（${ERP_BASE_URL:-未配置}），使用你的 ERP 账号密码登录"
wait
