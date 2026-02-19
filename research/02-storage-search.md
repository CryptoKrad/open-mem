# C-Mem Research Report 02: Storage Layer + Search Architecture + Competitive Analysis

> **Date**: 2026-02-18  
> **Scope**: claude-mem SQLite schema, ChromaDB integration, 3-layer progressive search, QMD/probe comparison, gap analysis, and our build spec  
> **Sources**: claude-mem docs (docs.claude-mem.ai), source code (SessionStore.ts, SessionSearch.ts, ChromaSync.ts, SearchManager.ts, TimelineService.ts, worker-service.ts), QMD SKILL.md, probe CLI

---

## 1. SQLite Schema Deep Dive

### 1.1 The 4-Table Design

claude-mem uses SQLite 3 via `bun:sqlite` (synchronous native module, WAL mode) stored at `~/.claude-mem/claude-mem.db`. The schema has evolved through 14+ migrations. The current production tables:

#### sdk_sessions
```sql
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT UNIQUE NOT NULL,  -- Claude's session ID
  memory_session_id TEXT UNIQUE,            -- c-mem's own ID (set async by worker)
  project TEXT NOT NULL,
  user_prompt TEXT,
  prompt_counter INTEGER DEFAULT 0,
  status TEXT CHECK(status IN ('active','completed','failed')) NOT NULL DEFAULT 'active',
  worker_port INTEGER,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  last_activity_at TEXT,
  last_activity_epoch INTEGER,
  failed_at_epoch INTEGER
);
```
**Indexes**: content_session_id, memory_session_id, project, status, started_at_epoch DESC

**Design Notes**: Dual session IDs (content vs memory) is a key architectural decision—Claude's session ID arrives immediately during hook interception, but c-mem's internal ID is assigned asynchronously by the worker service. This means `user_prompts` FK references `content_session_id` while `observations` references `memory_session_id`, creating two join paths.

#### observations
```sql
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  text TEXT,                    -- legacy, nullable since migration 9
  type TEXT NOT NULL,           -- decision|bugfix|feature|refactor|discovery|change
  title TEXT,
  subtitle TEXT,
  facts TEXT,                   -- JSON array
  narrative TEXT,
  concepts TEXT,                -- JSON array
  files_read TEXT,              -- JSON array
  files_modified TEXT,          -- JSON array
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,  -- ROI tracking
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
);
```
**Indexes**: memory_session_id, project, type, created_at_epoch DESC

**Design Notes**: The hierarchical fields (title, subtitle, narrative, facts, concepts, files_*) were added in migration 8, replacing the monolithic `text` field. This is a good evolution—each field serves a different search and display purpose. However, storing JSON arrays as TEXT columns means no native indexing on individual file paths or concepts. The `json_each()` queries used for file/concept lookup are O(n) scans per row.

#### session_summaries
```sql
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,  -- originally UNIQUE, constraint removed in migration 7
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  files_read TEXT,        -- JSON array
  files_edited TEXT,      -- JSON array
  notes TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
);
```
**Design Notes**: Multiple summaries per session (UNIQUE constraint removed in migration 7) allows progressive summarization as sessions evolve. The structured fields (request/investigated/learned/completed/next_steps) map cleanly to an AI's workflow. This is one of c-mem's best design decisions.

#### user_prompts
```sql
CREATE TABLE user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,  -- FK to sdk_sessions.content_session_id
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
);
```
**Indexes**: content_session_id, created_at_epoch DESC, prompt_number, (content_session_id + prompt_number) composite

**Design Notes**: Added in migration 10 (v4.2.0). Uses `content_session_id` instead of `memory_session_id` because prompts are captured synchronously before the worker assigns a memory_session_id. This creates a FK mismatch—you need to join through `sdk_sessions` to correlate prompts with observations.

### 1.2 Context Injection Query Pattern

The last-50-observations context injection query pattern follows this structure:

```sql
SELECT o.*, o.discovery_tokens
FROM observations o
WHERE o.project = ?
ORDER BY o.created_at_epoch DESC
LIMIT 50
```

For cross-entity context (observations + summaries + prompts), c-mem runs separate queries and merges in application code. The `SearchManager.search()` method runs up to 3 independent queries, then combines and sorts results by epoch.

**N+1 Risk Analysis**:
- **Moderate risk on file/concept filters**: `findByFile()` uses `json_each()` subqueries which scan JSON arrays per row. For a dataset with 1000 observations, each with 5 files, you're doing 5000 `json_each` evaluations. Not a true N+1 (it's a single SQL query with expensive predicates), but performance degrades similarly.
- **Hydration pattern in ChromaDB path**: ChromaDB returns IDs → `getObservationsByIds(ids)` does a second round-trip to SQLite. This is intentional (Chroma stores embeddings, not full data) but adds latency.
- **No N+1 on the core path**: Session → observations is a single indexed query. Good.

### 1.3 FTS5 Tokenization for Code Content

FTS5 uses the default `unicode61` tokenizer unless otherwise specified. claude-mem's FTS5 tables do **not** specify a custom tokenizer:

```sql
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title, subtitle, narrative, text, facts, concepts,
  content='observations', content_rowid='id'
);
```

**Implications for code content**:
- `unicode61` tokenizes on Unicode word boundaries—underscores, dots, slashes split tokens
- `camelCase` is NOT split (treated as one token)
- File paths like `src/services/sqlite/SessionStore.ts` become tokens: `src`, `services`, `sqlite`, `SessionStore`, `ts`
- Function names like `getObservationsByIds` are a single token (FTS5 won't find `observations` within it)
- Bracket/paren-heavy code gets stripped of operators

**Critical finding**: c-mem's SessionSearch.ts has a telling comment: *"FTS5 tables are maintained for backward compatibility but not used for search. Vector search (Chroma) is now the primary search mechanism."* FTS5 is essentially deprecated in the codebase as of the current version. The `searchObservations()` method returns empty array if a query string is provided, logging: `"Text search not supported - use ChromaDB for vector search"`. FTS5 infrastructure is kept only for the filter-only code paths and backward compatibility.

**Implication for our design**: FTS5 is still valuable for exact keyword matching, but c-mem's experience shows that for natural-language queries against semi-structured observation data, vector search provides better recall. We should implement FTS5 but not depend on it as the primary search mechanism.

---

## 2. ChromaDB Integration

### 2.1 Architecture

ChromaDB is integrated via `ChromaMcpManager` → `chroma-mcp` server (Python, run via `uv`/`uvx`). The communication path is:

```
Worker Service (Bun/TS) → MCP Client (stdio) → chroma-mcp Server (Python) → ChromaDB (Python)
```

This is a **cross-language subprocess architecture**: TypeScript calls Python via the MCP protocol over stdio. The `chroma-mcp` server handles its own embedding generation and persistent vector storage.

### 2.2 Embedding Model

The `chroma-mcp` server uses ChromaDB's default embedding function. From the ChromaDB documentation, this is **all-MiniLM-L6-v2** (384-dimensional sentence-transformers model) unless configured otherwise. The embedding happens inside the Python process—no external API calls needed.

### 2.3 Vector Sync Mechanism

From `ChromaSync.ts`:

1. **Real-time sync**: When an observation/summary/prompt is created, `syncObservation()` / `syncSummary()` / `syncUserPrompt()` is called, which formats the data into ChromaDB documents and sends via MCP.

2. **Granular document strategy**: Each semantic field becomes a **separate vector document**:
   - An observation with a narrative + 3 facts = 4 ChromaDB documents (`obs_123_narrative`, `obs_123_fact_0`, `obs_123_fact_1`, `obs_123_fact_2`)
   - A summary with 5 populated fields = 5 ChromaDB documents
   - This is smart—it means each fact gets its own embedding, improving recall for specific factual queries

3. **Backfill mechanism**: On worker startup, `ChromaSync.backfillAllProjects()` does a smart diff:
   - Fetches all existing document IDs from ChromaDB (metadata-only, in batches of 1000)
   - Queries SQLite for documents NOT IN the existing set
   - Syncs only the missing documents in batches of 100

4. **Collection naming**: `cm__<project_name>` (sanitized to `[a-zA-Z0-9._-]`)

### 2.4 Latency/Reliability Tradeoffs

**Latency**: 
- MCP stdio communication adds ~10-50ms per call (process spawn, JSON serialization)
- Python ChromaDB query with embedding generation: ~50-200ms per query
- Total per-search: ~100-300ms (vs ~1-5ms for pure SQLite FTS5)
- Batch operations (backfill) are I/O bound on the MCP protocol overhead

**Reliability**:
- **Failure mode if ChromaDB is down**: The `SearchManager.search()` catches Chroma failures and sets `chromaFailed = true`, returning an error message to the user suggesting they install `uv`. There is **no FTS5 fallback**—if ChromaDB is unavailable and a query string is provided, the search returns zero results with an error message.
- This is a deliberate design choice documented as "fail-fast with no fallbacks"
- The filter-only path (no query text) still works via direct SQLite queries

**Cold start**: First search after worker restart requires:
1. ChromaMcpManager lazy initialization
2. chroma-mcp server startup (Python process)
3. Model loading (sentence-transformers)
4. Estimated: 5-15 seconds cold start

### 2.5 Recency Filtering

A notable design decision: `SearchManager.search()` applies a **90-day recency window** to ChromaDB results:

```typescript
const ninetyDaysAgo = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
const recentMetadata = chromaResults.metadatas.filter(
  meta => meta.created_at_epoch > ninetyDaysAgo
);
```

This happens *after* the vector search, meaning ChromaDB fetches up to 100 results but only recent ones survive. This biases heavily toward recent context, which may miss relevant historical decisions.

---

## 3. 3-Layer Progressive Disclosure Search

### 3.1 Why This Is Better Than Naive Full-Text Search

The traditional RAG approach fetches N documents and dumps them into context:
- 20 observations × ~500-1000 tokens each = **10,000-20,000 tokens**
- Relevance rate: ~10% (only 2 are actually useful)
- Waste: ~18,000 tokens of irrelevant context

The 3-layer pattern:

| Layer | Tool | What Returns | Token Cost | Purpose |
|-------|------|-------------|-----------|---------|
| 1 - Index | `search` | IDs, titles, dates, types | ~50-100 tokens/result | Survey what exists |
| 2 - Context | `timeline` | Chronological view around anchor | Variable (depth × ~100 tokens) | Understand narrative arc |
| 3 - Details | `get_observations` | Full observation data | ~500-1000 tokens/obs | Deep dive on filtered set |

**Typical flow**: 
```
search(20 results) → ~1,000-2,000 tokens
Human reviews, picks 3 relevant → 0 tokens (Claude's reasoning)
get_observations(3 IDs) → ~1,500-3,000 tokens
Total: 2,500-5,000 tokens (50-75% savings)
```

### 3.2 The `__IMPORTANT` Tool Trick

The 4th MCP tool `__IMPORTANT` is brilliant: it's a tool that does nothing except display workflow instructions to Claude. It ensures Claude sees the 3-layer pattern instructions every time it considers using memory search. This is **context engineering via tool design**—the tool's existence IS its function.

### 3.3 Timeline Retrieval

`TimelineService` builds a chronological view centered on an anchor point:

1. `getTimelineAroundObservation(anchorId, anchorEpoch, depth_before, depth_after, project)` queries SQLite for observations within the depth window
2. Results include observations, summaries, and user prompts merged chronologically
3. Grouped by date, rendered as markdown tables with type icons (🔴 bugfix, 🟣 feature, etc.)
4. The anchor point is marked with `← **ANCHOR**` for orientation

The timeline serves as a "what happened around this event" view—critical for understanding causality (what bug led to what fix, what decision preceded what change).

### 3.4 Token Savings Quantified

For a typical memory database with 500 observations:
- **Naive RAG**: Fetch top-20 by similarity → 10,000-20,000 tokens, ~10% relevance
- **3-Layer**: Search index → ~2,000 tokens, timeline → ~1,000 tokens, 3 details → ~3,000 tokens = **~6,000 tokens, ~100% relevance**
- **Savings**: ~10,000-14,000 tokens per search interaction

Over a session with 5 memory lookups: **~50,000-70,000 tokens saved** per session.

---

## 4. QMD vs C-Mem Search: Compete or Complement?

### 4.1 System Profiles

| Dimension | QMD | claude-mem |
|-----------|-----|-----------|
| **Data source** | Markdown files on disk (notes, docs, references) | AI session observations (tool calls, decisions, discoveries) |
| **Data type** | Static documents, human-authored | Dynamic records, AI-extracted from tool interactions |
| **Index scope** | 38 collections, ~1890 files, 102MB | Per-project, grows with usage |
| **Storage** | SQLite FTS5 + sqlite-vec + GGUF models | SQLite + ChromaDB (Python subprocess) |
| **Search modes** | BM25 (`search`), Vector (`vsearch`), Hybrid (`query`) with LLM reranking | ChromaDB vector (primary), SQLite filter-only (secondary) |
| **Embedding** | embeddinggemma-300M (local GGUF) | all-MiniLM-L6-v2 (ChromaDB default) |
| **Reranking** | qwen3-reranker-0.6b (local GGUF) | None |
| **Query expansion** | qmd-query-expansion-1.7B (fine-tuned, local) | None |
| **Cold start** | ~1 min (loads Qwen3-1.7B for expansion) | ~5-15s (Python subprocess + model load) |
| **Chunking** | ~800-token chunks, 15% overlap | Granular: each fact/narrative = separate doc |

### 4.2 Semantic Territory

**QMD answers**: "What's in my notes/docs about X?" → Project knowledge base, architecture decisions (documented), reference material, meeting notes, personal notes.

**C-Mem answers**: "What did we do in past sessions about X?" → Tool execution history, bugfix narratives, what files were changed, what the AI learned, session summaries.

### 4.3 Overlap Analysis

**Overlap exists** in:
- Architecture decisions: QMD may have an architecture doc; C-Mem may have a "decision" observation recording when that decision was made
- File knowledge: QMD indexes the file content; C-Mem records which files were read/modified
- Project context: Both can answer "what is this project about?"

**But the overlap is complementary**, not competitive:
- QMD has the *document content* → what the code/docs say
- C-Mem has the *interaction history* → what Claude did with those documents
- Example: QMD can find the auth module docs; C-Mem can tell you "3 sessions ago we refactored the auth module, here's what changed and why"

### 4.4 Unification Potential

**Partial unification is possible and desirable**:
1. Use QMD's existing vector store (sqlite-vec with embeddinggemma-300M) instead of spinning up ChromaDB
2. Add a `c-mem` collection to QMD that indexes observation narratives/facts as markdown documents
3. Unified search: `qmd query "auth bug"` would return both docs AND past session context
4. Keep the session-specific structured data (session_summaries, SDK tracking) in a separate SQLite db

**Why not full unification**: QMD's document model (files with paths) doesn't naturally represent sessions/observations with hierarchical metadata. The structured queries (by type, by file_modified, by concept, timeline around anchor) need the relational schema.

---

## 5. probe vs C-Mem: Where Each Wins

### 5.1 Query Type Mapping

| Query Type | probe | C-Mem | Winner |
|-----------|-------|-------|--------|
| "Find the auth middleware implementation" | ✅ AST-aware code search | ❌ Doesn't index code | probe |
| "What did we change in auth last session?" | ❌ No session context | ✅ Session observations | C-Mem |
| "Show me error handling patterns" | ✅ Structural code matching | ⚠️ Only if observed in past sessions | probe |
| "Why did we switch from JWT to sessions?" | ❌ Code doesn't capture "why" | ✅ Decision observations | C-Mem |
| "What functions call the database layer?" | ✅ Code graph analysis | ❌ Not code-aware | probe |
| "What bugs did we fix this week?" | ❌ No temporal context | ✅ Type=bugfix + date filter | C-Mem |
| "What files were modified together?" | ⚠️ Partial (git-aware) | ✅ files_modified per observation | C-Mem |

### 5.2 Summary

- **probe** = "What does the code look like right now?" (spatial/structural)
- **C-Mem** = "What happened to the code over time?" (temporal/narrative)
- They are **fully complementary** with zero functional overlap

---

## 6. Gap Analysis

### 6.1 What C-Mem Provides That QMD/probe Cannot

1. **Session continuity**: "Resume from where we left off" — session summaries with next_steps
2. **Decision provenance**: Why was X done? Captured as type=decision observations
3. **Temporal narrative**: Timeline of what happened, in what order, during a session
4. **Cross-session patterns**: "Every time we touch auth, we break the tests" — searchable bugfix history
5. **File modification tracking**: Not just what a file contains (probe), but what was done to it (C-Mem)
6. **User prompt history**: What the human asked across sessions — recoverable context
7. **Token-efficient retrieval**: 3-layer progressive disclosure is unique to this domain

### 6.2 What C-Mem Misses vs QMD

1. **No static knowledge indexing**: Can't search project docs, READMEs, architecture docs
2. **No LLM reranking**: QMD's query expansion + reranking pipeline produces higher-precision results
3. **No multi-collection management**: QMD's collection system allows scoped search; C-Mem only scopes by project
4. **No document retrieval**: Can't `qmd get` a full file—only observation snippets
5. **Weaker embedding model**: all-MiniLM-L6-v2 (384-dim, 22M params) vs embeddinggemma-300M (gemma-derived, 300M params)
6. **No chunking strategy**: C-Mem's granular docs (per-fact, per-narrative) may produce too-short embeddings for some use cases

### 6.3 Unique Gaps Our System Must Fill

1. **No OpenClaw-native integration**: C-Mem was built for Claude Code hooks; we need MCP tool or direct API integration
2. **No cross-agent memory**: Multiple agents (main, subagents, workers) should share observations
3. **No memory relevance scoring**: No ROI tracking on which memories were actually useful when retrieved
4. **No memory decay/pruning**: Observations grow unbounded; no mechanism to age out irrelevant data

---

## 7. Build Spec for Our Storage Layer

### 7.1 Design Philosophy

Our system serves OpenClaw agents (analyst, worker, phantom, etc.) rather than Claude Code's hook-based architecture. Key differences:
- **Multi-agent**: Observations come from multiple agents, not a single Claude session
- **Always-on daemon**: OpenClaw Gateway is persistent; no cold-start concern
- **QMD already exists**: We should integrate with it rather than duplicate vector infrastructure
- **Bun runtime**: Already available in the OpenClaw ecosystem

### 7.2 SQLite Schema

```sql
-- Database: ~/.openclaw/c-mem/c-mem.db
-- Mode: WAL, synchronous=NORMAL, foreign_keys=ON

-------------------------------------------------------------------
-- SESSIONS: Who did what, when
-------------------------------------------------------------------
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,           -- OpenClaw session key
  agent_id TEXT NOT NULL,                    -- 'analyst', 'worker', 'phantom', etc.
  channel TEXT,                              -- 'telegram', 'discord', 'direct', etc.
  requester TEXT,                            -- user/requester identity
  project TEXT,                              -- project context if any
  label TEXT,                                -- session label/task description
  status TEXT CHECK(status IN ('active','completed','failed','abandoned')) 
    NOT NULL DEFAULT 'active',
  prompt_counter INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,              -- epoch ms (INTEGER, not TEXT)
  completed_at INTEGER,
  last_activity_at INTEGER,
  
  -- Summary fields (populated on session end or periodically)
  goal TEXT,                                 -- what was the user trying to do
  outcome TEXT,                              -- what was accomplished
  next_steps TEXT                            -- what should happen next
);

CREATE INDEX idx_sessions_agent ON sessions(agent_id);
CREATE INDEX idx_sessions_project ON sessions(project);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_sessions_requester ON sessions(requester);

-------------------------------------------------------------------
-- OBSERVATIONS: What happened during sessions
-------------------------------------------------------------------
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project TEXT,
  prompt_number INTEGER,
  
  -- Structured content
  type TEXT NOT NULL CHECK(type IN (
    'decision','bugfix','feature','refactor','discovery',
    'change','error','insight','question'
  )),
  title TEXT NOT NULL,
  subtitle TEXT,
  narrative TEXT,                            -- detailed description
  facts TEXT,                                -- JSON array of discrete facts
  concepts TEXT,                             -- JSON array of concept tags
  files_read TEXT,                           -- JSON array of file paths
  files_modified TEXT,                       -- JSON array of file paths
  tools_used TEXT,                           -- JSON array of tool names used
  
  -- Metrics
  confidence REAL DEFAULT 1.0,              -- 0.0-1.0, how confident in this observation
  retrieval_count INTEGER DEFAULT 0,        -- how often this was retrieved (ROI)
  last_retrieved_at INTEGER,                -- epoch ms
  
  created_at INTEGER NOT NULL,              -- epoch ms
  
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX idx_obs_session ON observations(session_id);
CREATE INDEX idx_obs_agent ON observations(agent_id);
CREATE INDEX idx_obs_project ON observations(project);
CREATE INDEX idx_obs_type ON observations(type);
CREATE INDEX idx_obs_created ON observations(created_at DESC);
-- Composite for common query pattern: recent observations for a project
CREATE INDEX idx_obs_project_created ON observations(project, created_at DESC);

-------------------------------------------------------------------
-- USER_PROMPTS: What the user asked
-------------------------------------------------------------------
CREATE TABLE user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  channel TEXT,
  created_at INTEGER NOT NULL,
  
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX idx_prompts_session ON user_prompts(session_id);
CREATE INDEX idx_prompts_created ON user_prompts(created_at DESC);
CREATE UNIQUE INDEX idx_prompts_lookup ON user_prompts(session_id, prompt_number);

-------------------------------------------------------------------
-- FTS5 VIRTUAL TABLES
-------------------------------------------------------------------

-- Observations FTS: Index title, narrative, and facts for keyword search
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title,
  narrative,
  facts,
  concepts,
  content='observations',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- Triggers to sync FTS5
CREATE TRIGGER obs_fts_insert AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, narrative, facts, concepts)
  VALUES (new.id, new.title, new.narrative, new.facts, new.concepts);
END;

CREATE TRIGGER obs_fts_delete AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts)
  VALUES('delete', old.id, old.title, old.narrative, old.facts, old.concepts);
END;

CREATE TRIGGER obs_fts_update AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts)
  VALUES('delete', old.id, old.title, old.narrative, old.facts, old.concepts);
  INSERT INTO observations_fts(rowid, title, narrative, facts, concepts)
  VALUES (new.id, new.title, new.narrative, new.facts, new.concepts);
END;

-- Sessions FTS: Index goal, outcome, next_steps
CREATE VIRTUAL TABLE sessions_fts USING fts5(
  goal,
  outcome,
  next_steps,
  label,
  content='sessions',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- (analogous triggers for sessions_fts omitted for brevity)

-- User prompts FTS
CREATE VIRTUAL TABLE prompts_fts USING fts5(
  prompt_text,
  content='user_prompts',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- (analogous triggers for prompts_fts omitted for brevity)

-------------------------------------------------------------------
-- LINKS: Cross-references between observations
-------------------------------------------------------------------
CREATE TABLE observation_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  link_type TEXT NOT NULL CHECK(link_type IN (
    'caused_by','led_to','related','supersedes','reverts'
  )),
  created_at INTEGER NOT NULL,
  
  FOREIGN KEY(source_id) REFERENCES observations(id) ON DELETE CASCADE,
  FOREIGN KEY(target_id) REFERENCES observations(id) ON DELETE CASCADE
);

CREATE INDEX idx_links_source ON observation_links(source_id);
CREATE INDEX idx_links_target ON observation_links(target_id);
```

### 7.3 Vector Search Strategy: Integrate with QMD

**Recommendation: Do NOT use ChromaDB.** Instead, integrate with QMD's existing vector store.

**Rationale**:
1. QMD already has sqlite-vec with embeddinggemma-300M — a stronger embedding model than ChromaDB's default
2. QMD is already installed, configured, and has 9,938 vectors across 38 collections
3. Adding a `c-mem` collection to QMD gives us unified search across docs AND observations
4. No Python subprocess overhead (QMD is Bun-native)
5. QMD's LLM reranking (qwen3-reranker) would improve observation retrieval quality

**Integration approach**:
1. Create a QMD collection: `qmd collection add ~/.openclaw/c-mem/export/ --name c-mem --mask "**/*.md"`
2. On observation creation, write a markdown file to the export directory:
   ```
   ~/.openclaw/c-mem/export/<project>/<session_id>/<obs_id>.md
   ```
3. File format:
   ```markdown
   ---
   type: bugfix
   project: my-project
   session: abc123
   agent: analyst
   date: 2026-02-18
   concepts: [auth, jwt, token-expiry]
   files: [src/auth.ts, src/middleware.ts]
   ---
   # Fixed auth token expiry bug
   
   ## Narrative
   Discovered that JWT tokens were not being refreshed...
   
   ## Facts
   - Token refresh interval was set to 24h instead of 1h
   - The middleware was caching expired tokens
   ```
4. QMD auto-indexes on next search (or trigger `qmd embed` for immediate vector indexing)
5. Search: `qmd query "auth token bug" -c c-mem` searches only observations; without `-c`, searches everything

**Fallback for pure-SQLite environments**: FTS5 provides keyword search without any external dependencies. The schema above includes FTS5 for this purpose.

### 7.4 Search API Design

```typescript
// --- Core Search Interface ---

interface SearchRequest {
  // Layer 1: Index search
  query?: string;              // free-text query (FTS5 or QMD)
  
  // Structured filters (work without query)
  project?: string;
  agent_id?: string;
  type?: ObservationType | ObservationType[];
  concepts?: string[];
  files?: string[];
  date_start?: number;         // epoch ms
  date_end?: number;           // epoch ms
  
  // Pagination
  limit?: number;              // default 20
  offset?: number;
  order_by?: 'relevance' | 'date_desc' | 'date_asc';
}

interface SearchResult {
  // Compact index format (~50-100 tokens/result)
  id: number;
  type: string;
  title: string;
  date: string;                // ISO string
  agent_id: string;
  project?: string;
  relevance_score?: number;    // 0.0-1.0 if vector search
  token_estimate: number;      // estimated tokens for full details
}

// --- Layer 2: Timeline ---

interface TimelineRequest {
  anchor: number;              // observation ID
  depth_before?: number;       // default 5
  depth_after?: number;        // default 5
  project?: string;
  include_prompts?: boolean;   // default true
}

interface TimelineItem {
  type: 'observation' | 'session' | 'prompt';
  id: number;
  title: string;
  date: string;
  is_anchor: boolean;
  type_icon: string;
  token_estimate: number;
}

// --- Layer 3: Full Details ---

interface GetObservationsRequest {
  ids: number[];
  include_linked?: boolean;    // follow observation_links
}

// Returns full Observation objects with all fields

// --- API Functions ---

class MemorySearch {
  // Layer 1: Search index
  async search(req: SearchRequest): Promise<SearchResult[]>;
  
  // Layer 2: Timeline context  
  async timeline(req: TimelineRequest): Promise<TimelineItem[]>;
  
  // Layer 3: Full details
  async getObservations(req: GetObservationsRequest): Promise<Observation[]>;
  
  // Write path
  async saveObservation(obs: NewObservation): Promise<number>;
  async saveSession(session: NewSession): Promise<string>;
  async updateSession(id: string, update: Partial<Session>): Promise<void>;
  
  // Utilities
  async getRecentContext(project: string, limit?: number): Promise<SearchResult[]>;
  async getSessionHistory(session_id: string): Promise<Observation[]>;
}
```

### 7.5 Search Flow

```
User query arrives
       │
       ▼
┌─────────────────┐
│ Has query text?  │
└────┬────────┬───┘
     │ Yes    │ No
     ▼        ▼
┌─────────┐ ┌──────────┐
│ QMD     │ │ SQLite   │
│ search  │ │ filter   │
│ -c c-mem│ │ (indexed)│
└────┬────┘ └────┬─────┘
     │           │
     ▼           ▼
┌─────────────────────┐
│ Merge & rank results│
│ Return compact index│
│ (~50-100 tok/result)│
└──────────┬──────────┘
           │
     Claude decides
     which to explore
           │
     ┌─────┴─────┐
     ▼           ▼
┌─────────┐ ┌──────────┐
│timeline │ │get_obs   │
│(context)│ │(details) │
└─────────┘ └──────────┘
```

### 7.6 Key Differences from claude-mem's Design

| Aspect | claude-mem | Our Design |
|--------|-----------|------------|
| Vector store | ChromaDB (Python subprocess) | QMD integration (Bun-native) |
| Embedding model | all-MiniLM-L6-v2 (384d) | embeddinggemma-300M (QMD's) |
| Reranking | None | qwen3-reranker via QMD |
| Session tracking | Dual IDs (content + memory) | Single session_id (OpenClaw key) |
| Agent support | Single (Claude) | Multi-agent (agent_id field) |
| Observation links | None | observation_links table |
| Retrieval ROI | discovery_tokens (write-only) | retrieval_count + last_retrieved_at (tracked) |
| Epochs | Mixed TEXT + INTEGER | INTEGER only (epoch ms) |
| FTS5 role | Deprecated, kept for compat | Active for keyword fallback |
| Data format | DB-only | DB + markdown export (QMD-indexable) |

### 7.7 Migration Path

1. **Phase 1**: SQLite schema + FTS5 (no external deps, immediate keyword search)
2. **Phase 2**: Markdown export + QMD collection (vector search via existing infra)
3. **Phase 3**: MCP tool integration (search/timeline/get_observations)
4. **Phase 4**: Cross-agent memory sharing, observation links, retrieval ROI tracking

---

## Summary & Recommendations

1. **claude-mem's 3-layer progressive disclosure is the right pattern** — adopt it directly. The `__IMPORTANT` tool trick is elegant and should be replicated.

2. **Skip ChromaDB entirely** — QMD's existing infrastructure (sqlite-vec + embeddinggemma-300M + LLM reranking) is strictly superior and already deployed. Export observations as markdown files into a QMD collection.

3. **Keep FTS5 as keyword fallback** — c-mem's experience (deprecating FTS5 in favor of ChromaDB) reflects ChromaDB's weaknesses more than FTS5's. With QMD as the vector backend, FTS5 serves as a fast, dependency-free fallback.

4. **Fix the dual-ID antipattern** — Use a single `session_id` that maps to OpenClaw's session key. No async ID assignment headaches.

5. **Add observation links** — c-mem lacks cross-observation relationships. Our `observation_links` table enables causal chains (bug → fix → regression → fix), which are valuable for pattern detection.

6. **Track retrieval ROI** — c-mem writes `discovery_tokens` but never reads it. We should actively track which observations get retrieved and use that signal for relevance tuning and memory pruning.

7. **INTEGER epochs everywhere** — c-mem's mixed TEXT/INTEGER date columns are a maintenance burden. Use epoch milliseconds exclusively (render to human-readable in the application layer).

8. **Multi-agent from day one** — Every observation records which agent created it. This enables cross-agent learning ("the worker found a bug that the analyst can learn from").
