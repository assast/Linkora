#!/usr/bin/env bash
set -euo pipefail

VERIFY_ROOT="${1:?需要隔离验证目录}"
VERIFY_PREFIX="${2:?需要验证资源前缀}"
[[ "$VERIFY_ROOT" == /tmp/linkora-icons-check.* && "$VERIFY_PREFIX" =~ ^linkora-icons-check-[a-z0-9]+$ ]] || exit 2
NEW_API="${3:?需要 API 测试镜像}"
NEW_WEB="${4:?需要 Web 测试镜像}"
OLD_API="${5:?需要旧 API 测试镜像}"
OLD_WEB="${6:?需要旧 Web 测试镜像}"
VERIFY_SUBNET="${7:?需要已确认不冲突的隔离子网}"
cleanup() {
  docker rm -f "$VERIFY_PREFIX-api" "$VERIFY_PREFIX-web" "$VERIFY_PREFIX-pg" >/dev/null 2>&1 || true
  docker network rm "$VERIFY_PREFIX" >/dev/null 2>&1 || true
  for suffix in pg cache uploads restore-uploads; do docker volume rm "$VERIFY_PREFIX-$suffix" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT
mkdir -p "$VERIFY_ROOT/state"
chown 1000:1000 "$VERIFY_ROOT/state"
chmod 755 "$VERIFY_ROOT"
docker network create --internal --subnet "$VERIFY_SUBNET" "$VERIFY_PREFIX" >/dev/null
for suffix in pg cache uploads restore-uploads; do docker volume create "$VERIFY_PREFIX-$suffix" >/dev/null; done
docker run -d --name "$VERIFY_PREFIX-pg" --network "$VERIFY_PREFIX" --network-alias pg \
  -e POSTGRES_USER=linkora_test -e POSTGRES_PASSWORD=verification-only -e POSTGRES_DB=linkora_icons_test \
  -v "$VERIFY_PREFIX-pg:/var/lib/postgresql/data" pgvector/pgvector:0.8.2-pg16 >/dev/null
for attempt in {1..60}; do
  if docker exec "$VERIFY_PREFIX-pg" pg_isready -U linkora_test -d linkora_icons_test >/dev/null 2>&1; then break; fi
  sleep 0.5
done
start_api() {
  local image="$1" database="$2" uploads="$3" readonly="${4:-}"
  docker run -d --name "$VERIFY_PREFIX-api" --network "$VERIFY_PREFIX" --network-alias api \
    -e "DATABASE_URL=postgresql://linkora_test:verification-only@pg:5432/$database" \
    -e SITE_URL=http://127.0.0.1:3000 -e ALLOW_INSECURE_HTTP=true -e ICON_CONTAINER_VERIFICATION=1 \
    -e ICON_CACHE_DIR=/app/data/site-icons -e ICON_UPLOAD_DIR=/app/data/icon-uploads \
    -v "$VERIFY_PREFIX-cache:/app/data/site-icons$readonly" -v "$uploads:/app/data/icon-uploads$readonly" \
    -v "$VERIFY_ROOT/state:/verification" -v "$VERIFY_ROOT/verify-icons-runtime.mjs:/tmp/verify-icons-runtime.mjs:ro" "$image" >/dev/null
  for attempt in {1..60}; do
    if docker exec "$VERIFY_PREFIX-api" node -e 'fetch("http://127.0.0.1:3000/api/v1/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then return; fi
    sleep 0.5
  done
  docker logs --tail 40 "$VERIFY_PREFIX-api"
  return 1
}
start_web() {
  docker run -d --name "$VERIFY_PREFIX-web" --network "$VERIFY_PREFIX" --network-alias web "$1" >/dev/null
  for attempt in {1..30}; do
    if docker exec "$VERIFY_PREFIX-web" wget -q -O /dev/null http://127.0.0.1; then return; fi
    sleep 0.2
  done
  return 1
}
check() { docker exec "$VERIFY_PREFIX-api" node /tmp/verify-icons-runtime.mjs "$1"; }

start_api "$NEW_API" linkora_icons_test "$VERIFY_PREFIX-uploads"
start_web "$NEW_WEB"
check seed
check proxy
docker restart "$VERIFY_PREFIX-api" >/dev/null
check check
docker rm -f "$VERIFY_PREFIX-api" >/dev/null
start_api "$NEW_API" linkora_icons_test "$VERIFY_PREFIX-uploads"
check check

docker stop "$VERIFY_PREFIX-api" >/dev/null
docker exec "$VERIFY_PREFIX-pg" pg_dump -U linkora_test -d linkora_icons_test -Fc > "$VERIFY_ROOT/icons.dump"
docker run --rm --entrypoint tar -v "$VERIFY_PREFIX-uploads:/uploads:ro" -v "$VERIFY_ROOT/state:/verification" "$NEW_API" -czf /verification/uploads.tar.gz -C /uploads .
docker exec "$VERIFY_PREFIX-pg" createdb -U linkora_test linkora_icons_restore_test
docker exec -i "$VERIFY_PREFIX-pg" pg_restore -U linkora_test -d linkora_icons_restore_test --no-owner --no-acl --exit-on-error < "$VERIFY_ROOT/icons.dump"
docker run --rm --entrypoint sh --user root -v "$VERIFY_PREFIX-restore-uploads:/uploads" -v "$VERIFY_ROOT/state:/verification:ro" "$NEW_API" -c 'tar -xzf /verification/uploads.tar.gz -C /uploads && chown -R node:node /uploads'
docker rm -f "$VERIFY_PREFIX-api" >/dev/null
start_api "$NEW_API" linkora_icons_restore_test "$VERIFY_PREFIX-restore-uploads"
check restored

docker rm -f "$VERIFY_PREFIX-api" >/dev/null
start_api "$NEW_API" linkora_icons_restore_test "$VERIFY_PREFIX-restore-uploads" :ro
check readonly
docker rm -f "$VERIFY_PREFIX-api" "$VERIFY_PREFIX-web" >/dev/null
start_api "$OLD_API" linkora_icons_restore_test "$VERIFY_PREFIX-restore-uploads"
start_web "$OLD_WEB"
check legacy
docker rm -f "$VERIFY_PREFIX-api" "$VERIFY_PREFIX-web" >/dev/null
start_api "$NEW_API" linkora_icons_restore_test "$VERIFY_PREFIX-restore-uploads"
start_web "$NEW_WEB"
check check
check proxy
printf 'PASS containers: 重启、重建、独立恢复、只读降级及配对镜像回退/重新升级\n'
