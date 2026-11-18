# Handoff — DailyBot strategy research and paper engine — 2026-11-18

GOAL (verbatim, user messages in order, Turkish):
- "Simdi bizim agentic pattern adinda bir baslangic repomuz var, onun uzerine insa edelim bu sistemi hatalari duzeltip eksiklikleri giderip sistemi ekleyerek. Cunku lovable da calismayacak artik ve bizim hostinger de vps imiz var onu kullanabiliriz"
- "Siradiyla basla ve herseyin dogru daha onceki gibi ama dogru fix ve iyilestirmelerle calistigindan emin ol"
- "En iyi arastirmayi yap, en iyi stratehiyi bul"
- "Senden derin arastirma yapmani iatiyorum. 2020-2026 arasinda hep kar ettiren stratejiler neler olmus. Stop lossu düzgün, dogru zamanda dogru hareketi yapan"
- "Sadece tp veya sl degil her steatejiyi incele, illa ayni kodu alman gerekmiyor. Ama o kodu okuyup aorunlari cozup en iyi versiyonu kullanman lazim."

CONSTRAINTS (verbatim): Binance USDⓈ-M futures, long + short ("Futures long + short"), TypeScript, new repo (https://github.com/aliercankonus/DailyBot), runs on the user's Hostinger VPS. Plus everything in `CLAUDE.md` (risk limits 2%/5x not to be raised, max 8 gates, strategy changes need a recorded backtest). Reply to the user in Turkish.

## Decisions and rulings
- Rebuilt from scratch on agent-patterns; old repo (`aliercankonus/dailytradingbot`) used only as a source of ideas — it traded spot, never reached its strategy templates, and only its entry SL/TP ever hit the exchange.
- Acceptance gate (OOS from 2025-01-01): trades-based ≥100 trades, PF ≥1.3, E ≥0.3R, DD ≤20%, every OOS year PF >1; weights-based Sharpe ≥1.0, DD ≤20%, every OOS year >0.
- Nothing has passed. Best candidates: G (daily Donchian ensemble, long-only, Sharpe 1.27 full / 0.06 OOS) and G-LS (long/short, positive 6 of 7 years, Sharpe 0.92 / OOS 0.31). Too many candidates tested on the same data → the only clean test left is forward paper trading.
- Old-bot ideas (3 rounds) all fail; time stop is the only neutral-to-positive exit; dd-scale/loss-streak halve DD but cut Sharpe 0.74 → 0.47. Do not port more old ideas.

## Artifacts
- `PROGRESS.md` — all results tables (sections "Backtest results", "Next"), old-bot review summary.
- `docs/PLAN.md`, `docs/legacy-review.md`.
- Commits on `main`: 11c9014 (old ideas ported), 9950fd8 (rounds 1–3 recorded). Remote moved to https://github.com/aliercankonus/DailyBot.git (push still works via redirect).
- Image `ghcr.io/aliercankonus/dailybot:main`, built by `.github/workflows/ci.yml` on push.

## Files touched (most relevant)
- `src/strategy/registry.ts` — trades strategies; `name+preset` resolves exit overlays.
- `src/strategy/oldIdeas.ts`, `src/strategy/exitOverlays.ts` — S1–S4 and overlays.
- `src/strategy/donchianEnsemble.ts` — G / G-LS; `src/backtest/weights.ts`, `src/backtest/catalog.ts` — weight strategies (`donchian`, `donchianls`, `carry`, `btchold`, `ewhold`, `xsmom`).
- `src/backtest/engine.ts` — `riskModifiers {ddScale, lossStreak}`.
- `src/engine/engine.ts` — live engine, trades strategies only (no weight-strategy support yet).
- `docker-compose.vps.yml` — research service controlled by env RESEARCH, RESEARCH_STRATEGIES, RESEARCH_ARGS.

## Current state
- Works: 217 tests (`npm test`; Postgres tests need local pg, see below). VPS 1955523 Docker project `dailybot`, MODE=paper, engine runs strategy A (trend, 4h, 5 coins) with live public data; API at 127.0.0.1:8081 (8080 belongs to signal-desk).
- Research runs: deploy via Hostinger MCP `vps_docker_create` {virtualMachineId 1955523, project_name "dailybot", content = docker-compose.vps.yml text, environment = POSTGRES_PASSWORD + API_TOKEN (values in session scratchpad `vps-secrets.env` and in the hPanel project env — REDACTED here) + `MODE=paper`, `RESEARCH=1`, `RESEARCH_STRATEGIES=...`, `RESEARCH_ARGS=...`}. Read with `vps_docker_logs` {virtualMachineId 1955523, projectName "dailybot"}. Logs cap ~300 lines/service → max 4 strategies per run. Research container currently Exited (2) — set RESEARCH=0 on the next deploy to stop re-running it.
- Local Postgres for tests: `su postgres -c "$PGB/pg_ctl -D /var/tmp/te-pg/data -o '-p 55432 -k /var/tmp/te-pg -c listen_addresses=localhost' -l /var/tmp/te-pg/log start"`, then `TEST_DATABASE_URL=postgres://trader@localhost:55432/trader npm test` (container may be fresh; recreate if missing).
- Gotchas: safety check false-positives on heredocs with `$$` — write files with Write/Edit or `git commit -F -`. `.gitignore` uses `/data/` (not `data/`) so `src/data/` is tracked.
- Fails: nothing known.

## Next steps (ordered)
1. Ask the user to approve (not yet approved): engine support for weight strategies — daily rebalance orders to target weights + exchange-side catastrophic stop per position — then forward-test G-LS and G in paper mode at a 15% vol target (expected DD ~20%).
2. Testnet validation of stop orders (`BINANCE_STOP_API` auto|algo|legacy) and full order lifecycle; needs testnet keys from the user (use request_credential / hPanel env, never chat).
3. Dashboard (React) reading the API.
4. Run `/e2e-code-review` before merging engine/exchange/risk changes (security reviewer mandatory).

## Suggested skills for the next agent
- `/delegate` for the weight-engine work; `/e2e-code-review` before merge; `/context-handoff` at ~75% context.

## Open questions for user
- Approve building weight-strategy support in the engine and paper forward-testing G-LS/G?
- When will testnet API keys be available?

## Probes
- Which strategies are the best candidates and why didn't they pass? (G / G-LS; OOS 2025–26 Sharpe 0.06 / 0.31, DD 44% / 25.5%.)
- How do you run a backtest batch on the VPS and read the result? (vps_docker_create with RESEARCH=1 env, then vps_docker_logs; ≤4 strategies.)
- What did the three old-idea rounds conclude? (All fail; only time stop neutral; risk modifiers lower Sharpe.)
- What is the next step and is it approved? (Weight-strategy engine + paper forward test; not yet approved.)
