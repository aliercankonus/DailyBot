// Read-mostly HTTP API for the dashboard. Every route except /health needs
// `Authorization: Bearer <API_TOKEN>`. The only write is the kill switch.
import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type pg from "pg";
import type { Repo } from "../db/repo.js";
import type { KillSwitch } from "../engine/engine.js";

type SwitchState = KillSwitch & { source?: "engine" | "manual" };

const AUTH_WINDOW_MS = 60_000;
const MAX_AUTH_FAILURES = 10;
const MIN_FORCE_REASON = 10;

/** Fixed-window counter of failed auths per IP. Bounded: expired entries are swept when it grows. */
export function authFailureLimiter(now: () => number = Date.now) {
  const fails = new Map<string, { start: number; count: number }>();
  const current = (ip: string) => {
    const e = fails.get(ip);
    if (!e || now() - e.start >= AUTH_WINDOW_MS) return undefined;
    return e;
  };
  return {
    blocked: (ip: string) => (current(ip)?.count ?? 0) >= MAX_AUTH_FAILURES,
    fail(ip: string) {
      const e = current(ip);
      if (e) e.count++;
      else {
        if (fails.size > 10_000) for (const [k, v] of fails) if (now() - v.start >= AUTH_WINDOW_MS) fails.delete(k);
        fails.set(ip, { start: now(), count: 1 });
      }
    },
  };
}

// pg returns BIGINT/BIGSERIAL as strings; every BIGINT in this schema is an epoch-ms or id well below 2^53.
const BIGINT_COLS = new Set(["id", "candle_open_time", "created_at", "time"]);
function numericRow(r: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...r };
  for (const k of Object.keys(out)) if (BIGINT_COLS.has(k) && typeof out[k] === "string") out[k] = Number(out[k]);
  return out;
}

export function buildServer(opts: { pool: pg.Pool; repo: Repo; token: string; mode: string; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const app = Fastify({ logger: false });
  const expected = Buffer.from(`Bearer ${opts.token}`);
  const limiter = authFailureLimiter(now);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.split("?")[0] === "/health") return;
    if (limiter.blocked(req.ip)) return reply.code(429).send({ error: "too many failed auth attempts" });
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      limiter.fail(req.ip);
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true, mode: opts.mode }));

  app.get("/positions", async () => ({
    open: await opts.repo.listOpenPositions(),
    closed: await opts.repo.listClosed(200),
  }));

  app.get("/signals", async () => (await opts.pool.query("SELECT * FROM signals ORDER BY created_at DESC LIMIT 500")).rows.map(numericRow));
  app.get("/events", async () => (await opts.pool.query("SELECT * FROM events ORDER BY created_at DESC LIMIT 500")).rows.map(numericRow));
  app.get("/equity", async () => (await opts.pool.query("SELECT time, equity FROM equity ORDER BY time")).rows.map(numericRow));

  app.get("/status", async () => ({
    mode: opts.mode,
    killSwitch: await opts.repo.getState<SwitchState>("killSwitch"),
    equityPeak: await opts.repo.getState<number>("equityPeak"),
    dayStart: await opts.repo.getState("dayStart"),
  }));

  // Turning the switch ON is always allowed. Turning it OFF requires a non-empty reason.
  // A switch the engine turned on (or of unknown origin) also needs force:true and a reason of
  // at least 10 characters: the engine had a reason to stop trading.
  app.post("/kill-switch", async (req, reply) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { on?: unknown; reason?: unknown; force?: unknown };
    const { on, force } = body;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (typeof on !== "boolean") return reply.code(400).send({ error: "body.on must be boolean" });
    if (!on) {
      if (!reason) return reply.code(400).send({ error: "reason required to turn the kill switch off" });
      const cur = await opts.repo.getState<SwitchState>("killSwitch");
      if (cur?.on && cur.source !== "manual" && (force !== true || reason.length < MIN_FORCE_REASON)) {
        return reply.code(409).send({
          error: `kill switch was set by the engine (${cur.reason}); turning it off needs force:true and a reason of at least ${MIN_FORCE_REASON} characters`,
        });
      }
    }
    const value: SwitchState = { on, reason: reason || "manual via API", at: now(), source: "manual" };
    await opts.repo.setState("killSwitch", value);
    // The engine re-seeds the peak from current equity; otherwise the drawdown switch re-arms at once.
    if (!on) await opts.repo.setState("equityPeak", null);
    await opts.repo.recordEvent({ level: on ? "error" : "info", kind: on ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF", symbol: null, message: value.reason, createdAt: value.at });
    return value;
  });

  return app;
}
