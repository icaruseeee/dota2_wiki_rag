#!/usr/bin/env bash
# dota2 wiki rag 服务管理（直接用 node 起，不依赖 launchd）
#
#   ./scripts/service.sh start      后台启动（默认 http://127.0.0.1:8787）
#   ./scripts/service.sh stop
#   ./scripts/service.sh restart
#   ./scripts/service.sh status
#   ./scripts/service.sh logs       实时跟随日志
#   ./scripts/service.sh check      只做依赖检查
#   ./scripts/service.sh run        前台运行（Ctrl+C 退出）
#
# 环境变量：PORT（默认 8787）、HOST（默认 127.0.0.1）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
LOG_DIR="$ROOT/logs"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$LOG_DIR/server.log"
PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

c_reset=$'\033[0m'; c_dim=$'\033[2m'; c_red=$'\033[31m'
c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_gold=$'\033[33m'

ok()   { printf '  %s✓%s %s\n' "$c_green" "$c_reset" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$c_red" "$c_reset" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_yellow" "$c_reset" "$*"; }

port_open() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }

running() {
  [ -f "$PID_FILE" ] || return 1
  local p
  p="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

check() {
  local failed=0
  printf '依赖检查\n'
  for item in "5432 PostgreSQL" "8080 Embedding" "8081 Chat" "8082 Reranker"; do
    set -- $item
    if port_open "$1"; then ok "$2 :$1"; else bad "$2 :$1 未启动"; failed=1; fi
  done
  if [ "$failed" -ne 0 ]; then
    printf '\n%sllama.cpp 由 launchd 托管，可这样拉起：\n' "$c_dim"
    printf '  launchctl kickstart gui/$(id -u)/com.local.llama.embed\n'
    printf '  launchctl kickstart gui/$(id -u)/com.local.llama.chat\n'
    printf '  launchctl kickstart gui/$(id -u)/com.local.llama.rerank%s\n' "$c_reset"
  fi
  return "$failed"
}

wait_health() {
  for _ in $(seq 1 40); do
    if curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  return 1
}

start() {
  if running; then
    printf '已在运行 (pid %s) → http://%s:%s\n' "$(cat "$PID_FILE")" "$HOST" "$PORT"
    return 0
  fi
  if port_open "$PORT"; then
    bad "端口 $PORT 已被其它进程占用"
    exit 1
  fi

  check || warn '依赖不完整，服务可能启动但请求会失败'
  printf '\n'

  nohup env PORT="$PORT" HOST="$HOST" node "$ROOT/src/server.mjs" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  disown 2>/dev/null || true

  if wait_health; then
    ok "已启动 (pid $(cat "$PID_FILE"))"
    printf '  %shttp://%s:%s%s\n' "$c_gold" "$HOST" "$PORT" "$c_reset"
    printf '  %s日志 %s%s\n' "$c_dim" "$LOG_FILE" "$c_reset"
  else
    bad '启动失败，最近日志：'
    tail -20 "$LOG_FILE" | sed 's/^/    /'
    printf '\n'
    exit 1
  fi
}

stop() {
  if ! running; then
    printf '未在运行\n'
    return 0
  fi
  local p
  p="$(cat "$PID_FILE")"
  kill "$p" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$p" 2>/dev/null || break
    sleep 0.2
  done
  kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
  printf '' >"$PID_FILE"
  ok '已停止'
}

status() {
  if running; then
    ok "运行中 (pid $(cat "$PID_FILE")) → http://$HOST:$PORT"
    curl -fsS "http://$HOST:$PORT/health" 2>/dev/null | sed 's/^/  /' || true
    printf '\n'
  else
    printf '未运行\n'
  fi
  if [ -f "$LOG_FILE" ]; then
    printf '%s最近日志：%s\n' "$c_dim" "$c_reset"
    tail -5 "$LOG_FILE" | sed 's/^/  /'
  fi
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; printf '\n'; start ;;
  status)  status ;;
  logs)    tail -f "$LOG_FILE" ;;
  check)   check ;;
  run)
    check || true
    printf '\n'
    exec env PORT="$PORT" HOST="$HOST" node "$ROOT/src/server.mjs"
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs|check|run}" >&2
    exit 2
    ;;
esac
