// Read-mostly HTTP API for the dashboard. Every route except /health needs
// `Authorization: Bearer <API_TOKEN>`. The only write is the kill switch.
import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type pg from "pg";
import type { Repo } from "../db/repo.js";
import type { KillSwitch } from "../engine/engine.js";

export function buildServer(opts: { pool: pg.Pool; repo: Repo; token: string; mode: string }) {
  const app = Fastify({ logger: false });
  const expected = Buffer.from(`Bearer ${opts.token}`);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true, mode: opts.mode }));

  app.get("/positions", async () => ({
    open: await opts.repo.listOpenPositions(),
    closed: (await opts.pool.query("SELECT * FROM positions WHERE status='CLOSED' ORDER BY exit_time DESC LIMIT 200")).rows,
  }));

  app.get("/signals", async () => (await opts.pool.query("SELECT * FROM signals ORDER BY created_at DESC LIMIT 500")).rows);
  app.get("/events", async () => (await opts.pool.query("SELECT * FROM events ORDER BY created_at DESC LIMIT 500")).rows);
  app.get("/equity", async () => (await opts.pool.query("SELECT time, equity FROM equity ORDER BY time")).rows);

  app.get("/status", async () => ({
    mode: opts.mode,
    killSwitch: await opts.repo.getState<KillSwitch>("killSwitch"),
    equityPeak: await opts.repo.getState<number>("equityPeak"),
    dayStart: await opts.repo.getState("dayStart"),
  }));

  // Turning the switch ON is always allowed. Turning it OFF requires an explicit reason.
  app.post<{ Body: { on: boolean; reason?: string } }>("/kill-switch", async (req, reply) => {
    const { on, reason } = req.body ?? ({} as { on: boolean; reason?: string });
    if (typeof on !== "boolean") return reply.code(400).send({ error: "body.on must be boolean" });
    if (!on && !reason) return reply.code(400).send({ error: "reason required to turn the kill switch off" });
    const value: KillSwitch = { on, reason: reason ?? "manual via API", at: Date.now() };
    await opts.repo.setState("killSwitch", value);
    await opts.repo.recordEvent({ level: on ? "error" : "info", kind: on ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF", symbol: null, message: value.reason, createdAt: value.at });
    return value;
  });

  return app;
}
