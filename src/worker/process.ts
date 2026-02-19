/**
 * C-Mem Worker: Process Manager
 *
 * Manages the worker as a child process:
 *   - PID file at ~/.c-mem/worker.pid (atomic write, no TOCTOU)
 *   - Health check: GET /health with 10s timeout, retry 3x with 2s delay
 *   - Graceful shutdown: SIGTERM → wait 5s → SIGKILL
 *   - Auto-restart on crash (max 3 restarts in 60s, then alert and give up)
 *   - Uses standard node child_process (not Bun-specific) for portability
 */

import {
  spawn,
  type ChildProcess,
} from "child_process";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  renameSync,
} from "fs";
import { join } from "path";

// ───────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────

export interface ProcessManagerOptions {
  /** Data directory (default: ~/.c-mem) */
  dataDir?: string;
  /** Worker port */
  port?: number;
  /** Path to the compiled worker script */
  workerScript?: string;
  /** Maximum restarts within 60s before giving up */
  maxRestartsIn60s?: number;
}

// ───────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────

const DEFAULT_DATA_DIR = join(
  process.env["HOME"] ?? "/tmp",
  ".c-mem"
);
const DEFAULT_PORT = 37888;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_RETRIES = 3;
const HEALTH_CHECK_RETRY_DELAY_MS = 2_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_RESTARTS_DEFAULT = 3;
const RESTART_WINDOW_MS = 60_000;

// ───────────────────────────────────────────────────────
// ProcessManager
// ───────────────────────────────────────────────────────

export class ProcessManager {
  private dataDir: string;
  private pidFile: string;
  private portFile: string;
  private port: number;
  private workerScript: string;
  private maxRestartsIn60s: number;

  private child: ChildProcess | null = null;
  private restartTimestamps: number[] = [];
  private stopped = false;

  constructor(options: ProcessManagerOptions = {}) {
    this.dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    this.port = options.port ?? DEFAULT_PORT;
    this.workerScript =
      options.workerScript ??
      join(process.cwd(), "src", "worker", "server.ts");
    this.maxRestartsIn60s = options.maxRestartsIn60s ?? MAX_RESTARTS_DEFAULT;

    this.pidFile = join(this.dataDir, "worker.pid");
    this.portFile = join(this.dataDir, "worker.port");

    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
  }

  // ─────────────────────────────────────
  // Start
  // ─────────────────────────────────────

  /**
   * Start the worker process.
   * Returns true if started successfully (health check passed).
   */
  async start(): Promise<boolean> {
    if (this.isRunning()) {
      console.log("[pm] Worker is already running");
      return true;
    }

    this.stopped = false;
    return this.spawnWorker();
  }

  private async spawnWorker(): Promise<boolean> {
    // PRC-02: Wrap worker in macOS sandbox-exec when available.
    // sandbox-exec is built into macOS — no extra dependencies.
    const sandboxProfile = join(__dirname, "../../security/worker.sb");
    const useSandbox =
      process.platform === "darwin" && existsSync(sandboxProfile);

    const command = useSandbox ? "sandbox-exec" : "bun";
    const args = useSandbox
      ? [
          "-f", sandboxProfile,
          "-D", `HOME=${process.env["HOME"] ?? "/tmp"}`,
          "-D", `CMEM_DIR=${join(__dirname, "../..")}`,
          "bun", this.workerScript,
        ]
      : [this.workerScript];

    process.stderr.write(
      useSandbox
        ? "[c-mem] Worker starting in macOS sandbox (PRC-02)\n"
        : "[c-mem] Worker starting without sandbox (sandbox-exec not available or non-macOS)\n"
    );

    console.log(`[pm] Spawning worker: ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      detached: false, // keep attached so we can manage it
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        C_MEM_WORKER_PORT: String(this.port),
      },
    });

    this.child = child;

    // Pipe output
    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[worker] ${data}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[worker:err] ${data}`);
    });

    child.on("exit", (code, signal) => {
      console.log(`[pm] Worker exited: code=${code} signal=${signal}`);
      this.clearPidFile();
      if (!this.stopped) {
        this.handleCrash(code, signal);
      }
    });

    // Write PID atomically
    if (child.pid !== undefined) {
      this.writePidAtomic(child.pid);
      writeFileSync(this.portFile, String(this.port), "utf-8");
    }

    // Wait for health check
    const healthy = await this.waitForHealth();
    if (!healthy) {
      console.error("[pm] Worker failed health check — killing");
      this.killChild();
      return false;
    }

    console.log(`[pm] Worker healthy on port ${this.port} (PID ${child.pid})`);
    return true;
  }

  private handleCrash(code: number | null, signal: string | null): void {
    if (this.stopped) return;

    const now = Date.now();
    // Prune old timestamps outside the window
    this.restartTimestamps = this.restartTimestamps.filter(
      (t) => now - t < RESTART_WINDOW_MS
    );

    if (this.restartTimestamps.length >= this.maxRestartsIn60s) {
      console.error(
        `[pm] ALERT: Worker crashed ${this.restartTimestamps.length + 1} times in 60s. Giving up.`
      );
      console.error(`[pm] Last exit: code=${code} signal=${signal}`);
      return;
    }

    this.restartTimestamps.push(now);
    const restartNum = this.restartTimestamps.length;
    console.log(`[pm] Restarting worker (attempt ${restartNum}/${this.maxRestartsIn60s})...`);

    setTimeout(() => {
      this.spawnWorker().catch((err) => {
        console.error("[pm] Failed to restart worker:", err);
      });
    }, 1_000);
  }

  // ─────────────────────────────────────
  // Stop
  // ─────────────────────────────────────

  /**
   * Gracefully stop the worker.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.child) {
      await this.gracefulShutdown(this.child);
      this.child = null;
    } else {
      // Try stopping via PID file
      const pid = this.readPid();
      if (pid !== null) {
        await this.gracefulShutdownByPid(pid);
      }
    }

    this.clearPidFile();
    console.log("[pm] Worker stopped");
  }

  private async gracefulShutdown(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;

      child.once("exit", () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      child.kill("SIGTERM");

      setTimeout(() => {
        if (!resolved) {
          console.warn("[pm] Graceful shutdown timed out — SIGKILL");
          try {
            child.kill("SIGKILL");
          } catch {}
          resolved = true;
          resolve();
        }
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    });
  }

  private async gracefulShutdownByPid(pid: number): Promise<void> {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return; // process already gone
    }

    const deadline = Date.now() + GRACEFUL_SHUTDOWN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(200);
      if (!isPidAlive(pid)) return;
    }

    // Force kill
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  private killChild(): void {
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {}
      this.child = null;
    }
  }

  // ─────────────────────────────────────
  // Health Check
  // ─────────────────────────────────────

  /**
   * Poll /health until it responds or retries exhausted.
   */
  async waitForHealth(): Promise<boolean> {
    for (let attempt = 1; attempt <= HEALTH_CHECK_RETRIES; attempt++) {
      await sleep(HEALTH_CHECK_RETRY_DELAY_MS);

      const ok = await this.checkHealth();
      if (ok) return true;

      console.log(
        `[pm] Health check attempt ${attempt}/${HEALTH_CHECK_RETRIES} failed`
      );
    }
    return false;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        HEALTH_CHECK_TIMEOUT_MS
      );

      const res = await fetch(
        `http://127.0.0.1:${this.port}/health`,
        { signal: controller.signal }
      );
      clearTimeout(timer);

      if (!res.ok) return false;
      const body = await res.json() as { status?: string };
      return body.status === "ok";
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────
  // Status
  // ─────────────────────────────────────

  isRunning(): boolean {
    if (this.child && this.child.exitCode === null) return true;
    const pid = this.readPid();
    if (pid === null) return false;
    return isPidAlive(pid);
  }

  getStatus(): {
    running: boolean;
    pid: number | null;
    port: number;
  } {
    const pid = this.child?.pid ?? this.readPid();
    return {
      running: this.isRunning(),
      pid: pid ?? null,
      port: this.port,
    };
  }

  // ─────────────────────────────────────
  // PID File
  // ─────────────────────────────────────

  /**
   * Atomic PID file write: write to .tmp then rename.
   * Prevents TOCTOU races.
   */
  private writePidAtomic(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) {
      console.error(`[pm] Invalid PID: ${pid}`);
      return;
    }
    const tmp = `${this.pidFile}.tmp`;
    writeFileSync(tmp, String(pid), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.pidFile);
  }

  private readPid(): number | null {
    if (!existsSync(this.pidFile)) return null;
    try {
      const raw = readFileSync(this.pidFile, "utf-8").trim();
      const pid = parseInt(raw, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        console.warn(`[pm] Invalid PID in file: ${raw}`);
        return null;
      }
      return pid;
    } catch {
      return null;
    }
  }

  private clearPidFile(): void {
    try {
      if (existsSync(this.pidFile)) unlinkSync(this.pidFile);
    } catch {}
  }
}

// ───────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
