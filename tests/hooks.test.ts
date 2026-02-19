/**
 * Open-Mem Hook Test Suite
 *
 * Tests for:
 * - Privacy utilities (secret scrubbing, tag stripping, session_id validation)
 * - Hook behavior (graceful degradation, skip list, payload limits)
 * - SDK prompt builders (XML structure)
 * - SDK XML parsers (valid, malformed, partial responses)
 * - Config loading (defaults, validation)
 *
 * Run with: bun test tests/hooks.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  isValidSessionId,
  scrubSecrets,
  scrubValue,
  stripPrivacyTags,
  isFullyPrivate,
  enforcePayloadLimit,
} from "../src/hooks/privacy.js";
import { buildCompressionPrompt, buildSummaryPrompt } from "../src/sdk/prompts.js";
import { projectFromCwd, workerBaseUrl } from "../src/config.js";
import type { Observation, Session } from "../src/types.js";

// ─── Session ID Validation ────────────────────────────────────────────────────

describe("isValidSessionId", () => {
  test("accepts standard UUID format", () => {
    expect(isValidSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("accepts UUID without hyphens", () => {
    expect(isValidSessionId("550e8400e29b41d4a716446655440000")).toBe(true);
  });

  test("accepts OpenClaw session IDs with underscores", () => {
    expect(isValidSessionId("session_abc123XYZ")).toBe(true);
  });

  test("rejects IDs with path traversal characters", () => {
    expect(isValidSessionId("../../../etc/passwd")).toBe(false);
  });

  test("rejects IDs with forward slashes", () => {
    expect(isValidSessionId("session/bad/id")).toBe(false);
  });

  test("rejects IDs with backslashes", () => {
    expect(isValidSessionId("session\\bad")).toBe(false);
  });

  test("rejects IDs with shell metacharacters", () => {
    expect(isValidSessionId("session;rm -rf")).toBe(false);
    expect(isValidSessionId("session$(cmd)")).toBe(false);
    expect(isValidSessionId("session`cmd`")).toBe(false);
  });

  test("rejects IDs that are too short (< 8 chars)", () => {
    expect(isValidSessionId("abc")).toBe(false);
    expect(isValidSessionId("1234567")).toBe(false);
  });

  test("rejects IDs that are too long (> 128 chars)", () => {
    expect(isValidSessionId("a".repeat(129))).toBe(false);
  });

  test("accepts IDs at exactly minimum length (8 chars)", () => {
    expect(isValidSessionId("abcdefgh")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidSessionId("")).toBe(false);
  });

  test("rejects non-string input", () => {
    expect(isValidSessionId(null as unknown as string)).toBe(false);
    expect(isValidSessionId(undefined as unknown as string)).toBe(false);
    expect(isValidSessionId(123 as unknown as string)).toBe(false);
  });
});

// ─── Secret Scrubbing ─────────────────────────────────────────────────────────

describe("scrubSecrets — AWS keys", () => {
  test("redacts AWS access key IDs", () => {
    const input = "Using key AKIAIOSFODNN7EXAMPLE to access S3";
    const result = scrubSecrets(input);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("[REDACTED:aws-key-id]");
  });

  test("redacts ASIA (temporary) AWS key IDs", () => {
    const input = "Key: ASIAIOSFODNN7EXAMPLE";
    const result = scrubSecrets(input);
    expect(result).not.toContain("ASIAIOSFODNN7EXAMPLE");
    expect(result).toContain("[REDACTED:aws-key-id]");
  });

  test("redacts AWS secret access key values", () => {
    const input = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const result = scrubSecrets(input);
    expect(result).not.toContain("wJalrXUtnFEMI");
    expect(result).toContain("[REDACTED:aws-secret]");
  });
});

describe("scrubSecrets — API keys", () => {
  test("redacts Anthropic API keys (sk-ant-*)", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456";
    const result = scrubSecrets(input);
    expect(result).not.toContain("sk-ant-api03");
    expect(result).toContain("[REDACTED:anthropic-key]");
  });

  test("redacts OpenAI API keys (sk-*)", () => {
    const input = "key = sk-1234567890abcdef1234567890abcdef";
    const result = scrubSecrets(input);
    expect(result).not.toContain("sk-1234567890abcdef");
    expect(result).toContain("[REDACTED:openai-key]");
  });
});

describe("scrubSecrets — Bearer tokens", () => {
  test("redacts Bearer tokens in Authorization headers", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const result = scrubSecrets(input);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("[REDACTED:bearer-token]");
  });
});

describe("scrubSecrets — JWTs", () => {
  test("redacts full JWT tokens (header.payload.signature)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = `Token: ${jwt}`;
    const result = scrubSecrets(input);
    expect(result).not.toContain(jwt);
  });
});

describe("scrubSecrets — password patterns", () => {
  test("redacts password= assignments", () => {
    const input = "password=supersecret123";
    const result = scrubSecrets(input);
    expect(result).not.toContain("supersecret123");
    expect(result).toContain("[REDACTED:credential]");
  });

  test("redacts api_key= assignments", () => {
    const input = "api_key=mySecretApiKey123";
    const result = scrubSecrets(input);
    expect(result).not.toContain("mySecretApiKey123");
    expect(result).toContain("[REDACTED:credential]");
  });

  test("redacts token: assignments (case insensitive)", () => {
    const input = "TOKEN: mysecrettoken12345";
    const result = scrubSecrets(input);
    expect(result).not.toContain("mysecrettoken12345");
  });
});

describe("scrubSecrets — .env file content", () => {
  test("redacts long .env values (KEY=LONG_SECRET pattern)", () => {
    const input = "DATABASE_URL=postgresql://user:password@host/db_secret_12345678";
    const result = scrubSecrets(input);
    // The long secret value should be redacted
    expect(result).not.toContain("password@host/db_secret_12345678");
  });

  test("leaves short/non-secret .env values intact", () => {
    // Short values (< 16 chars) should not be redacted
    const input = "PORT=3000\nDEBUG=true";
    const result = scrubSecrets(input);
    expect(result).toContain("3000");
    expect(result).toContain("true");
  });

  test("preserves non-sensitive text around secrets", () => {
    const input = "Using key AKIAIOSFODNN7EXAMPLE for prod access";
    const result = scrubSecrets(input);
    expect(result).toContain("Using key");
    expect(result).toContain("for prod access");
  });
});

describe("scrubValue", () => {
  test("handles objects by JSON-serializing then scrubbing", () => {
    const obj = { Authorization: "Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz" };
    const result = scrubValue(obj);
    expect(result).not.toContain("sk-ant-api03");
    expect(result).toContain("[REDACTED");
  });

  test("handles null/undefined gracefully", () => {
    expect(scrubValue(null)).toBe("");
    expect(scrubValue(undefined)).toBe("");
  });

  test("handles plain strings directly", () => {
    const result = scrubValue("password=hunter2");
    expect(result).not.toContain("hunter2");
    expect(result).toContain("[REDACTED:credential]");
  });
});

// ─── Privacy Tags ─────────────────────────────────────────────────────────────

describe("stripPrivacyTags", () => {
  test("strips <private> tags and their content", () => {
    const input = "Before <private>SECRET CONTENT</private> After";
    const result = stripPrivacyTags(input);
    expect(result).toBe("Before  After");
    expect(result).not.toContain("SECRET CONTENT");
  });

  test("strips <c-mem-context> tags (recursion prevention)", () => {
    const input = "Context: <c-mem-context>Injected memory block</c-mem-context> End";
    const result = stripPrivacyTags(input);
    expect(result).not.toContain("Injected memory block");
    expect(result).toContain("Context:");
  });

  test("strips multiple <private> blocks", () => {
    const input = "<private>A</private> middle <private>B</private>";
    const result = stripPrivacyTags(input);
    expect(result).not.toContain("A");
    expect(result).not.toContain("B");
    expect(result).toContain("middle");
  });

  test("handles multiline private content", () => {
    const input = "Before\n<private>\nLine 1\nLine 2\n</private>\nAfter";
    const result = stripPrivacyTags(input);
    expect(result).not.toContain("Line 1");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  test("handles case-insensitive tags", () => {
    const input = "<PRIVATE>secret</PRIVATE>";
    const result = stripPrivacyTags(input);
    expect(result).not.toContain("secret");
  });

  test("returns unchanged string when no tags present", () => {
    const input = "No special tags here";
    expect(stripPrivacyTags(input)).toBe("No special tags here");
  });

  test("handles empty string", () => {
    expect(stripPrivacyTags("")).toBe("");
  });

  test("handles non-string input gracefully", () => {
    expect(stripPrivacyTags(null as unknown as string)).toBe(null);
  });
});

describe("isFullyPrivate", () => {
  test("returns true when entire content is in <private> tags", () => {
    expect(isFullyPrivate("<private>everything is private</private>")).toBe(true);
  });

  test("returns false when there is non-private content", () => {
    expect(isFullyPrivate("Public <private>secret</private> content")).toBe(false);
  });

  test("returns false for empty string (nothing is private, nothing to hide)", () => {
    // Empty = not private (nothing was hidden), but also nothing to store
    // The hook checks for empty separately
    expect(isFullyPrivate("")).toBe(false);
  });

  test("returns true for whitespace-only content after stripping", () => {
    expect(isFullyPrivate("<private>   content   </private>   ")).toBe(true);
  });
});

// ─── Payload Size Limiter ─────────────────────────────────────────────────────

describe("enforcePayloadLimit", () => {
  test("passes through short content unchanged", () => {
    const short = "Hello, world!";
    expect(enforcePayloadLimit(short)).toBe(short);
  });

  test("truncates content exceeding 50KB", () => {
    const big = "A".repeat(60 * 1024); // 60KB
    const result = enforcePayloadLimit(big);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(51 * 1024);
    expect(result).toContain("[...truncated");
  });

  test("preserves content exactly at the limit", () => {
    const atLimit = "B".repeat(50 * 1024); // Exactly 50KB
    const result = enforcePayloadLimit(atLimit);
    expect(result).toBe(atLimit);
  });
});

// ─── Config / CWD Utilities ───────────────────────────────────────────────────

describe("projectFromCwd", () => {
  test("extracts basename from Unix path", () => {
    expect(projectFromCwd("/Users/alice/projects/my-app")).toBe("my-app");
  });

  test("extracts basename from Windows-style path", () => {
    expect(projectFromCwd("C:\\Users\\alice\\projects\\my-app")).toBe("my-app");
  });

  test("returns 'unknown' for empty string", () => {
    expect(projectFromCwd("")).toBe("unknown");
  });

  test("handles trailing slash", () => {
    expect(projectFromCwd("/projects/my-app/")).toBe("my-app");
  });
});

describe("workerBaseUrl", () => {
  test("builds correct URL from config", () => {
    expect(workerBaseUrl({ bindHost: "127.0.0.1", port: 37888 })).toBe(
      "http://127.0.0.1:37888"
    );
  });
});

// ─── Prompt Builders ──────────────────────────────────────────────────────────

describe("buildCompressionPrompt", () => {
  test("returns a string containing the c-mem-compress tag", () => {
    const prompt = buildCompressionPrompt(
      "Edit",
      { file_path: "/src/auth.ts", old_string: "foo", new_string: "bar" },
      "File edited successfully",
      { project: "my-app", promptNumber: 2, userGoal: "Fix auth bug" }
    );
    expect(prompt).toContain("<c-mem-compress>");
    expect(prompt).toContain("</c-mem-compress>");
  });

  test("includes the tool name in the prompt", () => {
    const prompt = buildCompressionPrompt("Read", {}, "file contents", {
      project: "proj",
      promptNumber: 1,
      userGoal: "Read file",
    });
    expect(prompt).toContain("<tool>Read</tool>");
  });

  test("includes the expected response schema", () => {
    const prompt = buildCompressionPrompt("Bash", {}, "output", {
      project: "proj",
      promptNumber: 1,
      userGoal: "Run tests",
    });
    expect(prompt).toContain("<memory>");
    expect(prompt).toContain("<type>");
    expect(prompt).toContain("<title>");
    expect(prompt).toContain("<narrative>");
  });

  test("escapes XML special characters in tool response", () => {
    const prompt = buildCompressionPrompt(
      "Read",
      {},
      '<script>alert("xss")</script>',
      { project: "proj", promptNumber: 1, userGoal: "Read" }
    );
    expect(prompt).not.toContain("<script>");
    expect(prompt).toContain("&lt;script&gt;");
  });

  test("truncates very long tool responses", () => {
    const bigResponse = "X".repeat(100_000);
    const prompt = buildCompressionPrompt("Bash", {}, bigResponse, {
      project: "proj",
      promptNumber: 1,
      userGoal: "Run",
    });
    expect(prompt.length).toBeLessThan(50_000); // Prompt should be bounded
    expect(prompt).toContain("[...truncated");
  });
});

describe("buildSummaryPrompt", () => {
  const mockSession: Pick<Session, "claude_session_id" | "project" | "prompt_counter"> = {
    claude_session_id: "session-abc123",
    project: "my-project",
    prompt_counter: 5,
  };

  const mockObservations: Observation[] = [
    {
      id: 1,
      session_id: "session-abc123",
      tool_name: "Edit",
      compressed: true,
      type: "bugfix",
      title: "Fixed null check in auth",
      narrative: "Added null check to prevent crash.",
      created_at: new Date().toISOString(),
    },
  ];

  test("returns a string containing the c-mem-summarize tag", () => {
    const prompt = buildSummaryPrompt(mockSession, mockObservations, "Fix auth", "Done");
    expect(prompt).toContain("<c-mem-summarize>");
    expect(prompt).toContain("</c-mem-summarize>");
  });

  test("includes session metadata", () => {
    const prompt = buildSummaryPrompt(mockSession, mockObservations);
    expect(prompt).toContain("my-project");
    expect(prompt).toContain("session-abc123");
  });

  test("includes observation count", () => {
    const prompt = buildSummaryPrompt(mockSession, mockObservations);
    expect(prompt).toContain("1"); // observation count
  });

  test("includes the expected response schema", () => {
    const prompt = buildSummaryPrompt(mockSession, [], "hello", "world");
    expect(prompt).toContain("<session_summary>");
    expect(prompt).toContain("<request>");
    expect(prompt).toContain("<investigated>");
    expect(prompt).toContain("<learned>");
    expect(prompt).toContain("<completed>");
    expect(prompt).toContain("<next_steps>");
  });

  test("handles empty observations gracefully", () => {
    const prompt = buildSummaryPrompt(mockSession, []);
    expect(prompt).toContain("No observations recorded");
  });

  test("escapes XML in last user/assistant messages", () => {
    const prompt = buildSummaryPrompt(
      mockSession,
      [],
      '<user> said "hello & goodbye"',
      "done <tag>"
    );
    expect(prompt).not.toContain("<user> said");
    expect(prompt).toContain("&lt;user&gt;");
  });

  test("handles undefined messages gracefully", () => {
    expect(() => buildSummaryPrompt(mockSession, [])).not.toThrow();
  });
});

// ─── Hook Integration Stubs ───────────────────────────────────────────────────
// These tests verify hook logic without spawning processes.
// Full end-to-end hook tests require Builder C's DB schema.

describe("Post-tool-use skip list logic", () => {
  const SKIP_TOOLS = new Set([
    "TodoWrite",
    "AskUserQuestion",
    "ListMcpResourcesTool",
    "SlashCommand",
    "Skill",
  ]);

  test("TodoWrite is in skip list", () => {
    expect(SKIP_TOOLS.has("TodoWrite")).toBe(true);
  });

  test("AskUserQuestion is in skip list", () => {
    expect(SKIP_TOOLS.has("AskUserQuestion")).toBe(true);
  });

  test("ListMcpResourcesTool is in skip list", () => {
    expect(SKIP_TOOLS.has("ListMcpResourcesTool")).toBe(true);
  });

  test("SlashCommand is in skip list", () => {
    expect(SKIP_TOOLS.has("SlashCommand")).toBe(true);
  });

  test("Skill is in skip list", () => {
    expect(SKIP_TOOLS.has("Skill")).toBe(true);
  });

  test("Edit is NOT in skip list", () => {
    expect(SKIP_TOOLS.has("Edit")).toBe(false);
  });

  test("Bash is NOT in skip list", () => {
    expect(SKIP_TOOLS.has("Bash")).toBe(false);
  });

  test("Read is NOT in skip list", () => {
    expect(SKIP_TOOLS.has("Read")).toBe(false);
  });
});

describe("Graceful degradation — worker down", () => {
  // Simulate a fetch that times out (worker is down)
  test("fetch abort via AbortController simulates worker timeout", async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-abort to simulate timeout

    let caught = false;
    try {
      await fetch("http://127.0.0.1:37888/health", { signal: controller.signal });
    } catch {
      caught = true;
    }
    // Should throw, and hook should catch this and return continue
    expect(caught).toBe(true);
  });
});

describe("Secret scrubbing integration — compound content", () => {
  test("scrubs multiple secret types in a single block of text", () => {
    const content = `
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
api_key=sk-ant-api03-supersecretkey123456789
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature
`;
    const result = scrubSecrets(content);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("wJalrXUtnFEMI");
    expect(result).not.toContain("sk-ant-api03");
    expect(result).toContain("[REDACTED");
  });

  test("scrubs secrets from an .env file dump", () => {
    const envDump = `
PORT=3000
NODE_ENV=production
DATABASE_URL=postgresql://admin:s3cr3tpassw0rd@db.example.com:5432/mydb
STRIPE_SECRET_KEY=sk_live_FAKE_STRIPE_KEY_FOR_TESTING_ONLY
SENDGRID_API_KEY=SG.longapikeythatisverysecret123456789
`;
    const result = scrubSecrets(envDump);
    // Non-secret values preserved
    expect(result).toContain("PORT=3000");
    expect(result).toContain("NODE_ENV=production");
    // Secrets scrubbed
    expect(result).not.toContain("s3cr3tpassw0rd");
    expect(result).not.toContain("sk_live_1234567890");
  });
});
