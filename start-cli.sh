#!/usr/bin/env bash
# Open-Mem CLI instance — port 37889, data dir ~/.open-mem-cli/
# Used exclusively by Claude Code CLI (claude command) sessions.
# OpenClaw/TG uses the separate instance on port 37888.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="/tmp/open-mem-cli.log"
HEALTH_URL="http://127.0.0.1:37889/health"
PIDFILE="/tmp/open-mem-cli.pid"

API_KEY="$(python3 -c "
import json
d = json.load(open('$HOME/.openclaw/openclaw.json'))
print(d['models']['providers']['anthropic']['apiKey'])
" 2>/dev/null || echo "")"

if [[ -z "$API_KEY" ]]; then
  echo "[open-mem-cli] ERROR: Could not resolve ANTHROPIC_API_KEY" >&2
  exit 1
fi

pkill -f "open-mem-cli" 2>/dev/null || true
# Kill any bun server.ts on port 37889
lsof -ti:37889 | xargs kill -9 2>/dev/null || true
sleep 1

cd "$SCRIPT_DIR"
ANTHROPIC_API_KEY="$API_KEY" \
C_MEM_WORKER_PORT=37889 \
C_MEM_DATA_DIR="$HOME/.open-mem-cli" \
  nohup bun run src/worker/server.ts >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "[open-mem-cli] Started PID $! on port 37889 — logs at $LOG"

for i in $(seq 1 10); do
  sleep 1
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    echo "[open-mem-cli] Healthy ✅ (port 37889)"
    exit 0
  fi
done

echo "[open-mem-cli] WARNING: health check failed after 10s" >&2
exit 1
