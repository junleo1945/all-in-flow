#!/usr/bin/env bash
# 不依赖 docker compose 的部署脚本：构建镜像，并用 docker run 启动 postgres、server、web。
# 配置项与 docker-compose.yml 保持一致，从项目根目录的 .env 读取（可以不存在，使用默认值）。
#
#   scripts/deploy-docker.sh          本机构建镜像并启动（同名容器会被替换，数据卷保留）
#   AIF_IMAGE_PREFIX=ghcr.io/<owner> scripts/deploy-docker.sh
#                                     不构建，直接拉取 GitHub Actions 推送的镜像并启动
#   scripts/deploy-docker.sh stop     停止并删除三个容器（数据卷保留）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NET=aif-net
PG_VOL=aif-pgdata
UPLOAD_VOL=aif-uploads
PG_CTR=aif-postgres
SERVER_CTR=aif-server
WEB_CTR=aif-web
# 设置 AIF_IMAGE_PREFIX（如 ghcr.io/junleo1945）时，直接拉取 GitHub Actions 构建好的镜像，本机不再构建
IMAGE_PREFIX="${AIF_IMAGE_PREFIX:-}"
if [ -n "$IMAGE_PREFIX" ]; then
  IMAGE_TAG="${AIF_IMAGE_TAG:-latest}"
  SERVER_IMG="$IMAGE_PREFIX/all-in-flow-server:$IMAGE_TAG"
  WEB_IMG="$IMAGE_PREFIX/all-in-flow-web:$IMAGE_TAG"
  PG_IMG="${POSTGRES_IMAGE:-$IMAGE_PREFIX/postgres:16-alpine}"
else
  SERVER_IMG=aif-server:latest
  WEB_IMG=aif-web:latest
  # 数据库镜像可通过 POSTGRES_IMAGE 覆盖，例如拉取 Docker Hub 不稳定时换成镜像源
  PG_IMG="${POSTGRES_IMAGE:-postgres:16-alpine}"
fi

if [ "${1:-}" = "stop" ]; then
  docker rm -f "$WEB_CTR" "$SERVER_CTR" "$PG_CTR" >/dev/null 2>&1 || true
  echo "已停止容器，数据卷 $PG_VOL、$UPLOAD_VOL 保留。"
  exit 0
fi

# 读取 .env
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# 未定义时使用默认值（与 docker-compose.yml 一致）
default() { export "$1=${!1:-$2}"; }

default POSTGRES_USER aif
default POSTGRES_PASSWORD aif
default POSTGRES_DB all_in_flow
default POSTGRES_PORT 9099
default WEB_PORT 9088
default DEEPSEEK_API_KEY ""
default DEEPSEEK_BASE_URL https://api.deepseek.com
default VISION_MODEL_ID ""
default VISION_BASE_URL ""
default VISION_API_KEY ""
default VISION_THINKING false
default ATTACHMENT_MAX_BYTES 10485760
default ATTACHMENT_MAX_PER_MESSAGE 4
default ATTACHMENT_DAILY_LIMIT_PER_USER 50
default AGENT_MODEL deepseek/deepseek-flash
default WORKFLOW_MODEL deepseek/deepseek-v4-pro
default ERP_BASE_URL https://erp.tourmind.cn
default SSO_APP_CODE ""
default SESSION_COOKIE_SECURE false
default SESSION_VERIFY_INTERVAL_SECONDS 300
default ADMIN_USERNAMES ""
default PUBLIC_BASE_URL "http://localhost:${WEB_PORT}"
default SHARE_PUBLIC_ENABLED false
default DAILY_TOKEN_QUOTA_PER_USER 2000000
default DAILY_COST_LIMIT_USD 20
default MAX_TURNS_PER_CONVERSATION 80

# 容器内固定的值，不随 .env 变化
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${PG_CTR}:5432/${POSTGRES_DB}"
export PORT=3000
export MODELS_JSON_PATH=/app/config/models.json
export ATTACHMENT_DIR=/data/uploads

if [ -z "$IMAGE_PREFIX" ]; then
  echo "==> 构建镜像"
  docker build -f Dockerfile.server -t "$SERVER_IMG" .
  docker build -f Dockerfile.web -t "$WEB_IMG" .
else
  echo "==> 拉取镜像"
  docker pull "$SERVER_IMG"
  docker pull "$WEB_IMG"
  docker pull "$PG_IMG"
fi

echo "==> 准备网络和数据卷"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
docker volume create "$PG_VOL" >/dev/null
docker volume create "$UPLOAD_VOL" >/dev/null

echo "==> 替换已有容器"
docker rm -f "$WEB_CTR" "$SERVER_CTR" "$PG_CTR" >/dev/null 2>&1 || true

echo "==> 启动数据库（镜像：$PG_IMG，宿主机端口 127.0.0.1:$POSTGRES_PORT）"
# 映射到宿主机回环地址，外部工具（DBeaver、psql 等）可直连；远程访问请用 SSH 隧道
docker run -d --name "$PG_CTR" --network "$NET" --restart unless-stopped \
  -p "127.0.0.1:${POSTGRES_PORT}:5432" \
  -e POSTGRES_USER -e POSTGRES_PASSWORD -e POSTGRES_DB \
  -v "$PG_VOL:/var/lib/postgresql/data" \
  "$PG_IMG" >/dev/null

echo "==> 等待数据库就绪"
for i in $(seq 1 30); do
  if docker exec "$PG_CTR" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "数据库 30 次检测后仍未就绪，请执行 docker logs $PG_CTR 查看原因" >&2
    exit 1
  fi
  sleep 2
done

echo "==> 启动服务端"
SERVER_ENV=(
  DATABASE_URL PORT
  DEEPSEEK_API_KEY DEEPSEEK_BASE_URL
  MODELS_JSON_PATH
  VISION_MODEL_ID VISION_BASE_URL VISION_API_KEY VISION_THINKING
  ATTACHMENT_DIR ATTACHMENT_MAX_BYTES ATTACHMENT_MAX_PER_MESSAGE ATTACHMENT_DAILY_LIMIT_PER_USER
  AGENT_MODEL WORKFLOW_MODEL
  ERP_BASE_URL SSO_APP_CODE SESSION_COOKIE_SECURE SESSION_VERIFY_INTERVAL_SECONDS ADMIN_USERNAMES
  PUBLIC_BASE_URL SHARE_PUBLIC_ENABLED
  DAILY_TOKEN_QUOTA_PER_USER DAILY_COST_LIMIT_USD MAX_TURNS_PER_CONVERSATION
)
SERVER_ENV_ARGS=()
for key in "${SERVER_ENV[@]}"; do
  SERVER_ENV_ARGS+=(-e "$key")
done

# --network-alias server：web 的 nginx 通过 http://server:3000 反向代理
docker run -d --name "$SERVER_CTR" --network "$NET" --network-alias server --restart unless-stopped \
  "${SERVER_ENV_ARGS[@]}" \
  -v "$ROOT/config/models.json:/app/config/models.json:ro" \
  -v "$UPLOAD_VOL:/data/uploads" \
  "$SERVER_IMG" >/dev/null

echo "==> 启动前端"
docker run -d --name "$WEB_CTR" --network "$NET" --restart unless-stopped \
  -p "${WEB_PORT}:80" \
  "$WEB_IMG" >/dev/null

echo "==> 完成，当前容器状态："
docker ps --filter "name=aif-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo
echo "访问地址：http://<服务器IP>:${WEB_PORT}"
echo "查看服务端日志：docker logs -f $SERVER_CTR"
