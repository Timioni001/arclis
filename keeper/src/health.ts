/**
 * Is the keeper alive, and how would anyone know?
 *
 * Without this the only evidence the keeper is running is the absence of a
 * staleness banner on the site, which is a signal that arrives sixty seconds
 * late and says nothing about why. On a host that can restart a wedged
 * process, "wedged" has to be something the host can ask about.
 *
 * # Why liveness is not price freshness
 *
 * The obvious health check is "has a price been published recently", and it
 * is wrong. Markets close. Overnight, at a weekend, on Thanksgiving, the
 * correct behaviour is to publish nothing, and a health check built on
 * freshness would report failure every evening and have the host restart a
 * process that is doing exactly what it should. A restart loop every night is
 * worse than no health check at all.
 *
 * So the verdict is about the *loop*: is each task completing its work on
 * something like its own schedule, and is it erroring every time it tries.
 * Price freshness is reported as data, for a human reading the endpoint, and
 * never decides the verdict.
 */

import { createServer } from "node:http";

/** Consecutive failures tolerated before a task is called broken. */
const FAILURE_BUDGET = 5;
/**
 * How many intervals a task may miss before it counts as stalled. Six, because
 * an RPC round trip that hangs can swallow two or three on a bad endpoint and
 * a restart is worse than waiting.
 */
const STALL_INTERVALS = 6;
/** A stall floor, so a fast loop is not declared dead for a brief hiccup. */
const MIN_STALL_MS = 60_000;

interface Task {
  intervalMs: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** When the task was registered, so a slow first tick is not a stall. */
  registeredAt: number;
}

export interface HealthMeta {
  rpc: string;
  programId: string;
  keeper: string;
  symbols: string[];
  feed: string;
}

export interface Health {
  /** Declare a task and the cadence it is expected to keep. */
  register(name: string, intervalMs: number): void;
  /** The callback `loop` calls after every pass. */
  reporter(name: string): (outcome: { ok: boolean; error?: string }) => void;
  /** Record a successful publish, for the humans reading the endpoint. */
  published(symbols: string[], at?: number): void;
  report(now?: number): {
    ok: boolean;
    [key: string]: unknown;
  };
}

export function newHealth(meta: HealthMeta, startedAt = Date.now()): Health {
  const tasks = new Map<string, Task>();
  const lastPublished = new Map<string, number>();

  function stalled(task: Task, now: number): boolean {
    const budget = Math.max(MIN_STALL_MS, task.intervalMs * STALL_INTERVALS);
    const since = task.lastOkAt ?? task.registeredAt;
    return now - since > budget;
  }

  return {
    register(name, intervalMs) {
      tasks.set(name, {
        intervalMs,
        lastOkAt: null,
        lastErrorAt: null,
        lastError: null,
        consecutiveFailures: 0,
        registeredAt: Date.now(),
      });
    },

    reporter(name) {
      return ({ ok, error }) => {
        const task = tasks.get(name);
        if (!task) return;
        if (ok) {
          task.lastOkAt = Date.now();
          task.consecutiveFailures = 0;
          return;
        }
        task.lastErrorAt = Date.now();
        task.lastError = error ?? "unknown";
        task.consecutiveFailures += 1;
      };
    },

    published(symbols, at = Math.floor(Date.now() / 1000)) {
      for (const symbol of symbols) lastPublished.set(symbol, at);
    },

    report(now = Date.now()) {
      const detail: Record<string, unknown> = {};
      let ok = true;
      for (const [name, task] of tasks) {
        const isStalled = stalled(task, now);
        const isFailing = task.consecutiveFailures >= FAILURE_BUDGET;
        if (isStalled || isFailing) ok = false;
        detail[name] = {
          ok: !isStalled && !isFailing,
          stalled: isStalled,
          intervalMs: task.intervalMs,
          secsSinceOk:
            task.lastOkAt === null
              ? null
              : Math.round((now - task.lastOkAt) / 1000),
          consecutiveFailures: task.consecutiveFailures,
          lastError: task.lastError,
        };
      }

      return {
        ok,
        ...meta,
        uptimeSecs: Math.round((now - startedAt) / 1000),
        tasks: detail,
        // Reported, never judged: see the note at the top of this file about
        // why a closed market must not look like a failure.
        lastPublishedAt: Object.fromEntries(lastPublished),
      };
    },
  };
}

/**
 * Serve the report on `port`.
 *
 * Every path answers, because a health checker asks for whatever it was
 * configured to ask for and a 404 from the wrong path reads as a dead
 * process. 503 when the verdict is false, so a host that restarts on failed
 * checks has something to act on.
 */
export function startHealthServer(
  health: Health,
  port: number,
  signal: AbortSignal,
  log: (level: "info" | "error", message: string, extra?: unknown) => void,
): void {
  const server = createServer((_req, res) => {
    const body = health.report();
    res.writeHead(body.ok ? 200 : 503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body, null, 2));
  });

  server.on("error", (err) => {
    // A port clash must not take the keeper down with it. Publishing prices
    // is the job; being observable is a convenience.
    log("error", "health server failed to bind", { message: err.message });
  });

  server.listen(port, "0.0.0.0", () =>
    log("info", "health server listening", { port }),
  );
  signal.addEventListener("abort", () => server.close(), { once: true });
}
