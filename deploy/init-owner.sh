#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
printf '所有者邮箱: '
read -r OWNER_EMAIL
printf '初始密码（至少 8 位）: '
trap 'stty echo' EXIT INT TERM
stty -echo
read -r OWNER_PASSWORD
stty echo
printf '\n'
export OWNER_EMAIL OWNER_PASSWORD
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --entrypoint node -e OWNER_EMAIL -e OWNER_PASSWORD api dist/owner-init.js
