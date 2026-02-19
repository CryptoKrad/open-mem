# C-Mem Build Strategy Report
## Worker Service + SDK Integration + Original Build Plan

**Date**: 2026-02-18  
**Author**: Analyst (Deep Research Agent)  
**Purpose**: Drive 3 parallel Sonnet builders to construct an original persistent memory system for OpenClaw

---

## Table of Contents

1. [Worker Service Analysis](#1-worker-service-analysis)
2. [SDK Agent Deep Dive](#2-sdk-agent-deep-dive)
3. [Bun vs Alternatives](#3-bun-vs-alternatives)
4. [Python Dependency Elimination](#4-python-dependency-elimination)
5. [OpenClaw Hook Integration](#5-openclaw-hook-integration)
6. [Original Build Plan](#6-original-build-plan)
7. [Phase Plan for 3 Parallel Builders](#7-phase-plan-for-3-parallel-builders)

---

## 1. Worker Service Analysis

### The 22 Endpoints — Fully Classified

claude-mem's Express.js worker on port 37777 exposes 22 endpoints across 6 categories. Here is the complete inventory with essentiality ratings:

#### Category A: Viewer & Health (3 endpoints)

| # | Endpoint | Method | Purpose | Essential? |
|---|----------|--------|---------|------------|
| 1 | `/` | GET | Serve React viewer UI | P2 (nice-to-have) |
| 2 | `/health` | GET | Worker health check (status, uptime, port) | **P0 (critical)** |
| 3 | `/stream` | GET | SSE real-time events (observation-created, session-summary-created, user-prompt-created) | P2 |

#### Category B: Data Retrieval (10 endpoints)

| # | Endpoint | Method | Purpose | Essential? |
|---|----------|--------|---------|------------|
| 4 | `/api/prompts` | GET | Paginated user prompts (project, limit, offset) | P1 |
| 5 | `/api/observations` | GET | Paginated observations | **P0** |
| 6 | `/api/summaries` | GET | Paginated session summaries | **P0** |
| 7 | `/api/observation/:id` | GET | Single observation by ID | **P0** |
| 8 | `/api/observations/batch` | POST | Batch fetch observations by IDs array | **P0** |
| 9 | `/api/session/:id` | GET | Single session by ID | P1 |
| 10 | `/api/prompt/:id` | GET | Single prompt by ID | P1 |
| 11 | `/api/stats` | GET | Database statistics by project | P2 |
| 12 | `/api/projects` | GET | List distinct projects | P1 |
| 13 | `/api/context/inject` | GET | Fetch formatted context for SessionStart injection | **P0** |

#### Category C: Search (3 endpoints)

| # | Endpoint | Method | Purpose | Essential? |
|---|----------|--------|---------|------------|
| 14 | `/api/search` | GET | FTS5 full-text search across observations | **P0** |
| 15 | `/api/timeline` | GET | Chronological context around an observation | P1 |
| 16 | — | — | (Batch endpoint #8 doubles as MCP get_observations) | — |

#### Category D: Settings (2 endpoints)

| # | Endpoint | Method | Purpose | Essential? |
|---|----------|--------|---------|------------|
| 17 | `/api/settings` | GET | Retrieve user settings | P2 |
| 18 | `/api/settings` | POST | Save user settings | P2 |

#### Category E: Queue Management (2 endpoints)

| # | Endpoint | Method | Purpose | Essential? |
|---|----------|--------|---------|------------|
| 19 | `/api/pending-queue` | GET | Queue status (pending/processing/failed/stuck counts) | **P0** |
| 20 | `/api/pending-queue/process` | POST | Manual recovery trigger for stuck observations | **P0** |

#### Category F: Session Management (4 endpoints)

| # | Endpoint | Method | Purpose | Essential? |
|---|----------|--------|---------|------------|
| 21 | `/sessions/:id/init` | POST | Initialize session with project + prompt | **P0** |
| 22 | `/sessions/:id/observations` | POST | Add observation (tool_name, tool_input, tool_result) | **P0** |
| 23 | `/sessions/:id/summarize` | POST | Trigger session summary generation | **P0** |
| 24 | `/sessions/:id/status` | GET | Session status (observation count, summary count) | P1 |

### Minimal Viable HTTP API for Our Build

**MVP (11 endpoints)**:

```
GET  /health                           # Worker liveness
GET  /api/context/inject               # SessionStart context injection
POST /sessions/:id/init                # Initialize session
POST /sessions/:id/observations        # Queue observation
POST /sessions/:id/summarize           # Trigger summary
GET  /sessions/:id/status              # Session status
GET  /api/observations                 # Paginated observations list
GET  /api/observation/:id              # Single observation
POST /api/observations/batch           # Batch fetch by IDs
GET  /api/search                       # FTS5 search
GET  /api/pending-queue                # Queue health check
```

**Phase 2 adds**: `/api/timeline`, `/api/summaries`, `/api/prompts`, `/api/projects`, SSE `/stream`, settings endpoints, manual recovery `/api/pending-queue/process`.

**Phase 3 adds**: Viewer UI (`/`), stats, prompt by ID, session by ID.

---

## 2. SDK Agent Deep Dive

### XML Prompt/Response Cycle

claude-mem uses `@anthropic-ai/claude-agent-sdk` to process observations asynchronously. The cycle works as follows:

#### Compression Prompt Structure

The SDK builds XML-structured prompts that instruct Claude to compress raw tool observations into structured data. The prompt contains:

```xml
<system>
You are a memory compression agent. Given a tool observation from a coding session,
extract the essential information into a structured format.
</system>

<observation>
  <tool_name>Edit</tool_name>
  <tool_input>
    <file_path>/src/auth.ts</file_path>
    <old_string>if (token.expired)</old_string>
    <new_string>if (token.expired || !token.valid)</new_string>
  </tool_input>
  <tool_response>File edited successfully, 1 line changed</tool_response>
  <session_context>
    <project>my-app</project>
    <prompt_number>2</prompt_number>
    <user_prompt>Fix the authentication bug where expired tokens still work</user_prompt>
  </session_context>
</observation>
```

#### Expected XML Response

Claude responds with structured observations:

```xml
<compressed_observation>
  <type>bugfix</type>
  <title>Fixed auth token validation to check both expiry and validity</title>
  <subtitle>Token check was incomplete</subtitle>
  <narrative>Added !token.valid check to the auth guard in /src/auth.ts.
  Previously, expired tokens that were still structurally valid could
  bypass authentication. The fix adds a dual condition check.</narrative>
  <facts>
    <fact>Auth guard in /src/auth.ts only checked token.expired</fact>
    <fact>Added !token.valid as additional condition</fact>
  </facts>
  <concepts>
    <concept>problem-solution</concept>
    <concept>gotcha</concept>
  </concepts>
  <files_read></files_read>
  <files_modified>
    <file>/src/auth.ts</file>
  </files_modified>
</compressed_observation>
```

#### Observation Types

The SDK classifies observations into 6 types:
- `decision` — Architectural or design decisions
- `bugfix` — Bug fixes and corrections
- `feature` — New features or capabilities
- `refactor` — Code refactoring and cleanup
- `discovery` — Learnings about the codebase
- `change` — General changes and modifications

#### Summary Prompt Structure

For session summaries (triggered on Stop hook), the prompt structure is:

```xml
<summarize>
  <session_observations>
    <!-- All processed observations for this session -->
  </session_observations>
  <last_user_message>...</last_user_message>
  <last_assistant_message>...</last_assistant_message>
</summarize>
```

Expected response:

```xml
<summary>
  <request>User's original request</request>
  <investigated>What was examined</investigated>
  <learned>Key discoveries</learned>
  <completed>Work finished</completed>
  <next_steps>Remaining tasks</next_steps>
  <files_read><file>...</file></files_read>
  <files_modified><file>...</file></files_modified>
  <notes>Additional context</notes>
</summary>
```

### Event-Driven Queue & Race Condition Prevention

The processing model prevents race conditions through several mechanisms:

1. **Sequential per-session processing**: Each session gets its own SDK agent. Observations within a session are processed sequentially (not parallel). This guarantees ordering.

2. **Status state machine**: Queue items transition through `pending → processing → processed/failed`. Only items in `pending` are picked up. The `processing` state acts as a lock.

3. **Stuck detection**: Items in `processing` state for >5 minutes are considered stuck. The manual recovery endpoint resets them to `pending`.

4. **Fire-and-forget hooks**: Hooks POST to the worker with a 2-second timeout and don't wait for AI processing. This decouples capture speed from processing speed.

5. **Idempotent session creation**: `INSERT OR IGNORE` on `claude_session_id` ensures multiple hooks hitting the same session don't create duplicates.

### Retry/Backoff Patterns

- **SDK API errors**: Exponential backoff (implementation in worker.ts)
- **Worker health checks**: Max 10 seconds retry on SessionStart with polling
- **SSE reconnection**: Exponential backoff with jitter (viewer UI)
- **Max retry count**: 3 attempts per observation before marking as `failed`

---

## 3. Bun vs Alternatives

### Why claude-mem Uses Bun

1. **Process management**: Bun spawns the worker as a detached child process, tracks it via PID file at `~/.claude-mem/worker.pid`, and handles SIGTERM/SIGKILL graceful shutdown
2. **Fast startup**: Bun starts faster than Node.js for the worker service
3. **Native SQLite**: `bun:sqlite` provides synchronous, zero-dependency SQLite access
4. **TypeScript execution**: Runs .ts files directly without transpilation step during development
5. **Cross-platform**: Works on macOS, Linux, Windows without PM2 (which had PATH issues on Windows)

### Could We Use Node.js child_process Instead?

**Yes, absolutely.** The ProcessManager in claude-mem is ~100 lines of code. Here's the core pattern:

```typescript
// What Bun's process management actually does:
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

const PID_FILE = '~/.c-mem/worker.pid';

function startWorker() {
  const child = spawn('node', ['worker-service.js'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
}

function stopWorker() {
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));
  process.kill(pid, 'SIGTERM');
  setTimeout(() => {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }, 5000);
  unlinkSync(PID_FILE);
}

function isWorkerRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));
  try { process.kill(pid, 0); return true; } catch { return false; }
}
```

### Our Recommendation

**Use Bun for the worker service.** Krad already has Bun installed. The `bun:sqlite` native module eliminates the `better-sqlite3` compilation headache. If we later want pure Node.js, the migration cost is low (swap `bun:sqlite` for `better-sqlite3` and change the spawn command).

The process management pattern is trivially portable — it's just PID file + spawn + kill signals. The actual value of Bun here is `bun:sqlite`, not the process management.

---

## 4. Python Dependency Elimination

### The Problem

claude-mem uses ChromaDB for vector/semantic search. ChromaDB requires:
- Python 3.8+
- `uv` package manager
- ~200MB of Python dependencies
- Ongoing Python process (chroma-mcp server)

This violates Krad's $0/local-first/no-Python constraint.

### The Solution: QMD Replaces ChromaDB

Krad already has QMD (vector store). Here's how we replace ChromaDB entirely:

#### What ChromaDB Actually Does

1. **Embedding generation**: Converts observation text → vector embeddings
2. **Similarity search**: Given a query vector, find nearest neighbors
3. **Hybrid search**: Combine vector similarity with keyword filtering
4. **Metadata filtering**: Filter by project, type, date

#### QMD Replacement Strategy

| ChromaDB Feature | QMD Equivalent | Notes |
|-----------------|----------------|-------|
| Vector embeddings | QMD native embeddings | Use Anthropic's embedding model or local model |
| Similarity search | QMD nearest-neighbor | Same capability |
| Metadata filtering | SQLite WHERE clauses | Filter in SQL, vector search in QMD |
| Hybrid search | SQLite FTS5 + QMD | Two-phase: FTS5 for keyword, QMD for semantic |

#### Hybrid Search Architecture (No Python)

```
Query → FTS5 Search (keyword matches) ──┐
                                         ├── Merge + Re-rank
Query → QMD Search (semantic matches) ──┘
```

**FTS5 handles**: Exact keyword matching, boolean queries, phrase search  
**QMD handles**: Semantic similarity, "find related concepts"  
**Merge strategy**: Score normalization + weighted combination (0.6 FTS5 + 0.4 QMD for keyword-heavy, inverse for semantic-heavy)

#### Graceful Degradation

If QMD is unavailable, fall back to FTS5-only search. claude-mem already does this for ChromaDB — we maintain the same pattern.

### Embedding Strategy

For the $0 constraint, two options:

1. **Anthropic embeddings** (preferred): Use `text-embedding-3-small` via existing Anthropic API key. Costs are negligible (~$0.02 per 1M tokens).
2. **Local embeddings** (fully offline): Use a lightweight ONNX model via `@xenova/transformers` in Node.js. No Python needed. Models like `all-MiniLM-L6-v2` (23MB) work well.

**Recommendation**: Start with FTS5-only (Phase 1), add QMD semantic search in Phase 2.

---

## 5. OpenClaw Hook Integration

### claude-mem's 5 Hook Stages

| Stage | Hook | Trigger | What It Does |
|-------|------|---------|-------------|
| 1 | SessionStart | User opens session | Inject context from previous sessions |
| 2 | UserPromptSubmit | User submits prompt | Create session record, save prompt |
| 3 | PostToolUse | Claude uses any tool | Queue observation for AI compression |
| 4 | Stop | User stops/pauses | Generate session summary |
| 5 | SessionEnd | Session closes | Mark session completed |

### OpenClaw Session Lifecycle Events

OpenClaw manages sessions through its gateway daemon. The key integration points:

| OpenClaw Event | Equivalent claude-mem Hook | Mapping Strategy |
|---------------|---------------------------|------------------|
| **Session creation** (agent session starts) | SessionStart | Gateway emits event when new session begins. Our hook fetches context and injects via system prompt or session config. |
| **User message received** (incoming message in channel) | UserPromptSubmit | Each user message in Telegram/Discord/etc triggers session. We intercept the message, create/update session record, save prompt. |
| **Tool execution** (agent calls a tool) | PostToolUse | OpenClaw's tool execution pipeline. We add a middleware/callback that fires after each tool returns, posting the observation to our worker. |
| **Session idle/pause** (agent finishes responding) | Stop | After the agent's response is sent, we trigger summary generation. Could be on response completion or on a configurable idle timeout. |
| **Session end/cleanup** | SessionEnd | When session is explicitly ended or times out, mark session completed. |

### Integration Architecture — No Forking Required

OpenClaw supports plugins/hooks. The integration layer is a **standalone HTTP bridge** that:

1. **Listens** for OpenClaw session lifecycle events (webhook callbacks or event subscription)
2. **Translates** events into our worker HTTP API calls
3. **Injects** context by modifying the session's system prompt or context files

```
┌────────────────────────────────────────────────────┐
│ OpenClaw Gateway                                    │
│                                                     │
│  Session Start ──→ C-Mem Hook Bridge ──→ Worker    │
│  User Message  ──→ C-Mem Hook Bridge ──→ Worker    │
│  Tool Result   ──→ C-Mem Hook Bridge ──→ Worker    │
│  Response Done ──→ C-Mem Hook Bridge ──→ Worker    │
│  Session End   ──→ C-Mem Hook Bridge ──→ Worker    │
└────────────────────────────────────────────────────┘
```

### OpenClaw Integration Methods

There are three viable approaches (non-mutually exclusive):

#### Approach A: AGENTS.md Context Injection (Simplest)

- On SessionStart, write/update a context file (e.g., `MEMORY_CONTEXT.md`) in the workspace
- OpenClaw already reads `AGENTS.md` and workspace files
- Our hook just needs to write the memory index to a file that gets picked up

**Pros**: Zero coupling, works today  
**Cons**: Delayed context (file must be read), no real-time injection

#### Approach B: Gateway Plugin/Middleware

- Register as an OpenClaw plugin that hooks into the session lifecycle
- Use `openclaw` CLI or gateway API to register event callbacks
- This is how claude-mem's own OpenClaw integration works (`curl -fsSL https://install.cmem.ai/openclaw.sh`)

**Pros**: Proper lifecycle integration, real-time  
**Cons**: Requires understanding OpenClaw plugin API

#### Approach C: Dual-Mode (Recommended)

- **Context injection via workspace files** (Approach A) for MVP
- **Gateway plugin** (Approach B) for production integration
- Both use the same worker HTTP API — the only difference is how events arrive

### Privacy Tags

Our implementation must support the dual-tag system:
- `<private>...</private>` — User-controlled, content never stored
- `<c-mem-context>...</c-mem-context>` — Recursion prevention (injected context is not re-captured)

---

## 6. Original Build Plan

### File/Folder Structure

```
~/C-Mem/
├── src/
│   ├── hooks/                      # Hook implementations
│   │   ├── types.ts                # Hook input/output type contracts
│   │   ├── session-start.ts        # Context injection hook
│   │   ├── user-prompt.ts          # Session creation + prompt capture
│   │   ├── post-tool-use.ts        # Observation capture + queue
│   │   ├── session-stop.ts         # Summary generation trigger
│   │   ├── session-end.ts          # Session completion marker
│   │   ├── privacy.ts              # Privacy tag stripping utilities
│   │   └── bridge.ts               # OpenClaw ↔ C-Mem event bridge
│   │
│   ├── worker/                     # Worker HTTP service
│   │   ├── server.ts               # HTTP server (Hono/Express)
│   │   ├── routes/
│   │   │   ├── health.ts           # GET /health
│   │   │   ├── context.ts          # GET /api/context/inject
│   │   │   ├── sessions.ts         # Session management routes
│   │   │   ├── observations.ts     # Observation CRUD routes
│   │   │   ├── search.ts           # FTS5 search routes
│   │   │   └── queue.ts            # Queue management routes
│   │   ├── queue/
│   │   │   ├── manager.ts          # Queue state machine
│   │   │   └── processor.ts        # Observation processing loop
│   │   └── sse.ts                  # Server-Sent Events (Phase 2)
│   │
│   ├── sdk/                        # AI compression engine
│   │   ├── prompts.ts              # XML prompt builders
│   │   ├── parser.ts               # XML response parser
│   │   ├── agent.ts                # SDK agent loop (event-driven)
│   │   └── types.ts                # Compression schema types
│   │
│   ├── storage/                    # Data layer
│   │   ├── db.ts                   # SQLite connection (bun:sqlite)
│   │   ├── migrations.ts           # Schema migrations
│   │   ├── session-store.ts        # CRUD operations
│   │   ├── session-search.ts       # FTS5 search service
│   │   └── types.ts                # Database types
│   │
│   ├── process/                    # Process management
│   │   ├── manager.ts              # PID file + spawn/kill
│   │   └── health.ts               # Health check utilities
│   │
│   └── shared/                     # Shared utilities
│       ├── config.ts               # Configuration loader
│       ├── paths.ts                # File path conventions
│       ├── logger.ts               # Structured logging
│       └── constants.ts            # Port, timeouts, etc.
│
├── tests/
│   ├── hooks/                      # Hook unit tests
│   ├── worker/                     # Worker integration tests
│   ├── storage/                    # Database tests
│   └── sdk/                        # SDK prompt/parse tests
│
├── scripts/
│   ├── build.ts                    # Build script (esbuild)
│   ├── dev.ts                      # Development mode
│   └── install.ts                  # First-run setup
│
├── dist/                           # Built output
│   ├── worker.js                   # Bundled worker service
│   ├── hooks/                      # Bundled hook scripts
│   └── bridge.js                   # Bundled OpenClaw bridge
│
├── research/                       # Research documents
│   ├── 01-*.md
│   ├── 02-*.md
│   └── 03-build-strategy.md       # This document
│
├── docs/                           # API documentation
├── benchmark/                      # Performance benchmarks
├── package.json
├── tsconfig.json
└── bunfig.toml
```

### Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Language** | TypeScript (ES2022) | Krad's preference, same as claude-mem |
| **Runtime** | Bun (primary), Node.js (compatible) | `bun:sqlite` is the killer feature |
| **HTTP Framework** | **Hono** | ~14KB, fastest TS framework, Bun-native, Express-compatible API. Zero heavy deps. |
| **Database** | SQLite via `bun:sqlite` | Native, synchronous, zero-dep, WAL mode |
| **Full-text search** | SQLite FTS5 | Built into SQLite, no external dependency |
| **Vector search** | QMD (Phase 2) | Already available, replaces ChromaDB |
| **Build tool** | esbuild | Fast, zero-config bundling |
| **Test framework** | Bun test runner | Built-in, fast, TypeScript-native |
| **Process manager** | Custom PID-based | ~80 lines, no PM2/systemd dependency |

**Why Hono over Express?**
- Express: 2MB, callback-based, many sub-dependencies
- Hono: 14KB, async-native, Bun-optimized, same route API
- Both support the same middleware pattern
- Hono has built-in SSE support

### Hook Implementation Contracts

```typescript
// src/hooks/types.ts

/** Base input all hooks receive */
interface HookInput {
  session_id: string;       // OpenClaw session identifier
  cwd: string;              // Working directory / project path
  timestamp: number;        // Unix epoch ms
}

/** SessionStart hook input */
interface SessionStartInput extends HookInput {
  source: 'startup' | 'clear' | 'resume';
}

/** SessionStart hook output */
interface SessionStartOutput {
  additionalContext: string;  // Markdown context to inject
  // Or empty string if no context available
}

/** UserPromptSubmit hook input */
interface UserPromptInput extends HookInput {
  prompt: string;           // Raw user prompt text
}

/** UserPromptSubmit hook output */
interface UserPromptOutput {
  sessionDbId: number;      // Database session ID
  promptNumber: number;     // Prompt counter (1, 2, 3...)
  skipped: boolean;         // True if prompt was fully private
}

/** PostToolUse hook input */
interface PostToolUseInput extends HookInput {
  tool_name: string;        // Tool identifier
  tool_input: unknown;      // Tool parameters (JSON)
  tool_result: string;      // Tool output
}

/** PostToolUse hook output */
interface PostToolUseOutput {
  queued: boolean;          // Whether observation was queued
  skipped_reason?: string;  // Why it was skipped (blocklist, private, etc.)
}

/** Stop hook input */
interface StopInput extends HookInput {
  last_user_message?: string;
  last_assistant_message?: string;
  transcript_path?: string;
}

/** Stop hook output */
interface StopOutput {
  summary_queued: boolean;
}

/** SessionEnd hook input */
interface SessionEndInput extends HookInput {
  reason: 'exit' | 'clear' | 'timeout' | 'other';
}

/** SessionEnd hook output */
interface SessionEndOutput {
  completed: boolean;
}

/** Tools to skip (low-value observations) */
const SKIP_TOOLS = new Set([
  'TodoWrite',
  'AskUserQuestion',
  'SlashCommand',
  'ListMcpResourcesTool',
]);

/** Privacy tag patterns */
const PRIVATE_TAG = /<private>[\s\S]*?<\/private>/g;
const CONTEXT_TAG = /<c-mem-context>[\s\S]*?<\/c-mem-context>/g;
```

### Worker HTTP API Spec

```typescript
// Core API Contract

// === Health ===
// GET /health → { status: 'ok', uptime: number, port: number, queue: { pending: number, processing: number } }

// === Context ===
// GET /api/context/inject?project=X&limit=50&sessions=10
// → Markdown-formatted context string (observation index + recent summaries)

// === Sessions ===
// POST /sessions/:id/init
//   Body: { project: string, userPrompt: string, promptNumber: number }
//   → { success: true, session_id: string }
//
// POST /sessions/:id/observations  
//   Body: { tool_name: string, tool_input: unknown, tool_result: string, correlation_id?: string }
//   → { success: true, queued: true, queue_id: number }
//
// POST /sessions/:id/summarize
//   Body: { last_user_message?: string, last_assistant_message?: string }
//   → { success: true, summary_queued: true }
//
// GET /sessions/:id/status
//   → { session_id: string, status: string, observation_count: number, pending_count: number }

// === Search ===
// GET /api/search?query=X&type=Y&project=Z&limit=20&offset=0&dateStart=&dateEnd=
//   → { results: ObservationIndex[], total: number, hasMore: boolean }
//
// GET /api/observations?project=X&limit=20&offset=0
//   → { observations: Observation[], total: number, hasMore: boolean }
//
// GET /api/observation/:id
//   → Observation | { error: string } (404)
//
// POST /api/observations/batch
//   Body: { ids: number[], orderBy?: 'date_asc'|'date_desc', limit?: number }
//   → Observation[]

// === Queue ===
// GET /api/pending-queue
//   → { pending: number, processing: number, failed: number, stuck: number, recent: QueueItem[] }
```

### SDK Compression Prompt Design — Our Own XML Schema

We design our own original XML schema that is **structurally distinct** from claude-mem's while serving the same purpose:

#### Observation Compression Prompt

```xml
<c-mem-compress>
  <instruction>
    Analyze this tool execution and extract a structured memory record.
    Focus on: what changed, why it matters, and what to remember for future sessions.
    Be concise. Title should be a scannable one-liner. Narrative ≤ 3 sentences.
  </instruction>
  
  <tool_execution>
    <tool>{tool_name}</tool>
    <input>{JSON.stringify(tool_input)}</input>
    <output>{truncated tool_result}</output>
  </tool_execution>
  
  <session>
    <project>{project}</project>
    <prompt_number>{n}</prompt_number>
    <user_goal>{first_user_prompt}</user_goal>
  </session>
</c-mem-compress>
```

#### Expected Compression Response

```xml
<memory>
  <kind>bugfix|feature|refactor|discovery|decision|change</kind>
  <title>One-line scannable title</title>
  <narrative>2-3 sentence explanation of what happened and why it matters</narrative>
  <tags>
    <tag>problem-solution</tag>
    <tag>gotcha</tag>
  </tags>
  <files>
    <read>/path/to/file</read>
    <modified>/path/to/file</modified>
  </files>
  <facts>
    <fact>Discrete factual statement</fact>
  </facts>
</memory>
```

#### Session Summary Prompt

```xml
<c-mem-summarize>
  <instruction>
    Generate a structured summary of this coding session.
    Include what was requested, what was done, what was learned, and what's next.
  </instruction>
  
  <observations>
    <!-- Recent compressed observations from this session -->
    <obs id="1" kind="bugfix" title="Fixed auth token validation"/>
    <obs id="2" kind="feature" title="Added rate limiting middleware"/>
  </observations>
  
  <conversation>
    <last_user>{last user message}</last_user>
    <last_assistant>{last assistant message}</last_assistant>
  </conversation>
</c-mem-summarize>
```

#### Expected Summary Response

```xml
<session_summary>
  <request>What the user originally asked for</request>
  <work_done>What was actually accomplished</work_done>
  <discoveries>Key things learned during the session</discoveries>
  <remaining>What still needs to be done</remaining>
  <notes>Any additional context for future sessions</notes>
</session_summary>
```

### How to Wire Into OpenClaw Without Forking

#### Workspace File Injection (Phase 1 — Zero Coupling)

```typescript
// src/hooks/bridge.ts — OpenClaw integration via workspace files

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || '~/.openclaw/workspace-*/';

/**
 * Inject memory context by writing to a workspace file.
 * OpenClaw reads AGENTS.md and other workspace files at session start.
 * We write our context to a dedicated file that AGENTS.md references.
 */
export async function injectContext(project: string): Promise<void> {
  const workerUrl = `http://127.0.0.1:${PORT}/api/context/inject?project=${project}`;
  const response = await fetch(workerUrl);
  const context = await response.text();
  
  const contextFile = join(WORKSPACE, 'MEMORY_CONTEXT.md');
  writeFileSync(contextFile, context, 'utf-8');
}

/**
 * Hook into OpenClaw's session by watching for session events.
 * This can be a simple HTTP callback server that OpenClaw posts to,
 * or a file-watching approach on the session transcript.
 */
export class OpenClawBridge {
  private workerUrl: string;
  
  constructor(port: number = 37888) {
    this.workerUrl = `http://127.0.0.1:${port}`;
  }
  
  async onSessionStart(sessionId: string, project: string): Promise<string> {
    const res = await fetch(`${this.workerUrl}/api/context/inject?project=${project}`);
    return res.text();
  }
  
  async onUserPrompt(sessionId: string, project: string, prompt: string): Promise<void> {
    await fetch(`${this.workerUrl}/sessions/${sessionId}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, userPrompt: prompt, promptNumber: 1 }),
    });
  }
  
  async onToolUse(sessionId: string, toolName: string, input: unknown, result: string): Promise<void> {
    await fetch(`${this.workerUrl}/sessions/${sessionId}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: toolName, tool_input: input, tool_result: result }),
    });
  }
  
  async onStop(sessionId: string, lastUser?: string, lastAssistant?: string): Promise<void> {
    await fetch(`${this.workerUrl}/sessions/${sessionId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_user_message: lastUser, last_assistant_message: lastAssistant }),
    });
  }
  
  async onSessionEnd(sessionId: string, reason: string): Promise<void> {
    await fetch(`${this.workerUrl}/sessions/${sessionId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
  }
}
```

### Test Strategy

#### Unit Tests (each builder owns their domain)

| Domain | Tests | Runner |
|--------|-------|--------|
| **Hooks** | Privacy tag stripping, skip-list filtering, input validation, idempotent session creation | `bun test tests/hooks/` |
| **Worker** | Route handling, request validation, error responses, queue state transitions | `bun test tests/worker/` |
| **Storage** | CRUD operations, FTS5 queries, migration correctness, concurrent writes | `bun test tests/storage/` |
| **SDK** | Prompt XML generation, response XML parsing, malformed response handling | `bun test tests/sdk/` |

#### Integration Tests

| Test | Description |
|------|-------------|
| **Full observation cycle** | Hook → Worker HTTP → Queue → SDK process → Database → Search retrieval |
| **Context injection** | Worker generates context markdown → injected into session |
| **Queue recovery** | Simulate crash → restart → stuck detection → recovery |
| **Privacy** | Private-tagged content never reaches database |

#### Performance Benchmarks

| Metric | Target | Method |
|--------|--------|--------|
| Hook execution time | <50ms | Time from stdin parse to HTTP POST |
| Worker API response | <10ms (non-search) | Benchmark route handlers |
| FTS5 search | <20ms for 10K observations | Benchmark with synthetic data |
| Context injection | <200ms total | Time from request to formatted markdown |

---

## 7. Phase Plan for 3 Parallel Builders

### Interface Contracts Between Builders

All three builders share these interfaces. Define them FIRST before any builder starts:

```typescript
// shared/interfaces.ts — THE CONTRACT FILE
// All builders import from here. No builder may change this file unilaterally.

// === Database Types (Builder C owns implementation) ===
export interface Session {
  id: number;
  session_id: string;           // External session ID (from OpenClaw/Claude)
  project: string;
  status: 'active' | 'completed';
  prompt_counter: number;
  created_at: string;
  created_at_epoch: number;
  completed_at?: string;
}

export interface Observation {
  id: number;
  session_id: string;
  project: string;
  prompt_number: number;
  tool_name: string;
  kind: string;                 // bugfix, feature, etc.
  title: string;
  narrative: string;
  tags: string;                 // JSON array of concept tags
  facts: string;                // JSON array of facts
  files_read: string;           // JSON array
  files_modified: string;       // JSON array
  created_at: string;
  created_at_epoch: number;
}

export interface SessionSummary {
  id: number;
  session_id: string;
  project: string;
  prompt_number: number;
  request: string;
  work_done: string;
  discoveries: string;
  remaining: string;
  notes: string;
  created_at: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

export interface QueueItem {
  id: number;
  session_id: string;
  status: 'pending' | 'processing' | 'processed' | 'failed';
  tool_name: string;
  tool_input: string;           // JSON
  tool_result: string;          // Truncated
  retry_count: number;
  created_at_epoch: number;
  started_at_epoch?: number;
  completed_at_epoch?: number;
}

// === Storage Interface (Builder C implements, Builders A+B consume) ===
export interface ISessionStore {
  createSession(sessionId: string, project: string, firstPrompt: string): number;
  getSession(sessionId: string): Session | null;
  getSessionById(id: number): Session | null;
  updateSessionStatus(sessionId: string, status: string): void;
  incrementPromptCounter(sessionId: string): number;
  
  createObservation(obs: Omit<Observation, 'id'>): number;
  getObservation(id: number): Observation | null;
  getObservations(project?: string, limit?: number, offset?: number): { observations: Observation[]; total: number };
  getObservationsByIds(ids: number[]): Observation[];
  getObservationsBySession(sessionId: string): Observation[];
  
  createSummary(summary: Omit<SessionSummary, 'id'>): number;
  getSummaries(project?: string, limit?: number, offset?: number): { summaries: SessionSummary[]; total: number };
  
  createUserPrompt(prompt: Omit<UserPrompt, 'id'>): number;
  
  // Queue operations
  enqueueObservation(sessionId: string, toolName: string, toolInput: string, toolResult: string): number;
  dequeueNext(): QueueItem | null;
  updateQueueStatus(id: number, status: string): void;
  getQueueStatus(): { pending: number; processing: number; failed: number; stuck: number };
  getStuckItems(thresholdMs: number): QueueItem[];
  resetStuckItems(thresholdMs: number): number;
}

// === Search Interface (Builder C implements, Builder B exposes via HTTP) ===
export interface ISessionSearch {
  searchObservations(query: string, filters?: SearchFilters): SearchResult[];
  searchSummaries(query: string, filters?: SearchFilters): SearchResult[];
  searchPrompts(query: string, filters?: SearchFilters): SearchResult[];
  getRecentContext(project: string, limit: number, sessionCount: number): ContextResult;
  getTimeline(anchorId: number, before: number, after: number, project?: string): Observation[];
}

export interface SearchFilters {
  project?: string;
  kind?: string;
  dateStart?: number;
  dateEnd?: number;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  id: number;
  title: string;
  kind: string;
  project: string;
  created_at_epoch: number;
  rank: number;
  snippet?: string;
}

export interface ContextResult {
  markdown: string;
  observationCount: number;
  summaryCount: number;
  tokenEstimate: number;
}

// === SDK Interface (Builder A implements compression, Builder B triggers it) ===
export interface ICompressionAgent {
  compressObservation(raw: RawObservation): Promise<CompressedObservation>;
  summarizeSession(sessionId: string, observations: Observation[], lastMessages: LastMessages): Promise<SessionSummary>;
}

export interface RawObservation {
  tool_name: string;
  tool_input: unknown;
  tool_result: string;
  project: string;
  prompt_number: number;
  user_goal: string;
}

export interface CompressedObservation {
  kind: string;
  title: string;
  narrative: string;
  tags: string[];
  facts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface LastMessages {
  last_user?: string;
  last_assistant?: string;
}

// === Configuration ===
export interface CMemConfig {
  workerPort: number;           // Default: 37888
  workerHost: string;           // Default: '127.0.0.1'
  dataDir: string;              // Default: ~/.c-mem
  model: string;                // Default: 'sonnet'
  contextObservations: number;  // Default: 50
  contextSessions: number;      // Default: 10
  skipTools: Set<string>;       // Default: SKIP_TOOLS
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  stuckThresholdMs: number;     // Default: 300000 (5 min)
  maxRetries: number;           // Default: 3
}
```

---

### Builder A: Hooks + Session Management + SDK Compression

**Owner**: Builder A  
**Scope**: Everything from event capture to AI processing  
**Files**:
- `src/hooks/*` (all hook implementations)
- `src/sdk/*` (compression prompts, XML parser, agent loop)
- `src/process/*` (PID-based process manager)
- `src/shared/config.ts`, `src/shared/paths.ts`, `src/shared/logger.ts`
- `tests/hooks/*`, `tests/sdk/*`

**Deliverables**:

1. **Hook implementations** — Each hook reads input, calls worker HTTP API (fire-and-forget with 2s timeout), returns immediately
2. **Privacy module** — Strip `<private>` and `<c-mem-context>` tags, detect fully-private prompts
3. **SDK compression agent** — Build XML prompts, call Anthropic API, parse XML responses, handle retries with exponential backoff
4. **Session summary agent** — Same pattern but for session summaries
5. **Process manager** — Start/stop/restart/status for worker service via PID file
6. **OpenClaw bridge** — Event adapter that translates OpenClaw lifecycle to hook calls
7. **Configuration loader** — Read `~/.c-mem/settings.json`, merge with env vars and defaults

**Dependencies on other builders**:
- Uses `ISessionStore` interface (Builder C) — but during development, mock it
- Calls Worker HTTP routes (Builder B) — but during development, mock the HTTP calls

**Tests to write**:
- Privacy tag stripping (10+ cases including nested, empty, multi-line)
- XML prompt generation (verify structure for observation + summary)
- XML response parsing (valid, malformed, empty, partial)
- Skip-list filtering
- Process manager PID lifecycle
- Config loading with defaults, overrides, env vars

---

### Builder B: Worker HTTP + Queue Processing

**Owner**: Builder B  
**Scope**: HTTP server, routing, queue management, observation processing loop  
**Files**:
- `src/worker/server.ts` (Hono HTTP server setup)
- `src/worker/routes/*` (all route handlers)
- `src/worker/queue/*` (queue manager + processor loop)
- `src/worker/sse.ts` (Phase 2)
- `tests/worker/*`

**Deliverables**:

1. **Hono HTTP server** — Create, configure, start server on configurable port
2. **Route handlers** — All 11 MVP endpoints with proper validation and error handling
3. **Queue manager** — State machine for pending→processing→processed/failed transitions
4. **Observation processor** — Background loop that dequeues items, calls `ICompressionAgent`, stores results
5. **Context formatter** — Generate progressive-disclosure markdown index from observations + summaries
6. **Health check** — Uptime, port, queue status
7. **Request validation** — Validate all inputs, return proper error codes

**Dependencies on other builders**:
- Uses `ISessionStore` + `ISessionSearch` (Builder C) — mock during development
- Uses `ICompressionAgent` (Builder A) — mock during development

**Tests to write**:
- Route handler unit tests (valid requests, invalid requests, 404s, etc.)
- Queue state machine transitions (all valid and invalid paths)
- Context formatter output (markdown format, token estimation)
- Concurrent observation handling (multiple POSTs don't race)
- Stuck detection logic (items >5min in processing)

---

### Builder C: Storage + Search

**Owner**: Builder C  
**Scope**: Database schema, CRUD, FTS5 search, migrations  
**Files**:
- `src/storage/db.ts` (SQLite connection, WAL mode, pragmas)
- `src/storage/migrations.ts` (schema creation + migration runner)
- `src/storage/session-store.ts` (implements `ISessionStore`)
- `src/storage/session-search.ts` (implements `ISessionSearch`)
- `src/storage/types.ts` (re-exports from shared/interfaces.ts)
- `tests/storage/*`

**Deliverables**:

1. **Database initialization** — Create DB at `~/.c-mem/c-mem.db`, WAL mode, foreign keys enabled
2. **Schema migrations** — Versioned migration runner with migration table tracking
3. **Core tables**: `sessions`, `observations`, `session_summaries`, `user_prompts`, `observation_queue`
4. **FTS5 virtual tables** — `observations_fts`, `session_summaries_fts`, `user_prompts_fts` with auto-sync triggers
5. **SessionStore** — Full CRUD implementation for all tables + queue operations
6. **SessionSearch** — FTS5 search across all content types with filters
7. **Indexes** — All performance-critical indexes (project, created_at_epoch, session_id, status)
8. **FTS5 query escaping** — Prevent injection attacks

**Dependencies on other builders**: **None** — this is the foundation layer  

**Tests to write**:
- CRUD operations for all entities (create, read, update, list)
- FTS5 search accuracy (exact match, phrase, boolean, ranking)
- FTS5 injection prevention (special characters, SQL keywords, quotes)
- Migration idempotency (run migrations twice = no error)
- Concurrent read/write (WAL mode correctness)
- Queue operations (enqueue, dequeue, status transitions, stuck detection)
- Index performance with 10K+ rows

---

### Builder Integration Timeline

```
Week 1: All builders work independently with mocks
├── Builder C: Database + migrations + CRUD + FTS5 (no dependencies)
├── Builder B: HTTP routes + queue manager (mock storage)
└── Builder A: Hooks + SDK prompts + XML parser (mock HTTP + storage)

Week 2: Integration
├── Day 1-2: Builder C delivers storage, Builders A+B integrate
├── Day 3-4: Builder B delivers HTTP, Builder A integrates hooks
├── Day 5: End-to-end integration testing
└── Day 5: OpenClaw bridge wiring

Week 3: Polish
├── Phase 2 features (SSE, timeline, settings)
├── Performance benchmarks
├── Documentation
└── QMD vector search integration
```

### Integration Test Checklist

When all three builders merge, these end-to-end tests must pass:

- [ ] **Full observation lifecycle**: POST observation → queue → SDK compress → DB store → GET retrieval
- [ ] **Context injection**: Multiple sessions with observations → context/inject returns proper index
- [ ] **Search works**: Insert observations → FTS5 search returns ranked results
- [ ] **Privacy respected**: Private-tagged content never reaches any storage
- [ ] **Queue recovery**: Kill worker mid-processing → restart → stuck items recovered
- [ ] **Idempotent sessions**: Same session_id creates only one DB record
- [ ] **Concurrent hooks**: 10 simultaneous PostToolUse calls don't corrupt data
- [ ] **Graceful degradation**: Worker down → hooks return without error → no data loss

---

## Appendix A: Data Directory Layout

```
~/.c-mem/
├── c-mem.db                    # SQLite database (WAL mode)
├── c-mem.db-wal                # WAL file
├── c-mem.db-shm                # Shared memory file
├── worker.pid                  # Worker process PID
├── settings.json               # User configuration
└── logs/
    └── worker-YYYY-MM-DD.log   # Daily rotating logs
```

## Appendix B: Port Allocation

- **C-Mem Worker**: Port 37888 (default, avoids collision with claude-mem's 37777)
- **Override**: `C_MEM_WORKER_PORT` environment variable
- **Port file**: `~/.c-mem/worker.port` tracks current port

## Appendix C: Key Differences from claude-mem

| Aspect | claude-mem | C-Mem (ours) |
|--------|-----------|--------------|
| **License** | AGPL-3.0 | Original work, our own license |
| **HTTP framework** | Express.js (2MB) | Hono (14KB) |
| **Vector DB** | ChromaDB (Python) | QMD (already available) |
| **Process manager** | Bun ProcessManager | Custom PID-based (portable) |
| **XML schema** | `<compressed_observation>` | `<memory>` (our own schema) |
| **Port** | 37777 | 37888 |
| **Data dir** | `~/.claude-mem/` | `~/.c-mem/` |
| **MCP integration** | 4 MCP tools | HTTP API first, MCP optional Phase 2 |
| **Hook delivery** | Claude Code plugin hooks | OpenClaw session lifecycle events |
| **Viewer** | React SPA | CLI-first, web viewer Phase 3 |

---

*This report is exhaustive and production-ready. It directly drives the implementation work of 3 independent Sonnet builders working in parallel on Builder A (hooks + SDK), Builder B (worker HTTP + queue), and Builder C (storage + search). All interface contracts are defined. All builders can start immediately.*
