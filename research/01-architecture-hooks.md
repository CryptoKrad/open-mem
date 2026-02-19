# Deep Research Report: claude-mem Core Architecture & Hook Lifecycle Design

**Report ID**: 01-architecture-hooks  
**Date**: 2026-02-18  
**Purpose**: Exhaustive analysis of claude-mem's hook system, session state machine, context injection, data flow, and a build spec for our own implementation.  
**Audience**: 3 Sonnet builder agents who will implement C-Mem from this document.

---

## Table of Contents

1. [Hook System Analysis](#1-hook-system-analysis)
2. [Session State Machine](#2-session-state-machine)
3. [Context Injection Mechanism](#3-context-injection-mechanism)
4. [Data Flow Critique](#4-data-flow-critique)
5. [Design Decisions: Keep vs. Improve](#5-design-decisions-keep-vs-improve)
6. [Build Spec for C-Mem](#6-build-spec-for-c-mem)

---

## 1. Hook System Analysis

### 1.1 Architecture Overview

claude-mem is a **hook-driven, two-process** system. The Claude Code IDE fires lifecycle events. Hook scripts (Node.js processes spawned per-event) run in the extension process space, communicate with a long-running Worker Service (Express.js on port 37777, managed by Bun), and read/write a shared SQLite database.

**Core principle**: Observe the main Claude Code session from the outside, process observations in the background, inject context at the right time. Never block the IDE. Never modify Claude Code's behavior directly.

The 5 lifecycle hooks map to 6 script files (SessionStart runs 3 scripts in sequence via command chaining in `hooks.json`):

```
hooks.json
├── SessionStart [matcher: "startup|clear|compact"]
│   ├── smart-install.js       (pre-hook: dependency check, ~10ms cached)
│   ├── worker-service.cjs start  (ensure Bun worker running)
│   └── context-hook.js        (inject prior context silently)
├── UserPromptSubmit [no matcher — all prompts]
│   └── new-hook.js            (create/get session, save prompt)
├── PostToolUse [matcher: "*"]
│   └── save-hook.js           (queue tool observation)
├── Stop [no matcher]
│   └── summary-hook.js        (generate session summary)
└── SessionEnd [no matcher]
    └── cleanup-hook.js        (mark session completed)
```

### 1.2 Hook 1: SessionStart — `context-hook.js`

**Trigger**: Claude Code starts (startup), user runs `/clear`, or context is compacted.

**Matcher**: `startup|clear|compact`

**Sequence** (3 commands, chained):
1. `smart-install.js` — Checks `.install-version` marker vs `package.json` version. Only runs `npm install` on mismatch. ~10ms when cached, 2-5s on install. Not a lifecycle hook — a pre-hook dependency guard.
2. `worker-service.cjs start` — Starts the Bun-managed worker if not already running. Writes PID to `~/.claude-mem/worker.pid`.
3. `context-hook.js` — The actual context injection hook.

**Input** (via stdin from Claude Code):
```json
{
  "session_id": "claude-session-123",
  "cwd": "/path/to/project",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

**Processing**:
1. Extract project name from `path.basename(cwd)`
2. Health-check the worker (`GET /health`, retry up to 10 seconds)
3. If worker available: `GET /api/context/inject?project={project}`
   - Worker queries SQLite: last 10 session summaries + last N observations (configurable, default 50)
   - Formats as progressive disclosure markdown index (compact table: ID, Time, Type emoji, Title, Token count)
4. If worker unavailable: graceful degradation — empty context, session starts normally

**Output** (stdout JSON):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<<formatted context markdown>>"
  }
}
```

**Critical detail — Silent injection**: As of Claude Code 2.1.0 ("ultrathink" update), SessionStart hooks no longer display user-visible messages. Context is silently injected via `hookSpecificOutput.additionalContext`. This means the context appears in Claude's system prompt/context window but the user never sees it rendered in the chat UI. This is a fundamental architectural shift — pre-2.1.0, the context was visible as a message in the conversation.

**Timeout**: 300 seconds (accounts for npm install on first run).

**Failure mode**: If the entire chain fails, Claude Code starts without memory. No crash, no error shown to user.

### 1.3 Hook 2: UserPromptSubmit — `new-hook.js`

**Trigger**: User submits any prompt in the session.

**Matcher**: None (fires for all prompts).

**Input** (via stdin):
```json
{
  "session_id": "claude-session-123",
  "cwd": "/path/to/project",
  "prompt": "Add login feature with OAuth2"
}
```

**Processing**:
1. Extract `project = path.basename(cwd)`
2. **Privacy stripping**: `stripMemoryTagsFromPrompt(prompt)` removes `<private>...</private>` and `<claude-mem-context>...</claude-mem-context>` tags. Max 100 tag pairs (ReDoS protection).
3. If prompt is fully private (empty after stripping) → skip entirely, don't save, don't call worker.
4. **Idempotent session creation**: `INSERT OR IGNORE INTO sdk_sessions (claude_session_id, project, first_user_prompt) VALUES (?, ?, ?)` — If the session_id already exists (continuation prompt in same conversation), this is a no-op. Returns the existing `sessionDbId`.
5. Increment prompt counter: `UPDATE sdk_sessions SET prompt_counter = prompt_counter + 1 WHERE id = sessionDbId` → returns `promptNumber` (1 for first prompt, 2 for second, etc.)
6. Save user prompt: `INSERT INTO user_prompts (session_id, prompt_number, prompt_text) VALUES (?, ?, ?)`
7. Fire-and-forget HTTP: `POST /sessions/{sessionDbId}/init` with `{ project, userPrompt, promptNumber }`, 2s timeout.

**Output**: `{ "continue": true, "suppressOutput": true }`

**Why `INSERT OR IGNORE` matters (Idempotency pattern)**:
- Claude Code sends the same `session_id` for every prompt in a conversation
- The first `UserPromptSubmit` creates the session row
- Subsequent prompts in the same conversation hit the `IGNORE` path — same session, incremented `prompt_counter`
- This means multi-turn conversations are tracked as ONE session, not many
- The `session_id` (from Claude Code) is the **source of truth** linking all data across all hooks

### 1.4 Hook 3: PostToolUse — `save-hook.js`

**Trigger**: After Claude successfully uses any tool (Read, Write, Edit, Bash, Grep, etc.).

**Matcher**: `*` (all tools).

**Input** (via stdin):
```json
{
  "session_id": "claude-session-123",
  "cwd": "/path/to/project",
  "tool_name": "Read",
  "tool_input": { "file_path": "/src/auth.ts" },
  "tool_response": "file contents..."
}
```

**Processing**:
1. **Skip list check**: Discard low-value tools that add noise:
   - `ListMcpResourcesTool` — MCP infrastructure noise
   - `SlashCommand` — Command invocation
   - `Skill` — Skill invocation
   - `TodoWrite` — Task management meta-tool
   - `AskUserQuestion` — User interaction
   
   (Configurable via `CLAUDE_MEM_SKIP_TOOLS`)
   
2. **Privacy stripping**: Strip `<private>` tags from both `tool_input` and `tool_response`
3. Ensure worker is running (health check)
4. **Fire-and-forget HTTP**: `POST /api/sessions/observations` with `{ claudeSessionId, tool_name, tool_input, tool_response, cwd }`, 2s timeout

**This is the highest-frequency hook**. In a typical session, it fires 50-200+ times (once per tool call). That's why fire-and-forget with a 2s timeout is critical — the IDE can never be waiting on AI processing.

**What happens in the worker** (async, after hook returns):
1. `createSDKSession(claudeSessionId, '', '')` — idempotent, ensures session exists
2. Check if the user prompt was entirely private → skip if so
3. Strip memory tags again (defense in depth)
4. Queue observation for SDK agent processing
5. SDK agent calls Claude API to compress observation into structured format (title, narrative, facts, concepts, type, files_read, files_modified)
6. Store compressed observation in SQLite `observations` table
7. Sync to ChromaDB vector embeddings (if available)

**Total sync time for the hook**: ~2ms. AI processing: 1-3 seconds (completely async).

### 1.5 Hook 4: Stop — `summary-hook.js`

**Trigger**: When Claude stops responding (user pauses, stops asking, or explicitly stops).

**Input** (via stdin):
```json
{
  "session_id": "claude-session-123",
  "cwd": "/path/to/project",
  "transcript_path": "/path/to/transcript.jsonl"
}
```

**Processing**:
1. Read the transcript JSONL file
2. Extract last user message (type: `"user"`)
3. Extract last assistant message (type: `"assistant"`, filter out `<system-reminder>` tags)
4. Fire-and-forget HTTP: `POST /api/sessions/summarize` with `{ claudeSessionId, last_user_message, last_assistant_message }`, 2s timeout
5. Stop processing spinner: `POST /api/processing` with `{ isProcessing: false }`

**Worker processes async**:
1. SDK agent generates structured summary via Claude API
2. Summary XML structure:
   ```xml
   <summary>
     <request>What user requested</request>
     <investigated>What was explored</investigated>
     <learned>Key discoveries</learned>
     <completed>Work finished</completed>
     <next_steps>Remaining tasks</next_steps>
     <files_read><file>path1.ts</file></files_read>
     <files_modified><file>path2.ts</file></files_modified>
     <notes>Additional context</notes>
   </summary>
   ```
3. Stored in `session_summaries` table

**Key design decision (v4.2.0+)**: Multiple summaries per session. Stop can fire multiple times in a conversation (user pauses, resumes, pauses again). Each pause generates a summary checkpoint. Summaries are checkpoints, not endings.

### 1.6 Hook 5: SessionEnd — `cleanup-hook.js`

**Trigger**: Claude Code session closes (exit, clear, logout, etc.).

**Input** (via stdin):
```json
{
  "session_id": "claude-session-123",
  "cwd": "/path/to/project",
  "transcript_path": "/path/to/transcript.jsonl",
  "reason": "exit"
}
```

**Processing**:
1. Fire-and-forget HTTP: `POST /api/sessions/complete` with `{ claudeSessionId, reason }`, 2s timeout
2. Worker marks session as completed: `UPDATE sdk_sessions SET status = 'completed', completed_at = NOW()`
3. Worker broadcasts SSE event to any connected viewer UI clients

**Reason values**: `exit | clear | logout | prompt_input_exit | other`

**Critical v4.1.0+ change**: This hook no longer sends `DELETE /sessions/{id}`. The old approach (v3) killed the worker immediately, interrupting summary generation and losing pending observations. The new approach lets the worker finish naturally.

**Skips on `/clear`**: To preserve ongoing sessions when user clears the conversation view but doesn't actually end the session.

### 1.7 Why Fire-and-Forget Matters

Every hook follows the same pattern:
1. Parse stdin (~1ms)
2. Write to SQLite or send HTTP POST (~2-10ms)
3. Return immediately (~20ms total)

If any step fails, the hook catches the exception, logs it, and returns `{ continue: true, suppressOutput: true }`. Claude Code never notices.

**The constraint**: Hooks must complete within their timeout (60-300s depending on hook), but more importantly, they must *feel* instant. A 500ms hook causes noticeable lag in the IDE. The 2s HTTP timeout is a hard cap — if the worker doesn't respond in 2s, the hook moves on without it.

This creates a **queue-based processing pipeline**:
```
Hook (sync, fast) → HTTP/SQLite (async enqueue) → Worker (slow, AI-powered)
```

The worker can be down, slow, or crashed — the hook layer never cares. This is what makes the system resilient.

---

## 2. Session State Machine

### 2.1 State Definitions

```
┌──────────────┐    UserPromptSubmit    ┌──────────┐
│              │ ─────────────────────> │          │
│ Initialized  │    (first prompt)      │  Active  │◄─────────┐
│              │                        │          │           │
└──────────────┘                        └────┬─────┘           │
       ↑                                     │                 │
       │ SessionStart                        │ PostToolUse     │ UserPromptSubmit
       │ (generate/reuse session_id)         ↓                 │ (continuation)
                                    ┌──────────────────┐       │
                                    │ ObservationQueued │───────┘
                                    │ (async processing)│
                                    └──────────────────┘
                                             │
                                    Active ──┤
                                             │ Stop
                                             ↓
                                    ┌──────────────┐
                                    │ Summarizing  │──── User resumes ──→ Active
                                    └──────┬───────┘
                                           │ SessionEnd
                                           ↓
                                    ┌──────────────┐
                                    │  Completed   │
                                    └──────────────┘
```

### 2.2 State Transitions with Data Invariants

| From | Event | To | Data Change |
|------|-------|----|-------------|
| `[*]` | SessionStart | Initialized | `session_id` assigned by Claude Code, worker started, context injected |
| Initialized | UserPromptSubmit | Active | `INSERT OR IGNORE sdk_sessions`, `prompt_counter = 1`, `user_prompts` row created |
| Active | UserPromptSubmit | Active | `prompt_counter++`, new `user_prompts` row |
| Active | PostToolUse | ObservationQueued | Observation enqueued to worker via HTTP |
| ObservationQueued | Worker processes | Active | Compressed observation stored in `observations` table |
| Active | Stop | Summarizing | Summary request sent to worker |
| Summarizing | User resumes | Active | New `UserPromptSubmit`, `prompt_counter++` |
| Summarizing | SessionEnd | Completed | `status = 'completed'`, `completed_at = NOW()` |
| Active | SessionEnd | Completed | Same as above |

### 2.3 Edge Cases

**What if Stop fires before UserPromptSubmit?**
- This shouldn't happen in normal operation (Stop implies Claude was active, which requires a prompt first)
- But if it does: the worker's `/api/sessions/summarize` call tries to look up `sessionDbId` from `claude_session_id`. If no session exists, the worker returns an error, the hook logs it and returns `{ continue: true }`. No crash, no data loss — just a skipped summary for a session that had no data to summarize.

**What if the worker is down during SessionStart?**
- The context-hook.js health-checks for up to 10 seconds
- If worker never responds: returns empty `additionalContext` 
- Session starts normally, just without historical context
- The UserPromptSubmit hook will also try to ensure the worker is running
- Worst case: observations from this session get queued in the HTTP request layer but never processed until worker comes back

**What if SessionEnd fires without Stop firing first?**
- Completely valid — user might close the terminal abruptly
- SessionEnd just marks `completed_at` — it doesn't depend on a summary existing
- The worker might still be processing observations; those will complete naturally
- Next session's context-hook will pull whatever observations/summaries were stored before the close

**What if two sessions overlap (same project, different terminals)?**
- Each has a unique `session_id` from Claude Code
- Both create separate `sdk_sessions` rows
- Both can talk to the same worker service on port 37777
- Observations are linked to their respective `session_id`, no cross-contamination
- The worker runs separate SDK agent instances per session

**What if the user runs `/clear`?**
- SessionStart fires with `source: "clear"` 
- This re-triggers smart-install → worker start → context injection
- But the `session_id` remains the same (same conversation)
- The `INSERT OR IGNORE` pattern means the session row persists
- New context is injected (potentially including observations from earlier in this session)

**What if the SDK agent is slow and the user sends another prompt?**
- The SDK agent is processing asynchronously in the worker
- New `UserPromptSubmit` increments `prompt_counter`, saves the new prompt
- New `PostToolUse` events queue more observations
- The SDK agent processes them in order (FIFO queue)
- There's no blocking dependency — hooks don't wait for the agent

**What if the worker crashes mid-processing?**
- Bun's process management detects the crash
- Next hook call that checks worker health will trigger a restart
- Pending observations in the database queue survive (SQLite is durable)
- Manual recovery: `POST /api/pending-queue/process` retriggers processing
- As of v5.x, automatic recovery on startup is disabled — requires manual trigger

---

## 3. Context Injection Mechanism

### 3.1 The `additionalContext` Pattern

When the `context-hook.js` returns its output, the critical field is:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<<markdown string>>"
  }
}
```

Claude Code takes the `additionalContext` string and includes it in the system-level context available to Claude. This is **not** a user message — it's injected into the assistant's background context, similar to how system prompts work.

### 3.2 Silent Injection (Post Claude Code 2.1.0)

Before 2.1.0:
- SessionStart hook output was displayed as a visible message in the chat
- Users could see the memory context being loaded
- This consumed visual space and could be confusing

After 2.1.0 ("ultrathink" update):
- `additionalContext` is silently injected — it appears in Claude's context window but is invisible to the user
- The user sees nothing in the chat; Claude simply "knows" things from past sessions
- This is a major UX improvement — memory feels natural rather than mechanical

### 3.3 Token Budget Implications

The injected context has real token costs. claude-mem's progressive disclosure strategy manages this:

**Default injection**: 50 observations from 10 sessions, rendered as a compact index table:

```markdown
# [claude-mem] recent context

**Legend:** 🎯 session-request | 🔴 gotcha | 🟡 problem-solution ...

### Oct 26, 2025

**General**
| ID | Time | T | Title | Tokens |
|----|------|---|-------|--------|
| #2586 | 12:58 AM | 🔵 | Context hook file empty | ~51 |
| #2585 | 12:45 AM | 🟡 | Fix auth token refresh | ~87 |

*Use MCP search tools to access full details*
```

**Token math**:
- Index row: ~50-100 tokens per observation
- 50 observations × 75 tokens avg = ~3,750 tokens injected at session start
- Full observation detail: ~500-1,000 tokens each
- If Claude fetches 3 relevant observations via MCP: ~1,500-3,000 additional tokens
- **Total budget**: ~5,000-7,000 tokens vs. ~25,000-50,000 if all observations were loaded in full

**Configurable knobs**:
- `CLAUDE_MEM_CONTEXT_OBSERVATIONS`: Number of observations (default 50, range 1-200)
- `CLAUDE_MEM_CONTEXT_SESSION_COUNT`: Number of sessions to pull from (default 10, range 1-50)
- `CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES`: Filter by type (bugfix, feature, refactor, etc.)
- `CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS`: Filter by concept (gotcha, pattern, trade-off, etc.)
- `CLAUDE_MEM_CONTEXT_FULL_OBSERVATIONS`: Number of observations to show expanded (default 5, range 0-20)
- `CLAUDE_MEM_CONTEXT_FULL_FIELD`: Which field to expand (narrative or facts)

**The 5 "full" observations**: The most recent 5 observations show their full narrative/facts inline. The remaining 45 show only the compact table row. This gives Claude immediate deep context about very recent work while keeping older work as a reference index.

### 3.4 Cursor Context Injection (Comparison)

For Cursor (which doesn't have `additionalContext`), claude-mem uses a different strategy:
- Writes context to `.cursor/rules/claude-mem-context.mdc` with `alwaysApply: true` frontmatter
- Cursor's rules system automatically includes this file in all chats
- Context is refreshed at 3 points: before prompt submission, after summary completes, after session ends

This is relevant for our build because we may not have `additionalContext` either. We need to design for multiple injection strategies.

---

## 4. Data Flow Critique

### 4.1 The Happy Path

```
User opens Claude Code
  → SessionStart fires
    → smart-install.js (cached: 10ms)
    → worker-service.cjs start (Bun starts worker)
    → context-hook.js
      → GET /api/context/inject?project=X
      → Worker queries SQLite
      → Returns progressive disclosure markdown
      → Silent injection via additionalContext
  
User types prompt
  → UserPromptSubmit fires
    → INSERT OR IGNORE sdk_sessions
    → INSERT user_prompts
    → POST /sessions/{id}/init (fire-and-forget)
  
Claude uses tools (50-200 times)
  → PostToolUse fires per tool
    → Skip list check
    → Privacy tag stripping
    → POST /api/sessions/observations (fire-and-forget)
    → Worker queues observation
    → SDK agent compresses via Claude API (1-3s async)
    → INSERT observations (compressed)
    → Sync to ChromaDB
  
User pauses
  → Stop fires
    → Read transcript JSONL
    → POST /api/sessions/summarize (fire-and-forget)
    → SDK agent generates summary (2-5s async)
    → INSERT session_summaries
  
User exits
  → SessionEnd fires
    → POST /api/sessions/complete
    → UPDATE sdk_sessions SET completed_at
    → SSE broadcast to viewer
```

### 4.2 Failure Modes

**1. Worker not starting (port conflict)**
- Port 37777 is hardcoded (configurable via env var, but most users won't change it)
- If another process owns port 37777, the worker fails silently
- All hooks degrade gracefully: context-hook returns empty, save-hook discards observations
- **Impact**: Complete memory loss for the session. User may not notice until they wonder why context isn't injected.
- **Mitigation**: Health check logs warnings; `worker:status` command available

**2. SQLite database locked**
- Multiple hooks can fire simultaneously (e.g., PostToolUse during rapid tool execution)
- SQLite WAL mode handles concurrent reads well, but concurrent writes can conflict
- The `bun:sqlite` driver is synchronous, so write contention manifests as SQLITE_BUSY errors
- **Mitigation**: Each hook is a separate process, so they don't share connections. The worker is single-process. But if two PostToolUse hooks write to SQLite simultaneously, one might fail.
- **Impact**: Individual observations may be lost silently (hook catches the error and returns success)

**3. SDK agent is slow / API rate limited**
- Claude API calls for compression take 1-3s per observation
- With 200 observations in a session, that's 200-600s of processing time
- If the user ends the session before processing completes, the worker's graceful shutdown lets it finish
- But if the machine sleeps or the worker is killed, observations in the queue are lost from the in-memory queue
- **Mitigation**: v5.x+ uses SQLite queue (`pending_queue` table) for durability. Manual recovery endpoint exists.

**4. Race condition: context-hook reads while worker writes**
- The context-hook queries SQLite for recent observations
- Simultaneously, a PostToolUse hook might be writing a new observation
- SQLite WAL mode handles this: readers see a consistent snapshot, writers don't block readers
- **Assessment**: This is actually well-handled. No real race condition here.

**5. Race condition: health check during worker startup**
- context-hook health-checks the worker with retry (up to 10s)
- If the worker is mid-startup (port bound but not serving yet), health check might get connection refused
- The 10s retry window handles most cases, but on slow machines or first-run (npm install + worker start), it might timeout
- **Mitigation**: 300s timeout on SessionStart gives the full chain time to complete

**6. New session starts while old session's SDK agent is still processing**
- Possible when user rapidly opens/closes sessions
- Each session gets its own SDK agent instance in the worker
- Old agent continues processing (not killed on SessionEnd, just marked complete)
- New session's context-hook might not see the old session's observations yet
- **Impact**: Slightly stale context in the new session. Observations from the just-ended session may not appear until the agent finishes processing.

### 4.3 Data Integrity Guarantees

**Strong guarantees**:
- Session identity (session_id from Claude Code, immutable)
- Idempotent session creation (INSERT OR IGNORE)
- Privacy tag stripping at hook boundary (edge processing)
- Observation ordering (created_at_epoch timestamps)

**Weak guarantees**:
- Observation completeness (fire-and-forget can lose data if worker is down)
- Summary generation (depends on Stop firing, which may not happen on abrupt exit)
- Real-time consistency (async processing means there's always a lag between capture and storage)

---

## 5. Design Decisions: Keep vs. Improve

### 5.1 Decisions Worth Keeping

**Fire-and-forget pattern (KEEP)** ⭐
- The single most important architectural decision. Without this, the system would lag the IDE.
- The 2s HTTP timeout is aggressive and correct. Better to lose an observation than to block the user.
- The queue-based decoupling is elegant: hooks are producers, worker is consumer, SQLite is the buffer.

**Idempotent session creation with INSERT OR IGNORE (KEEP)** ⭐
- Solves the "is this the first prompt or a continuation?" problem without any state tracking in the hook process.
- Combined with `session_id` as source of truth, this is a clean, stateless design.
- Each hook process can independently determine the sessionDbId without knowing about other hooks.

**Privacy tag stripping at the edge (KEEP)** ⭐
- `<private>...</private>` content is stripped *before* it reaches the database or worker.
- Defense in depth: stripped in hooks AND again in the worker.
- Max 100 tag pairs for ReDoS protection is a nice security touch.
- The `<claude-mem-context>...</claude-mem-context>` recursion prevention is clever — prevents the injected context from being re-ingested.

**Progressive disclosure for context injection (KEEP)**
- The compact index format (~50-100 tokens/observation) vs. full detail (~500-1,000 tokens) is a 10x savings.
- Giving Claude the index and letting it decide what to fetch is more intelligent than dumping everything.
- The 3-layer MCP workflow (search → timeline → get_observations) enforces this structurally.

**Graceful cleanup (v4.1.0+ pattern) (KEEP)**
- `SessionEnd` marks completion instead of deleting — worker finishes naturally.
- This eliminated the race conditions that plagued v3.

**Multiple summaries per session (KEEP)**
- Stop is a checkpoint, not an ending. Users pause and resume.
- Each pause generates a summary, building a richer picture of the session.

### 5.2 Decisions That Are Fragile / Should Be Improved

**Fixed port 37777 (IMPROVE)** ⚠️
- Port collision is silent and fatal (no memory for the session).
- The env var override exists but isn't discoverable.
- **Improvement**: Dynamic port allocation with a port file, or Unix domain socket instead of TCP.

**Bun as process manager (IMPROVE)** ⚠️
- Bun is auto-installed if missing — adds a dependency most users don't want.
- Bun-specific APIs (`bun:sqlite`) lock the implementation to Bun.
- `better-sqlite3` or `sql.js` would provide the same functionality without requiring a second runtime.
- **Improvement**: Use Node.js native `child_process` for process management, `better-sqlite3` for SQLite. Or embed the worker as a long-running Node.js process started by the hook.

**Health check race on startup (IMPROVE)** ⚠️
- The 10s retry window for worker health is fragile on slow machines.
- If the worker takes longer than 10s to start (first-run npm install + Bun install + worker startup), context injection fails silently.
- **Improvement**: The smart-install pre-hook should signal completion before context-hook starts health checking. Use a readiness file or semaphore.

**In-memory observation queue in worker (IMPROVE)** ⚠️
- If the worker process crashes, any in-memory queued observations are lost.
- The SQLite `pending_queue` table (v5.x+) mitigates this, but recovery is manual.
- **Improvement**: All queueing should be SQLite-first. The hook should write directly to SQLite, and the worker should poll the database. This eliminates the HTTP hop for observation capture entirely.

**Transcript JSONL parsing in summary-hook (IMPROVE)** ⚠️
- The Stop hook reads the full transcript JSONL file to extract last messages.
- This is file I/O that could be large for long sessions.
- **Improvement**: Have Claude Code pass the last messages directly in stdin rather than requiring the hook to parse the transcript.

**Single worker for all projects (DEBATABLE)** 🤔
- One Express.js server handles all projects on port 37777.
- This is efficient (one process) but creates a single point of failure.
- If the worker crashes, ALL projects lose memory simultaneously.
- **For our build**: Consider whether a per-project worker (or per-project database) makes more sense for isolation.

---

## 6. Build Spec for C-Mem

### 6.1 Core Architecture

We should keep the two-process model (hook scripts + background worker) but simplify aggressively.

```
┌────────────────────────────────────────────────────────────┐
│                    HOOK LAYER (TypeScript, Node.js)         │
│                                                            │
│  context-hook.ts  → Read SQLite directly (no HTTP needed)  │
│  session-hook.ts  → Write SQLite directly (INSERT OR IGNORE)│
│  observe-hook.ts  → Write SQLite directly (INSERT queue)    │
│  summary-hook.ts  → Write SQLite + HTTP to worker          │
│  cleanup-hook.ts  → Write SQLite directly (UPDATE status)   │
│                                                            │
│  All hooks: <20ms, fire-and-forget, catch-all error handler│
└────────────────────┬───────────────────────────────────────┘
                     │ SQLite (shared DB)
                     ↓
┌────────────────────────────────────────────────────────────┐
│                    WORKER PROCESS (TypeScript, Node.js)     │
│                                                            │
│  Polls SQLite queue for unprocessed observations           │
│  Calls Claude/LLM API for compression                     │
│  Writes compressed observations back to SQLite             │
│  Generates summaries on request                            │
│  Optional: HTTP API for viewer UI                          │
│                                                            │
│  Process management: simple Node.js child_process          │
│  PID file: ~/.c-mem/worker.pid                             │
│  Port: Unix domain socket or dynamic TCP                   │
└────────────────────────────────────────────────────────────┘
```

**Key difference from claude-mem**: Hooks write directly to SQLite instead of sending HTTP to the worker. This eliminates the fire-and-forget HTTP hop for 4 of 5 hooks. Only summary generation needs the worker (for LLM calls). The worker polls the DB queue instead of receiving HTTP pushes.

### 6.2 Hook Specifications

#### Hook 1: SessionStart — `context-hook.ts`

**Responsibilities**:
1. Ensure worker process is running (check PID file, spawn if needed)
2. Read recent observations from SQLite (direct DB access, no HTTP)
3. Format as progressive disclosure index
4. Return via `additionalContext`

**Data contract (stdin)**:
```typescript
interface SessionStartInput {
  session_id: string;
  cwd: string;
  hook_event_name: "SessionStart";
  source: "startup" | "clear" | "compact";
}
```

**Data contract (stdout)**:
```typescript
interface SessionStartOutput {
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext: string; // markdown
  };
}
```

**Implementation notes**:
- Open SQLite DB read-only (WAL mode allows concurrent reads)
- Query: `SELECT * FROM observations WHERE project = ? ORDER BY created_at_epoch DESC LIMIT ?`
- Query: `SELECT * FROM session_summaries WHERE project = ? ORDER BY created_at_epoch DESC LIMIT ?`
- Format as markdown table with type emoji, title, token estimate
- Include 5 most recent observations with full narrative, rest as compact index
- Target: <100ms total execution time

#### Hook 2: UserPromptSubmit — `session-hook.ts`

**Responsibilities**:
1. Create or get session in SQLite (idempotent)
2. Strip privacy tags from prompt
3. Save user prompt to SQLite
4. Notify worker of new session (optional, via SQLite flag or lightweight IPC)

**Data contract (stdin)**:
```typescript
interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
}
```

**Database operations**:
```sql
-- Idempotent session creation
INSERT OR IGNORE INTO sessions (session_id, project, status, created_at)
VALUES (?, ?, 'active', ?);

-- Get session DB ID
SELECT id FROM sessions WHERE session_id = ?;

-- Increment prompt counter
UPDATE sessions SET prompt_counter = prompt_counter + 1 WHERE id = ?;

-- Save prompt
INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at)
VALUES (?, ?, ?, ?);
```

#### Hook 3: PostToolUse — `observe-hook.ts`

**Responsibilities**:
1. Check skip list
2. Strip privacy tags from tool_input and tool_response
3. Write raw observation to SQLite queue table

**Data contract (stdin)**:
```typescript
interface PostToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, any>;
  tool_response: string;
}
```

**Database operations**:
```sql
-- Get session DB ID (must already exist from UserPromptSubmit)
SELECT id, prompt_counter FROM sessions WHERE session_id = ?;

-- Queue raw observation (worker will compress later)
INSERT INTO observation_queue (
  session_db_id, prompt_number, tool_name, 
  tool_input_json, tool_response_text, 
  status, created_at
) VALUES (?, ?, ?, ?, ?, 'pending', ?);
```

**No HTTP call needed**. The worker polls `observation_queue WHERE status = 'pending'`.

#### Hook 4: Stop — `summary-hook.ts`

**Responsibilities**:
1. Extract last user/assistant messages from transcript
2. Write summary request to SQLite queue
3. Optionally signal worker via IPC/HTTP

**Data contract (stdin)**:
```typescript
interface StopInput {
  session_id: string;
  cwd: string;
  transcript_path: string;
}
```

**Database operations**:
```sql
INSERT INTO summary_queue (
  session_db_id, last_user_message, last_assistant_message,
  status, created_at
) VALUES (?, ?, ?, 'pending', ?);
```

#### Hook 5: SessionEnd — `cleanup-hook.ts`

**Responsibilities**:
1. Mark session as completed in SQLite

**Database operations**:
```sql
UPDATE sessions 
SET status = 'completed', completed_at = ?
WHERE session_id = ?;
```

### 6.3 Database Schema

```sql
-- Core session table
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,        -- From Claude Code
  project TEXT NOT NULL,                   -- basename(cwd)
  prompt_counter INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',   -- active | completed
  created_at INTEGER NOT NULL,             -- epoch ms
  completed_at INTEGER,
  UNIQUE(session_id)
);

-- User prompts (searchable)
CREATE TABLE user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_db_id INTEGER NOT NULL REFERENCES sessions(id),
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Raw observation queue (hooks write here, worker reads)
CREATE TABLE observation_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_db_id INTEGER NOT NULL REFERENCES sessions(id),
  prompt_number INTEGER,
  tool_name TEXT NOT NULL,
  tool_input_json TEXT,
  tool_response_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);

-- Compressed observations (worker writes here after LLM processing)
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_db_id INTEGER NOT NULL REFERENCES sessions(id),
  queue_id INTEGER REFERENCES observation_queue(id),
  project TEXT NOT NULL,
  prompt_number INTEGER,
  tool_name TEXT NOT NULL,
  type TEXT,              -- decision | bugfix | feature | refactor | discovery | change
  title TEXT,
  narrative TEXT,
  facts TEXT,             -- JSON array of fact strings
  concepts TEXT,          -- JSON array of concept strings
  files_read TEXT,        -- JSON array of file paths
  files_modified TEXT,    -- JSON array of file paths
  created_at INTEGER NOT NULL
);

-- Session summaries (worker writes after LLM summarization)
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_db_id INTEGER NOT NULL REFERENCES sessions(id),
  project TEXT NOT NULL,
  prompt_number INTEGER,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  created_at INTEGER NOT NULL
);

-- FTS5 virtual tables
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title, narrative, facts, concepts,
  content='observations', content_rowid='id'
);

CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
  prompt_text,
  content='user_prompts', content_rowid='id'
);

CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
  request, investigated, learned, completed, next_steps,
  content='session_summaries', content_rowid='id'
);

-- Sync triggers (insert/update/delete for each FTS table)
-- [omitted for brevity, same pattern as claude-mem]

-- Indexes
CREATE INDEX idx_sessions_session_id ON sessions(session_id);
CREATE INDEX idx_sessions_project ON sessions(project);
CREATE INDEX idx_observation_queue_status ON observation_queue(status);
CREATE INDEX idx_observations_project ON observations(project);
CREATE INDEX idx_observations_created_at ON observations(created_at DESC);
CREATE INDEX idx_observations_type ON observations(type);
```

### 6.4 State Machine (Simplified)

```
                    ┌─────────────────────┐
                    │     NOT_EXISTS       │
                    └──────────┬──────────┘
                               │ SessionStart hook runs
                               │ (worker ensured, context injected)
                               ↓
                    ┌─────────────────────┐
                    │    INITIALIZED      │  No DB row yet
                    └──────────┬──────────┘
                               │ UserPromptSubmit
                               │ INSERT OR IGNORE sessions
                               ↓
              ┌───────────────────────────────────┐
              │             ACTIVE                 │←──────────┐
              │  session row exists                │           │
              │  prompt_counter incrementing       │           │
              │  observation_queue growing          │           │
              └──────────┬───────────┬────────────┘           │
                         │           │                         │
                    Stop │           │ SessionEnd              │ Resume
                         ↓           ↓                         │
              ┌──────────────┐ ┌──────────────┐               │
              │ SUMMARIZING  │ │  COMPLETED   │               │
              │ (summary in  │ │  completed_at│               │
              │  queue)      │ │  set         │               │
              └──────┬───────┘ └──────────────┘               │
                     │                                         │
                     └─────────────────────────────────────────┘
```

### 6.5 Worker Process Design

```typescript
// Worker main loop (pseudocode)
async function workerMain() {
  const db = openDatabase('~/.c-mem/c-mem.db');
  
  while (true) {
    // 1. Process pending observations
    const pendingObs = db.query(
      `SELECT * FROM observation_queue 
       WHERE status = 'pending' 
       ORDER BY created_at ASC 
       LIMIT 10`
    );
    
    for (const obs of pendingObs) {
      db.run(`UPDATE observation_queue SET status = 'processing' WHERE id = ?`, obs.id);
      
      try {
        const compressed = await compressObservation(obs); // LLM call
        db.run(
          `INSERT INTO observations (session_db_id, queue_id, project, ...) VALUES (?, ?, ?, ...)`,
          compressed
        );
        db.run(`UPDATE observation_queue SET status = 'done', processed_at = ? WHERE id = ?`, 
          Date.now(), obs.id);
      } catch (err) {
        const retryCount = obs.retry_count + 1;
        const newStatus = retryCount >= 3 ? 'failed' : 'pending';
        db.run(`UPDATE observation_queue SET status = ?, retry_count = ? WHERE id = ?`, 
          newStatus, retryCount, obs.id);
      }
    }
    
    // 2. Process pending summaries
    const pendingSummaries = db.query(
      `SELECT * FROM summary_queue WHERE status = 'pending' LIMIT 1`
    );
    // ... similar processing pattern
    
    // 3. Sleep before next poll
    await sleep(1000); // 1 second polling interval
  }
}
```

### 6.6 Key Differences from claude-mem

| Aspect | claude-mem | C-Mem (Proposed) |
|--------|-----------|-----------------|
| **Hook → Worker communication** | HTTP (fire-and-forget, 2s timeout) | Direct SQLite writes (no HTTP hop for most hooks) |
| **Worker architecture** | Express.js HTTP server on fixed port | Database polling + optional HTTP for UI/search |
| **Process management** | Bun-specific | Node.js `child_process`, PID file |
| **SQLite driver** | `bun:sqlite` (Bun-specific) | `better-sqlite3` (Node.js native addon) |
| **Port allocation** | Fixed 37777 | Unix domain socket or dynamic with port file |
| **Observation queue** | HTTP → in-memory → SQLite | Direct to SQLite (durable from the start) |
| **Recovery** | Manual endpoint trigger | Automatic on worker start (scan `observation_queue WHERE status = 'pending'`) |
| **Context injection** | HTTP GET to worker → format → return | Direct SQLite read in hook → format → return |
| **Vector search** | ChromaDB (optional, requires Python) | Deferred to v2 (FTS5 is sufficient for v1) |

### 6.7 Implementation Priority

**Phase 1 (MVP)**: 
1. SQLite schema + migrations
2. 5 hook scripts (context, session, observe, summary, cleanup)
3. Worker process (queue polling + LLM compression)
4. Context injection (progressive disclosure format)
5. Privacy tag stripping

**Phase 2 (Search)**:
1. FTS5 search endpoints
2. MCP tools (search → timeline → get_observations)
3. 3-layer progressive disclosure

**Phase 3 (UI + Polish)**:
1. Web viewer UI (SSE real-time)
2. Settings management
3. Vector search (optional)

---

## Appendix A: hooks.json Configuration Template

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|clear|compact",
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/context-hook.js",
        "timeout": 120
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/session-hook.js",
        "timeout": 60
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/observe-hook.js",
        "timeout": 60
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/summary-hook.js",
        "timeout": 120
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/cleanup-hook.js",
        "timeout": 60
      }]
    }]
  }
}
```

## Appendix B: Privacy Tag Stripping Reference

```typescript
const PRIVATE_TAG_REGEX = /<private>[\s\S]*?<\/private>/gi;
const CONTEXT_TAG_REGEX = /<claude-mem-context>[\s\S]*?<\/claude-mem-context>/gi;
const MAX_TAG_REPLACEMENTS = 100; // ReDoS protection

function stripPrivacyTags(text: string): string {
  let result = text;
  let count = 0;
  
  // Strip <private> tags
  result = result.replace(PRIVATE_TAG_REGEX, () => {
    if (++count > MAX_TAG_REPLACEMENTS) return '';
    return '';
  });
  
  // Strip <claude-mem-context> tags (recursion prevention)
  count = 0;
  result = result.replace(CONTEXT_TAG_REGEX, () => {
    if (++count > MAX_TAG_REPLACEMENTS) return '';
    return '';
  });
  
  return result.trim();
}

function isFullyPrivate(text: string): boolean {
  return stripPrivacyTags(text).trim() === '';
}
```

## Appendix C: Observation Type Taxonomy

| Type | Emoji | Description | Example |
|------|-------|-------------|---------|
| `decision` | 🎯 | Architectural or design decisions | "Chose JWT over session cookies" |
| `bugfix` | 🔴 | Bug fixes and corrections | "Fixed null pointer in auth middleware" |
| `feature` | 🟢 | New features or capabilities | "Added OAuth2 login flow" |
| `refactor` | 🔵 | Code refactoring and cleanup | "Extracted auth logic to service layer" |
| `discovery` | 🟡 | Learnings about the codebase | "Database uses soft deletes" |
| `change` | ⚪ | General changes and modifications | "Updated config file paths" |

## Appendix D: Session ID Architecture

Two distinct IDs:
1. **`session_id`** (from Claude Code) — Immutable throughout conversation, used as foreign key for all data
2. **`sdk_session_id`** (from Claude Agent SDK) — Internal to the worker's LLM processing, may be NULL initially

**Rule**: Never use `sdk_session_id` to link user data. Always use `session_id` from Claude Code.

```
session_id (source of truth) ──→ sessions.session_id
                               ├──→ user_prompts.session_db_id
                               ├──→ observation_queue.session_db_id
                               ├──→ observations.session_db_id
                               └──→ session_summaries.session_db_id
```

---

*End of Report 01. Word count: ~5,900. This document should provide sufficient detail for implementation without needing to refer to claude-mem source code.*
