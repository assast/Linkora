#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT_DIR/.cache/local-service"
PID_FILE="$STATE_DIR/linkora.pid"
LOG_FILE="$STATE_DIR/linkora.log"
API_URL="http://127.0.0.1:3000/api/v1/health"
WEB_URL="http://127.0.0.1:5173/"

service_is_running() {
  local pid="$1"
  local command
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ -z "$command" ]] && return 0
  [[ "$command" == *"$ROOT_DIR/scripts/dev.mjs"* ]]
}

running_pid() {
  local pid
  [[ -f "$PID_FILE" ]] || return 1
  pid="$(cat "$PID_FILE")"
  service_is_running "$pid" || return 1
  printf '%s' "$pid"
}

start_service() {
  local pid second node_version
  if pid="$(running_pid 2>/dev/null)"; then
    echo "Linkora 本地服务已在运行（PID ${pid}）"
    return 0
  fi

  mkdir -p "$STATE_DIR"
  rm -f "$PID_FILE"
  node_version="$(node --version)"
  if [[ "$node_version" != v24.* ]]; then
    echo "提示：项目指定 Node.js 24（.nvmrc），当前为 ${node_version}。" >&2
  fi

  cd "$ROOT_DIR"
  nohup node --env-file-if-exists=.env "$ROOT_DIR/scripts/dev.mjs" --no-watch >> "$LOG_FILE" 2>&1 < /dev/null &
  pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"

  for ((second = 0; second < 60; second++)); do
    if ! service_is_running "$pid"; then
      rm -f "$PID_FILE"
      echo "Linkora 启动失败，请查看日志：$LOG_FILE" >&2
      return 1
    fi
    if curl -fsS --max-time 2 "$API_URL" >/dev/null 2>&1 && curl -fsS --max-time 2 "$WEB_URL" >/dev/null 2>&1; then
      echo "Linkora 本地服务已启动："
      echo "前端：$WEB_URL"
      echo "后端：$API_URL"
      echo "日志：$LOG_FILE"
      return 0
    fi
    sleep 1
  done

  echo "服务进程仍在运行，但前后端尚未就绪；请查看日志：$LOG_FILE" >&2
  return 1
}

stop_service() {
  local pid second
  if ! pid="$(running_pid 2>/dev/null)"; then
    if [[ -f "$PID_FILE" ]]; then rm -f "$PID_FILE"; fi
    echo "Linkora 本地服务当前未运行"
    return 0
  fi

  kill -TERM "$pid"
  for ((second = 0; second < 15; second++)); do
    if ! service_is_running "$pid"; then
      rm -f "$PID_FILE"
      echo "Linkora 本地服务已停止"
      return 0
    fi
    sleep 1
  done

  echo "Linkora 未能在 15 秒内停止（PID ${pid}）；日志：$LOG_FILE" >&2
  return 1
}

show_status() {
  local pid
  if ! pid="$(running_pid 2>/dev/null)"; then
    echo "Linkora 本地服务已停止"
    return 0
  fi

  echo "Linkora 本地服务正在运行（PID ${pid}）"
  if curl -fsS --max-time 2 "$API_URL" >/dev/null 2>&1; then
    echo "后端：就绪"
  else
    echo "后端：未就绪"
  fi
  if curl -fsS --max-time 2 "$WEB_URL" >/dev/null 2>&1; then
    echo "前端：就绪"
  else
    echo "前端：未就绪"
  fi
  echo "日志：$LOG_FILE"
}

case "${1:-}" in
  start) start_service ;;
  restart) stop_service && start_service ;;
  stop) stop_service ;;
  status) show_status ;;
  *)
    echo "用法：$0 {start|restart|stop|status}" >&2
    exit 2
    ;;
esac
