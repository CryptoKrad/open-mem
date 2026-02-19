# Open-Mem — OpenClaw Hook

This example wires Open-Mem into [OpenClaw](https://github.com/openclaw/openclaw) using its native hook system.

OpenClaw's hook architecture is two-tier:
- **Internal hooks** (`tool:after_call`, `gateway:startup`, `command:*`) — fired from the gateway process directly
- **External hooks** (subprocess) — Claude Code CLI-style process hooks

This handler uses **internal hooks**, giving it zero-latency capture of every tool call without spawning subprocesses.

> **Note:** The `tool:after_call` internal event requires OpenClaw ≥ 2026.2.18 or the patch in [PR #20580](https://github.com/openclaw/openclaw/pull/20580).

---

## Setup

### 1. Copy the handler

```bash
mkdir -p ~/.openclaw/hooks/open-mem
cp examples/openclaw-hook/handler.ts ~/.openclaw/hooks/open-mem/handler.ts
```

### 2. Register the hook in openclaw.json

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "open-mem": {
          "enabled": true
        }
      }
    }
  }
}
```

### 3. Configure (optional)

Set environment variables to override defaults:

| Variable | Default | Description |
|---|---|---|
| `OPEN_MEM_URL` | `http://127.0.0.1:37888` | Worker URL |
| `OPEN_MEM_TOKEN_PATH` | `~/.open-mem/auth.token` | Auth token path |
| `OPEN_MEM_PROJECT` | CWD basename | Project namespace |

### 4. Restart OpenClaw

```bash
openclaw gateway restart
```

Check the logs — on startup you'll see:

```
[open-mem] ✅ Worker reachable at http://127.0.0.1:37888
```

---

## What Gets Captured

Every tool call fired by the OpenClaw agent is captured as an observation:

| Tool | What's stored |
|---|---|
| `exec` | Command, exit code, full stdout/stderr |
| `edit` | File path, unified diff |
| `write` | File path, content written |
| `read` / `Read` | File path, content read |
| `browser` | Action, URL, result |
| `gateway` | Action, result |
| `process` | Session ID, output |

All stored observations are scrubbed for secrets before storage.

---

## Retrieving Context

At the start of a new session, pull the memory context:

```bash
curl -s -H "Authorization: Bearer $(cat ~/.open-mem/auth.token)" \
  "http://127.0.0.1:37888/api/context?project=$(basename $PWD)"
```

Or wire the `GET /api/context` call into your `SessionStart` hook to inject it automatically.
