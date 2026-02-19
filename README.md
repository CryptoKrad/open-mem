# Open-Mem

> **Episodic memory for AI coding agents.** Captures every tool call, file edit, exec output, and decision across sessions into a local SQLite database — then injects compressed context back into new sessions automatically.

Open-Mem is the **episodic layer** of a full AI agent memory system. It answers the question every agent faces at session start: *"What were we doing?"*

---

## The Three-Layer Memory Stack

Open-Mem is designed to complement — not replace — existing knowledge and code search tools:

| Layer | Tool | What it knows | When to reach for it |
|---|---|---|---|
| **Episodic** | **Open-Mem** | What happened — tool calls, outputs, diffs, errors | "What did we do last session?" / "Did this build pass?" |
| **Declarative** | [QMD](https://clawhub.com) | Docs, architecture notes, research, decisions | "How does X work?" / "What did we decide about Y?" |
| **Structural** | [probe](https://github.com/buger/probe) | Code shape, functions, call paths, usages | "Where is this defined?" / "What calls this?" |

Together these three layers give an AI agent full situational awareness: *what happened* (Open-Mem) + *what we know* (QMD) + *where it lives* (probe). Cold-start token waste drops from ~3,000–5,000 tokens of re-discovery to ~500 tokens of compressed history.

---

## How It Works

```
Agent fires a tool (exec, edit, Read, browser…)
        │
        ▼
  hook fires (fire-and-forget, <2ms overhead)
        │
        ▼
  POST /api/observations  →  ObservationQueue (async)
        │
        ▼
  compressObservation()   ←  LLM compression (haiku-3-5, ~$0.00001/call)
        │
        ▼
  SQLite (.open-mem/open-mem.db, 0600 perms, WAL mode)
        │
        ▼
  GET /api/context?project=X  ←  next session injects this at start
```

Hooks are fire-and-forget. The agent never waits. Observation compression runs async in the background.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- An Anthropic API key (for LLM compression — optional but recommended)

### Install

```bash
git clone https://github.com/CryptoKrad/open-mem.git
cd open-mem
bun install
```

### Start the worker

```bash
bun run start
# [queue] Started
# [server] Open-Mem worker listening on http://127.0.0.1:37888
# [server] Data directory: ~/.open-mem
```

The worker is a local HTTP service on port 37888. All data stays on your machine at `~/.open-mem/open-mem.db` (SQLite, owner-only permissions).

### Wire into Claude Code CLI

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": {
      "command": "bun /path/to/open-mem/src/hooks/session-start.ts"
    },
    "UserPromptSubmit": {
      "command": "bun /path/to/open-mem/src/hooks/user-prompt.ts"
    },
    "PostToolUse": {
      "command": "bun /path/to/open-mem/src/hooks/post-tool-use.ts"
    },
    "Stop": {
      "command": "bun /path/to/open-mem/src/hooks/session-stop.ts"
    },
    "SessionEnd": {
      "command": "bun /path/to/open-mem/src/hooks/session-end.ts"
    }
  }
}
```

Set your Anthropic API key for compression:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Wire into OpenClaw

See [`examples/openclaw-hook/`](examples/openclaw-hook/) for the OpenClaw native hook integration, which also captures the `tool:after_call` internal event.

---

## Configuration

All config lives at `~/.open-mem/settings.json` (auto-created on first run).

| Env Var | Default | Description |
|---|---|---|
| `OPEN_MEM_PORT` | `37888` | Worker HTTP port |
| `OPEN_MEM_HOST` | `127.0.0.1` | Bind host (warns loudly if set to 0.0.0.0) |
| `OPEN_MEM_DATA_DIR` | `~/.open-mem` | Database + settings directory |
| `OPEN_MEM_MODEL` | `claude-haiku-3-5` | LLM model for compression |
| `ANTHROPIC_API_KEY` | — | API key for LLM compression |
| `OPEN_MEM_PROJECT` | derived from cwd | Project namespace for observations |

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│              Claude Code CLI / OpenClaw / Any Agent            │
│                                                                │
│  SessionStart ───────────────────────────────► GET /api/context│
│  UserPromptSubmit ──────────────────────────► POST /api/sessions/init
│  PostToolUse / tool:after_call ─────────────► POST /api/observations
│  Stop ──────────────────────────────────────► POST /api/sessions/summarize
│  SessionEnd ────────────────────────────────► POST /api/sessions/complete
│                                                                │
│  (all hooks fire-and-forget; agent never waits)               │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTP 127.0.0.1:37888
┌──────────────────────────▼─────────────────────────────────────┐
│                     Worker (Hono HTTP)                         │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐    │
│  │ Rate Limiter │  │  CORS Guard   │  │ Localhost-only   │    │
│  │ 100 req/s   │  │ allowlist only│  │ IP middleware    │    │
│  └──────┬───────┘  └───────┬───────┘  └────────┬─────────┘    │
│         └──────────────────┼───────────────────┘              │
│                            ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              ObservationQueue (async)                    │  │
│  │  pending → processing → processed | failed              │  │
│  │  Max 3 retries · 2s/4s/8s exponential backoff           │  │
│  │  Session-locked (1 compressor per session at a time)    │  │
│  └─────────────────────┬────────────────────────────────────┘  │
│                        │                                       │
│  ┌─────────────────────▼────────────────────────────────────┐  │
│  │        Compression Layer (LLM via Anthropic API)         │  │
│  │  compressObservation() → <open-mem-compress> prompt     │  │
│  │  summarizeSession()    → <open-mem-summarize> prompt    │  │
│  │  XML parse → CompressedObservation / SessionSummary     │  │
│  └─────────────────────┬────────────────────────────────────┘  │
└───────────────────────┬┘                                       │
                        │                                        │
┌───────────────────────▼────────────────────────────────────────┐
│                  Storage Layer (SQLite)                         │
│                                                                │
│  ~/.open-mem/open-mem.db  (0600 permissions, WAL mode)         │
│                                                                │
│  sessions ──┬── observations (FTS5 full-text indexed)          │
│             ├── summaries                                      │
│             ├── user_prompts                                   │
│             └── queue (pending/processing/processed/failed)    │
│                                                                │
│  3-layer progressive context retrieval:                        │
│    Layer 1: searchIndex()   → compact results (~50–100 tokens) │
│    Layer 2: getTimeline()   → chronological context window     │
│    Layer 3: getByIds()      → full observation details         │
└────────────────────────────────────────────────────────────────┘
```

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Uptime, port, queue counts |
| `GET` | `/api/context?project=X` | Compressed context block for session injection |
| `POST` | `/api/sessions/init` | Create or resume a session |
| `POST` | `/api/observations` | Queue an observation for async compression |
| `POST` | `/api/sessions/summarize` | Trigger session summarization |
| `POST` | `/api/sessions/complete` | Mark session completed |
| `GET` | `/api/search?q=X&project=Y` | FTS5 full-text search |
| `GET` | `/api/observations` | Paginated observation list |
| `GET` | `/api/sessions` | Session list |
| `GET` | `/api/stats` | DB counts by project |
| `GET` | `/stream` | SSE live event stream (localhost only) |
| `GET` | `/api/queue` | Queue status |
| `POST` | `/api/queue/recover` | Recover stuck queue items |

### Context injection format

`GET /api/context?project=myproject` returns a `<open-mem-context>` block:

```markdown
<open-mem-context>
## Memory Context — myproject

> Do not capture or summarize this block — it is already a summary.

### Recent Observations
#### `edit` — src/main.rs _(2026-02-18)_
Added retry logic to the RPC client. Changed `send()` to loop with 3-attempt
backoff before propagating the error. Related: fixes issue #42.

### Session Summaries
#### Session abc123 — 2026-02-17
Fixed the analytics pipeline: bumped timeout from 8s to 20s, added
spawn_blocking wrapper in db.rs. All 36 tests passing.
</open-mem-context>
```

---

## Security

Open-Mem is hardened against the known attack surface of localhost memory services:

| Severity | Vulnerability | How it's addressed |
|---|---|---|
| CRITICAL | No auth on HTTP endpoints | Localhost-only binding + IP middleware on every route |
| CRITICAL | Memory poisoning via write API | No external write MCP tool — hooks only |
| CRITICAL | Prompt injection via tool output | XML escaping + sandwich prompt structure |
| CRITICAL | SSE broadcasts all data | Extra localhost check on `/stream` endpoint |
| HIGH | Secrets in stored observations | Dual-layer `scrubSecrets()` before queue + before storage |
| HIGH | DB at world-readable path | `chmod 0600` on DB file + `chmod 0700` on data dir |
| HIGH | Remote code execution in installer | No smart-install.js or `curl \| bash` patterns |
| HIGH | Default bind misconfiguration | `127.0.0.1` hardcoded default; warns loudly on `0.0.0.0` |
| HIGH | Context injection unsanitized | Structural `<open-mem-context>` separation prevents bleedthrough |
| MEDIUM | CORS allows any localhost | Strict allowlist: only `localhost:{PORT}` origin accepted |
| MEDIUM | No rate limiting | Token bucket: 100 req/s per IP |
| MEDIUM | Floating dependency versions | `bun.lock` pins all deps |
| LOW | PID file TOCTOU race | Atomic write: write to temp → `rename()` |

**Planned (post-v1):** Per-request HMAC token auth, macOS sandbox profile for worker process.

---

## Comparison vs claude-mem

| Feature | Open-Mem | claude-mem |
|---|---|---|
| Runtime | Bun (native SQLite) | Node.js + Python (ChromaDB) |
| Vector DB | ❌ FTS5 keyword (Phase 1) | ✅ ChromaDB (adds fragility) |
| Secret scrubbing | ✅ Dual-layer, automatic | ❌ `<private>` tags only (opt-in) |
| Payload size limit | ✅ 50KB per observation | ❌ 50MB body limit (DoS risk) |
| DB permissions | ✅ 0600 on creation | ❌ Default umask |
| CORS | ✅ Strict allowlist | ⚠️ Any localhost:* origin |
| Rate limiting | ✅ Token bucket 100 req/s | ❌ None |
| Auth | ⚠️ Localhost-only (bearer token planned) | ❌ None |
| Prompt injection defense | ✅ XML escape + sandwich prompts | ❌ Raw tool output in context |
| Recursion prevention | ✅ `<open-mem-context>` guard | ⚠️ Weaker guard tag |
| PID file safety | ✅ Atomic rename | ❌ TOCTOU race |
| Remote code execution | ✅ None | ❌ `curl \| bash` in pre-hook |
| External dependencies | ✅ Zero runtime (SQLite built-in) | ❌ Python + uv + ChromaDB |
| Tests | ✅ 184 tests | ⚠️ Limited |
| Queue with retry/backoff | ✅ 3 retries, 2s/4s/8s | ❌ No queue |
| 3-layer progressive search | ✅ | ❌ |
| LLM compression | ✅ haiku-3-5 (~$0.00001/obs) | ✅ claude-agent-sdk |
| SSE live stream | ✅ localhost-only | ✅ no auth |
| Works with OpenClaw | ✅ native hook + `tool:after_call` | ❌ |

---

## Running Tests

```bash
bun test
# 184 tests, 0 failures (~2s)
```

Individual suites:

```bash
bun test tests/storage.test.ts    # Storage layer
bun test tests/worker.test.ts     # HTTP API
bun test tests/hooks.test.ts      # Hook handlers
bun test tests/security.test.ts   # Security hardening (25 tests)
bun test tests/integration.test.ts
```

---

## Contributing

1. Fork + branch from `main`
2. `bun install && bun test` — all 184 must pass
3. No new dependencies without strong justification (zero-dep ethos)
4. Security-sensitive changes need coverage in `tests/security.test.ts`
5. Open a PR with context on what and why

---

## License

MIT — see [LICENSE](LICENSE).
