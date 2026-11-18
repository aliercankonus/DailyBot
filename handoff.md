# Handoff — DailyBot strategy research and paper engine — 2026-11-18

GOAL (verbatim, user messages in order, Turkish):
- "Simdi bizim agentic pattern adinda bir baslangic repomuz var, onun uzerine insa edelim bu sistemi hatalari duzeltip eksiklikleri giderip sistemi ekleyerek. Cunku lovable da calismayacak artik ve bizim hostinger de vps imiz var onu kullanabiliriz"
- "Siradiyla basla ve herseyin dogru daha onceki gibi ama dogru fix ve iyilestirmelerle calistigindan emin ol"
- "En iyi arastirmayi yap, en iyi stratehiyi bul"
- "Senden derin arastirma yapmani iatiyorum. 2020-2026 arasinda hep kar ettiren stratejiler neler olmus. Stop lossu düzgün, dogru zamanda dogru hareketi yapan"
- "Sadece tp veya sl degil her steatejiyi incele, illa ayni kodu alman gerekmiyor. Ama o kodu okuyup aorunlari cozup en iyi versiyonu kullanman lazim."
- "Benim demek istedigim sl tp gibi risk faktorleri ve diger stratejileri kullanalim diye. Yoksa eski kodu kullanalaim oradaki fazla indikator stragejileri kullanalim demiyorum. Mesela tp1 tp2 ve diger ise yarar seyleri kullanalim"
- "Ya iste bunun gibi eski kodda ne ise yarar seyler yapmisiz. Bunlari incele"

CONSTRAINTS (verbatim): Binance USDⓈ-M futures, long + short ("Futures long + short"), TypeScript, new repo (https://github.com/aliercankonus/DailyBot), runs on the user's Hostinger VPS. Plus everything in `CLAUDE.md` (risk limits 2%/5x not to be raised, max 8 gates, strategy changes need a recorded backtest). Reply to the user in Turkish.

## Decisions and rulings
- Rebuilt from scratch on agent-patterns; old repo (`aliercankonus/dailytradingbot`) used only as a source of ideas — it traded spot, never reached its strategy templates, and only its entry SL/TP ever hit the exchange.
- Acceptance gate (OOS from 2025-01-01): trades-based ≥100 trades, PF ≥1.3, E ≥0.3R, DD ≤20%, every OOS year PF >1; weights-based Sharpe ≥1.0, DD ≤20%, every OOS year >0.
- Nothing has passed. Best candidates: G (daily Donchian ensemble, long-only, Sharpe 1.27 full / 0.06 OOS) and G-LS (long/short, positive 6 of 7 years, Sharpe 0.92 / OOS 0.31). Too many candidates tested on the same data → the only clean test left is forward paper trading.
- Old-bot ideas (3 rounds) all fail; time stop is the only neutral-to-positive exit; dd-scale/loss-streak halve DD but cut Sharpe 0.74 → 0.47. Do not port the old indicator strategies.
- The user wants the old bot's USEFUL risk/trade-management tools (SL/TP, TP1/TP2, etc.), not its indicator strategies. Inventory done (old `supabase/functions/_shared/constants.ts` section [8]/[9], `monitor-positions/index.ts:3375-3575`):
  - Already in new system and tested: ATR stop (old capped at 1.5% = too tight), break-even, R trailing, lock tiers, time stop, daily loss limit, max DD/kill switch, loss-streak, max open, fee-aware BE/sizing.
  - Old TP ladder (exact): full TP = 2R (SL 1.5 ATR, TP 3 ATR); TP1 at 0.66R closes 50%, TP2 at 1.32R closes 30%, TP3 at 2R closes 20%; stop to break-even after TP1. Preset `tpold`.
  - Added, not yet tested: same-side cap (old CORRELATION_PARAMS max 2 same direction) `--max-same-dir N`; re-entry cooldown after a stop (old SAME_DIRECTION_REENTRY) `--cooldown N` candles.
  - Worth adding live (not backtestable): pre-order spread check (old SLIPPAGE_PROTECTION max 0.1%), inside the order layer, not as a new gate.
  - Not ported (reasons told to user): peak/volatility-adaptive trailing (% distances below fees), ATR-based SL shrink (conflicts with risk sizing), emergency exits (exchange stop covers it), dynamic max trades, trailing daily limit, post-TP re-entry at 40%, Kelly/hedge/indicator multipliers.

## Artifacts
- `PROGRESS.md` — all results tables (sections "Backtest results", "Next"), old-bot review summary.
- `docs/PLAN.md`, `docs/legacy-review.md`.
- Commits on `main`: 11c9014 (old ideas ported), 9950fd8 (rounds 1–3 recorded), 88b607f (partial take-profits), d6c74bf (`tpold`), a74c71e (same-side cap + cooldown). CI green for all. Remote moved to https://github.com/aliercankonus/DailyBot.git (push still works via redirect).
- Image `ghcr.io/aliercankonus/dailybot:main`, built by `.github/workflows/ci.yml` on push.

## Files touched (most relevant)
- `src/strategy/registry.ts` — trades strategies; `name+preset` resolves exit overlays.
- `src/strategy/oldIdeas.ts`, `src/strategy/exitOverlays.ts` — S1–S4 and overlays; EXIT_PRESETS be, lock, trail, timestop, tp1, tp12, tp23, tp2, tpold. Presets compose: `trend+tp12+timestop`.
- `src/strategy/types.ts` — `Strategy.takeProfit` (TakeProfitPlan: levels {r, fraction of ORIGINAL qty}, breakEvenAfterFirst).
- `src/backtest/engine.ts` — `takeProfits()` intrabar after the stop check (candle touching both = stop-out; TP fills at level minus slippage; BE reached in the TP1 candle = rest stopped); partial fills stay ONE trade. `maxSameDirection`, `reentryCooldownBars` options.
- `src/cli/backtest.ts` — flags `--max-same-dir N`, `--cooldown N` (validated whole numbers >= 1).
- `src/cli/engine.ts` — live engine REFUSES strategies with takeProfit (not implemented live yet).
- `src/strategy/donchianEnsemble.ts` — G / G-LS; `src/backtest/weights.ts`, `src/backtest/catalog.ts` — weight strategies (`donchian`, `donchianls`, `carry`, `btchold`, `ewhold`, `xsmom`).
- `src/backtest/engine.ts` — also `riskModifiers {ddScale, lossStreak}`.
- `src/engine/engine.ts` — live engine, trades strategies only (no weight-strategy support yet).
- `docker-compose.vps.yml` — research service controlled by env RESEARCH, RESEARCH_STRATEGIES, RESEARCH_ARGS.

## Current state
- Works: 222 tests (216 pass + 6 Postgres skipped without TEST_DATABASE_URL) (`npm test`; Postgres tests need local pg, see below). VPS 1955523 Docker project `dailybot`, MODE=paper, engine runs strategy A (trend, 4h, 5 coins) with live public data; API at 127.0.0.1:8081 (8080 belongs to signal-desk).
- Research runs: deploy via Hostinger MCP `vps_docker_create` {virtualMachineId 1955523, project_name "dailybot", content = docker-compose.vps.yml text, environment = POSTGRES_PASSWORD + API_TOKEN (values in session scratchpad `vps-secrets.env` and in the hPanel project env — REDACTED here) + `MODE=paper`, `RESEARCH=1`, `RESEARCH_STRATEGIES=...`, `RESEARCH_ARGS=...`}. Read with `vps_docker_logs` {virtualMachineId 1955523, projectName "dailybot"}. Logs cap ~300 lines/service → max 4 strategies per run. Round 4 deployed 2026-11-18 20:43 UTC: `RESEARCH_STRATEGIES=trend+tpold trend+tp1 trend+tp12 trend+tp23`, RESEARCH_ARGS empty. Results NOT yet read. Raw results of rounds 1–3 are in PROGRESS.md (scratchpad copies may be gone in a new container).
- Local Postgres for tests: `su postgres -c "$PGB/pg_ctl -D /var/tmp/te-pg/data -o '-p 55432 -k /var/tmp/te-pg -c listen_addresses=localhost' -l /var/tmp/te-pg/log start"`, then `TEST_DATABASE_URL=postgres://trader@localhost:55432/trader npm test` (container may be fresh; recreate if missing).
- Gotchas: safety check false-positives on heredocs with `$$` — write files with Write/Edit or `git commit -F -`. `.gitignore` uses `/data/` (not `data/`) so `src/data/` is tracked.
- Fails: nothing known.

## Next steps (ordered)
1. Read round 4 logs (`vps_docker_logs`), record the TP table in PROGRESS.md, report to the user in Turkish (compare with A baseline: IS PF 1.25, OOS PF 1.12, OOS DD 34.8%, full Sharpe ~0.74; best so far A+timestop OOS PF 1.14).
2. Round 5: best TP preset (+ `+timestop`) with `RESEARCH_ARGS=--max-same-dir 2 --cooldown 3`; also the plain `trend` with those args to isolate their effect. Max 4 strategies per run.
3. If a TP preset helps: implement TP live (reduce-only TAKE_PROFIT orders per level in the Exchange interface + paper exchange, shrink stop quantity after each fill, move stop to BE after TP1), remove the refusal in `src/cli/engine.ts`, tests, `/e2e-code-review` with security reviewer. Add the pre-order spread check.
4. Ask the user to approve (not yet approved): engine support for weight strategies — daily rebalance orders to target weights + exchange-side catastrophic stop per position — then forward-test G-LS and G in paper mode at a 15% vol target (expected DD ~20%).
2. Testnet validation of stop orders (`BINANCE_STOP_API` auto|algo|legacy) and full order lifecycle; needs testnet keys from the user (use request_credential / hPanel env, never chat).
3. Dashboard (React) reading the API.
4. Run `/e2e-code-review` before merging engine/exchange/risk changes (security reviewer mandatory).

## Suggested skills for the next agent
- `/delegate` for the weight-engine work; `/e2e-code-review` before merge; `/context-handoff` at ~75% context.

## Open questions for user
- (after TP results) which TP plan to run live in paper mode.
- Approve building weight-strategy support in the engine and paper forward-testing G-LS/G?
- When will testnet API keys be available?

## Probes
- Which strategies are the best candidates and why didn't they pass? (G / G-LS; OOS 2025–26 Sharpe 0.06 / 0.31, DD 44% / 25.5%.)
- How do you run a backtest batch on the VPS and read the result? (vps_docker_create with RESEARCH=1 env, then vps_docker_logs; ≤4 strategies.)
- What did the three old-idea rounds conclude? (All fail; only time stop neutral; risk modifiers lower Sharpe.)
- What is running on the VPS right now and what comes after it? (Round 4 TP presets on A; then round 5 with --max-same-dir/--cooldown; then live TP if it helps.)
- What exactly was the old bot's TP ladder? (0.66R 50% / 1.32R 30% / 2R 20%, BE after TP1 = `tpold`.)
- Is the weight-strategy engine approved? (No, still an open question.)
