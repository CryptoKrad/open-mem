#!/usr/bin/env bash
# Open-Mem startup script — starts the worker with LLM compression enabled
# Called by: gateway startup hook or manually
# Data dir: ~/.open-mem (default)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="/tmp/open-mem.log"
HEALTH_URL="http://127.0.0.1:37888/health"
PIDFILE="/tmp/open-mem.pid"

# Resolve API key from openclaw config
API_KEY="$(python3 -c "
import json
d = json.load(open('$HOME/.openclaw/openclaw.json'))
print(d['models']['providers']['anthropic']['apiKey'])
" 2>/dev/null || echo "")"

if [[ -z "$API_KEY" ]]; then
  echo "[open-mem] ERROR: Could not resolve ANTHROPIC_API_KEY from openclaw config" >&2
  exit 1
fi

# Kill any existing instance
pkill -f "bun run src/worker/server.ts" 2>/dev/null || true
sleep 1

# Start fresh
cd "$SCRIPT_DIR"
ANTHROPIC_API_KEY="$API_KEY" nohup bun run src/worker/server.ts >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "[open-mem] Started PID $! — logs at $LOG"

# Wait for health
for i in $(seq 1 10); do
  sleep 1
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    echo "[open-mem] Healthy ✅"
    exit 0
  fi
done

echo "[open-mem] WARNING: health check failed after 10s" >&2
exit 1
