// Operations dashboard: one read-only page over all engine databases. HTTP Basic auth on every
// route except /health; no write endpoints (the kill switch stays on the per-engine API).
import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { authFailureLimiter } from "../api/server.js";
import { engineSnapshot, type EngineSource } from "./data.js";
import { DASHBOARD_HTML } from "./page.js";

export interface DashboardOptions {
  engines: EngineSource[];
  user: string;
  password: string;
  prices: (now: number) => Promise<Record<string, number>>;
  now?: () => number;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function buildDashboard(opts: DashboardOptions) {
  if (opts.password.length < 12) throw new Error("DASHBOARD_PASSWORD must be at least 12 characters");
  const now = opts.now ?? Date.now;
  // One trusted hop (traefik): req.ip is the address traefik appended, not a client-supplied
  // X-Forwarded-For entry, so the failed-auth lockout cannot be dodged by spoofing the header.
  const app = Fastify({ logger: false, trustProxy: (_addr: string, hop: number) => hop < 1 });
  const limiter = authFailureLimiter(now);
  const expected = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.split("?")[0] === "/health") return;
    if (limiter.blocked(req.ip)) return reply.code(429).send({ error: "too many failed attempts" });
    if (!safeEqual(req.headers.authorization ?? "", expected)) {
      if (req.headers.authorization) limiter.fail(req.ip);
      return reply.code(401).header("WWW-Authenticate", 'Basic realm="DailyBot", charset="UTF-8"').send({ error: "unauthorized" });
    }
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(DASHBOARD_HTML));

  app.get("/api/overview", async () => {
    const t = now();
    const [prices, ...engines] = await Promise.all([
      opts.prices(t),
      ...opts.engines.map((e) => engineSnapshot(e, t).catch((err) => {
        // Details (host names, roles) stay in the server log; the client gets a generic message.
        console.error(JSON.stringify({ level: "error", msg: "dashboard snapshot failed", engine: e.key, error: err instanceof Error ? err.message : String(err) }));
        return { key: e.key, label: e.label, error: "veri alınamadı (sunucu loguna bakın)" };
      })),
    ]);
    return { generatedAt: t, prices, engines };
  });

  return app;
}
