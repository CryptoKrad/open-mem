# Open-Mem × OpenClaw Integration Guide

This document covers wiring Open-Mem into [OpenClaw](https://github.com/openclaw/openclaw) so that every session automatically builds structured episodic memory — compressed, searchable, and injected back at session start.

---

## How it works

```
OpenClaw session
    │  tool:after_call (every tool)
    ▼
~/.openclaw/hooks/open-mem/handler.ts    ← internal hook (zero-latency)
    │  POST /api/observations
    ▼
Open-Mem worker (port 37888)
    │  LLM compression via Anthropic (Haiku)
    │  FTS5 indexing (porter tokenizer)
    ▼
~/.open-mem/open-mem.db                  ← SQLite, local only
    │
    ├── GET /api/context?project=…       ← injected at next session start
    └── GET /api/search?q=…             ← FTS keyword search
```

**Key properties:**
- Fire-and-forget — hook never blocks OpenClaw response time
- Noise-filtered — 10 low-signal tools skipped (memory_search, tts, canvas, etc.)
- OAuth-aware — works with OpenClaw's native `sk-ant-oat01-*` token (no separate API key needed)
- Priority-sorted context — errors/decisions surface above routine exec output
- Threshold summarization — session summaries auto-generated every 20 observations

---

## Prerequisites

- OpenClaw ≥ 2026.2.18 (adds `tool:after_call` internal hook event)
- [Bun](https://bun.sh) ≥ 1.1.0
- Open-Mem running on port 37888

---

## Quick setup

### 1. Start Open-Mem

```bash
# Default: data at ~/.open-mem, port 37888
cd /path/to/Open-Mem
bun run src/worker/server.ts &
```

Or use the included LaunchAgent template (macOS):

```bash
# Copy and load the LaunchAgent
cp examples/launchagents/com.open-mem.plist ~/Library/LaunchAgents/
# Edit it to set WorkingDirectory to your Open-Mem clone path
launchctl load -w ~/Library/LaunchAgents/com.open-mem.plist
```

Environment variables:
| Variable | Default | Description |
|---|---|---|
| `C_MEM_WORKER_PORT` | `37888` | HTTP listen port |
| `C_MEM_DATA_DIR` | `~/.open-mem` | SQLite DB + auth token directory |
| `ANTHROPIC_API_KEY` | *(auto from OpenClaw)* | API key for LLM compression |

### 2. Install the hook

```bash
mkdir -p ~/.openclaw/hooks/open-mem
cp examples/openclaw-hook/handler.ts ~/.openclaw/hooks/open-mem/handler.ts
```

### 3. Register the hook in `~/.openclaw/openclaw.json`

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "open-mem": { "enabled": true }
      }
    }
  }
}
```

Then restart the gateway: `openclaw gateway restart`

### 4. Set your project name

By default, the hook uses `"default"` as the project namespace. Set it per-session:

```bash
# In your shell profile or the hook config:
export OPEN_MEM_PROJECT="my-project"
```

Or hardcode it in the hook file (`const PROJECT = "my-project"`).

---

## OpenClaw OAuth token — no separate API key needed

OpenClaw stores its Anthropic credentials in `~/.openclaw/openclaw.json` under `models.providers.anthropic.apiKey`. If this is an OAuth token (`sk-ant-oat01-*`), Open-Mem automatically:

1. Reads the token via `src/sdk/openclaw-config.ts`
2. Sends it as `Authorization: Bearer` (not `x-api-key`)
3. Adds the required `anthropic-beta: oauth-2025-04-20,claude-code-20250219` header

This means **zero additional configuration** if you're already running OpenClaw. The compressor uses the same credentials OpenClaw uses.

> **Note:** If you have a standard `sk-ant-api03-*` key, it works identically via the `ANTHROPIC_API_KEY` env var — the auto-detection handles both formats.

---

## Context injection at session start

Once observations are accumulating, inject them at the start of each OpenClaw session via the `open-mem-recall` plugin (or manually via `GET /api/context`).

### Option A: `open-mem-recall` plugin (recommended)

If OpenClaw supports plugin-based context injection (`prependContext`), register `open-mem-recall` in your `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["open-mem-recall"],
    "entries": {
      "open-mem-recall": { "enabled": true }
    }
  }
}
```

### Option B: Manual recall

Fetch and paste the context block manually:

```bash
AUTH=$(cat ~/.open-mem/auth.token)
curl -s "http://127.0.0.1:37888/api/context?project=my-project" \
  -H "Authorization: Bearer $AUTH"
```

### Option C: Topic-aware recall (FTS-ranked)

Pass a `topic` query param to get observations ranked by relevance rather than recency:

```bash
curl -s "http://127.0.0.1:37888/api/context?project=my-project&topic=solana+build+errors" \
  -H "Authorization: Bearer $AUTH"
```

---

## Context token budget

The context block is capped at **~1,800 tokens** by default (configurable in `context-builder.ts`). Observations are:

1. Sorted by type priority: `error > bugfix > decision > discovery > change > feature > refactor > config > other`
2. Trivial `other`-type observations dropped when session summaries exist
3. Narrative truncated to first sentence
4. Facts capped at 2 per observation
5. `files_read` omitted (only `files_modified` shown)

Once 20+ observations accumulate for a session, summarization fires automatically and produces a compact `request / work_done / discoveries / next_steps` block — much higher signal at lower token cost.

---

## Two-instance setup (OpenClaw + CLI)

If you want separate memory for OpenClaw sessions and terminal/CLI sessions:

```bash
# OpenClaw instance (port 37888)
C_MEM_WORKER_PORT=37888 C_MEM_DATA_DIR=~/.open-mem bun run src/worker/server.ts

# CLI instance (port 37889)
C_MEM_WORKER_PORT=37889 C_MEM_DATA_DIR=~/.open-mem-cli bun run src/worker/server.ts
```

Point the OpenClaw hook at port 37888 (`OPEN_MEM_URL=http://127.0.0.1:37888`).
Point your CLI memory tool at port 37889 (`OPEN_MEM_URL=http://127.0.0.1:37889`).

Each instance maintains its own SQLite DB, auth token, and FTS index.

---

## Verifying it works

```bash
AUTH=$(cat ~/.open-mem/auth.token)

# Health
curl -s http://127.0.0.1:37888/health -H "Authorization: Bearer $AUTH"
# → {"status":"ok","queue":{"pending":0,"failed":0},...}

# Recent observations
curl -s "http://127.0.0.1:37888/api/observations?project=my-project&limit=5" \
  -H "Authorization: Bearer $AUTH"

# FTS search
curl -s "http://127.0.0.1:37888/api/search?q=your+query&project=my-project" \
  -H "Authorization: Bearer $AUTH"

# Context block (check X-Token-Estimate header)
curl -sD - "http://127.0.0.1:37888/api/context?project=my-project" \
  -H "Authorization: Bearer $AUTH" | grep -E "X-Token|<c-mem"
```

After a few tool calls, observations should appear with real LLM-compressed titles and narratives (not `"exec — session prompt #0"`).

---

## Troubleshooting

**Compression failing with `401 invalid x-api-key`**
→ Your token is an OAuth token; upgrade to a version of Open-Mem that includes `src/sdk/openclaw-config.ts` (this repo, commit after Feb 26 2026).

**Compression failing with `404 model not found`**
→ OAuth tokens only accept new-style model IDs. `claude-3-5-haiku-20241022` returns 404; `claude-haiku-4-5` works. Fixed in the same commit.

**Compression failing with `OAuth authentication is currently not supported`**
→ Missing `anthropic-beta: oauth-2025-04-20` header. Upgrade to the version of Open-Mem with the OAuth beta header fix.

**All observations are `type: other` with title `"exec — session prompt #0"`**
→ Compression is not running. Either: (a) no API key resolved, (b) the server started before `ANTHROPIC_API_KEY` was set. Check `ANTHROPIC_API_KEY` env in the process running `server.ts`.

**Hook not firing**
→ Confirm `hooks.internal.entries.open-mem.enabled: true` in `openclaw.json` and that you restarted the gateway. Requires OpenClaw ≥ 2026.2.18.
