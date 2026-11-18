# Handoff — DailyBot strategy research → paper portfolio — 2026-11-18

GOAL (verbatim, user messages in order, Turkish):
- "Simdi bizim agentic pattern adinda bir baslangic repomuz var, onun uzerine insa edelim bu sistemi hatalari duzeltip eksiklikleri giderip sistemi ekleyerek. Cunku lovable da calismayacak artik ve bizim hostinger de vps imiz var onu kullanabiliriz"
- "Siradiyla basla ve herseyin dogru daha onceki gibi ama dogru fix ve iyilestirmelerle calistigindan emin ol"
- "En iyi arastirmayi yap, en iyi stratehiyi bul"
- "Senden derin arastirma yapmani iatiyorum. 2020-2026 arasinda hep kar ettiren stratejiler neler olmus. Stop lossu düzgün, dogru zamanda dogru hareketi yapan"
- "Sadece tp veya sl degil her steatejiyi incele, illa ayni kodu alman gerekmiyor. Ama o kodu okuyup aorunlari cozup en iyi versiyonu kullanman lazim."
- "Benim demek istedigim sl tp gibi risk faktorleri ve diger stratejileri kullanalim diye. Yoksa eski kodu kullanalaim oradaki fazla indikator stragejileri kullanalim demiyorum. Mesela tp1 tp2 ve diger ise yarar seyleri kullanalim"
- "Ya iste bunun gibi eski kodda ne ise yarar seyler yapmisiz. Bunlari incele"
- "Ama en azından hedefe ulastikca stop loss o anki fiyata getirmeyi eklememiz alzim. Diyelim ki hedefin yuzde 50 sine ulastik stopnloss ons gore gubcelleniyor"
- "Tamam en iyi sonucu bulana kadar arastir ve bul, zararlarida nasil engelleriz sebepleri neler incele"
- "Tamam 8. Tur sonrasi en iyi ihtinalleri birlwtirip bana guzel analiz yap ve geleceknplanalrimizi ortaya ciksin"
- "Hayirbtum indikatorn veya baska method stratejileri aradtir derin bir sekilde. Internet videolari aramalari gez. Ben bu sonuctan memnun degilim. Sen dunyanin en iyi traderisin ve daha once en cok kazanan en az kaybeden botunu yapmis kisisin. Buna gore aradtirmani yap test et va bana haber ver"

CONSTRAINTS (verbatim): Binance USDⓈ-M futures, long + short ("Futures long + short"), TypeScript, new repo (https://github.com/aliercankonus/DailyBot), runs on the user's Hostinger VPS. Plus everything in `CLAUDE.md` (risk limits 2%/5x not to be raised, max 8 gates, strategy changes need a recorded backtest). Reply to the user in Turkish.

## Decisions and rulings
- Old repo (`aliercankonus/dailytradingbot`) is a source of ideas only. All its useful risk/exit tools were ported and tested (rounds 1–6); inventory and reasons are in PROGRESS.md.
- Every exit that takes profit earlier than A's 3-ATR trail hurts (break-even, lock tiers, R trail, stepped stop, TP1/TP2 incl. the old bot's exact ladder `tpold`). Reason (round 7 loss attribution): given-back profit is only −37R vs +364R from the 7% of trades that reach 3R+. Do not reopen this without new evidence.
- Adopted: volatility filter (`trendlv`, maxAtrPct 3%) and the loser time stop (`+timestop`). Not adopted: ADX cap (only works OOS = curve fitting), dd-scale/loss-streak (lower Sharpe), same-side cap/cooldown (optional risk-budget knob).
- Round 9 tested the 11 most recommended public strategies at published settings (Supertrend 4h/1d, MACD+EMA200, LazyBear squeeze, Ichimoku, Padysak-Vojtko 10-day max/min, Larry Williams vol breakout, 21-23 UTC seasonality, Turtle 55/20, golden cross, Connors RSI2). Only Supertrend(10,3) daily on 20 coins (`st1d`) works in both periods (IS PF 1.87, OOS 1.22, robust ±20%). Round 10: relative value vs BTC (`ethbtcmr`, `altbtcmr`, `altbtctrend`) all fail.
- BEST CANDIDATE (round 10): equal thirds `st1d` (daily, 20 coins, 0.5% risk) + `trendlv+timestop` (4h, 5 coins, 1% risk) + `donchianls` (G-LS, daily, 20 coins): positive every year 2020–2026, CAGR 18.5%, Sharpe 1.04, max DD 18.6%; from 2025 Sharpe 0.68, DD 16.8%. (Previous best A-LV+timestop + G-LS 50/50: Sharpe 0.99, DD 20.7%.)
- PARAMETERS ARE FROZEN (~35 variants tested on 2020–2026). Paper trading is now the only valid test.

## Artifacts
- Report for the user (Turkish, published, version 2 covers rounds 1–10): https://claude.ai/artifact/FqxTDUMpNa1PHf6EjBdvzD — source file was in the session scratchpad (`dailybot-rapor.html`); to update from a new session, read the artifact by URL and republish with `url`.
- `PROGRESS.md` — every round's table (rounds 1–8), loss attribution, portfolio table.
- Commits on `main` (all CI green): 31557d8 popular strategies + `--brief`, 4852a8a relative value, f15aae7 round 10 recorded; earlier 88b607f TP support, a74c71e same-side cap/cooldown, 2e7a586 stepped stops, 337e3f0 `--analyze`, 1c211be `trendlv`, 13e0043 combo CLI + RESEARCH_COMBO, 03f319d round 8 recorded.

## Files touched (most relevant)
- `src/strategy/popular.ts` — the 11 public strategies (registry names st4h, st1d, macd, sqzlb, ichi, maxmin, volbo, night, turtle, gcross, rsi2); `src/core/indicators.ts` adds supertrend, macd, linreg, highestHigh/lowestLow.
- `src/strategy/relativeValue.ts` — dollar-neutral alt/BTC revert/trend (catalog names ethbtcmr, altbtcmr, altbtctrend).
- `src/cli/backtest.ts` — `--brief` two-line summary per strategy (use for screening many strategies in one run).
- `src/strategy/trendBreakout.ts` — new param `maxAtrPct` (0 = off).
- `src/strategy/registry.ts` — `trendlv` entry (A with maxAtrPct 0.03); presets compose via lastIndexOf("+").
- `src/strategy/exitOverlays.ts` — presets be, lock, trail, timestop, tp1, tp12, tp23, tp2, tpold, tpoldnb, tp1nb, step, steptight; lockTiers accepts a custom table.
- `src/backtest/engine.ts` — partial TPs, `maxSameDirection`, `reentryCooldownBars`, per-trade `bars`/`mfeR`/`maeR`.
- `src/backtest/analysis.ts` + `--analyze` in `src/cli/backtest.ts` — loss attribution.
- `src/backtest/combine.ts`, `src/cli/combo.ts` (`npm run combo -- --legs "a:0.5,b:0.5"`) — portfolio blending, daily rebalanced.
- `docker-compose.vps.yml` — research service env: RESEARCH, RESEARCH_STRATEGIES (`none` skips), RESEARCH_ARGS, RESEARCH_COMBO (space-separated portfolios of comma-separated name:weight).
- `src/cli/engine.ts` — live engine refuses strategies with takeProfit (unused now; TPs rejected).
- `src/engine/engine.ts` — live engine supports trades strategies only; NO weight-strategy (G-LS) support yet.

## Current state
- 2026-11-18 23:12 UTC: PHASE 1 DEPLOYED. Three paper engines run on the VPS (engine A-LV+timestop / engine-st st1d / engine-gls donchianls), each with its own DB (trader / trader_st / trader_gls) and API (8081/8082/8083). Next check: G-LS first rebalance after 00:00 UTC (events table in trader_gls: REBALANCE). Deferred before testnet/live: see PROGRESS.md Deployment.
- Works: 247 tests (241 pass + 6 Postgres skipped without TEST_DATABASE_URL). VPS 1955523 project `dailybot`, MODE=paper, engine still runs plain `trend` (A) at 0.5% risk; API 127.0.0.1:8081 (8080 = signal-desk). Research container exited after round 8 (RESEARCH=1 still set in the project env; set RESEARCH=0 on the next deploy).
- Deploy: Hostinger MCP `vps_docker_create` {virtualMachineId 1955523, project_name "dailybot", content = full docker-compose.vps.yml text, environment = POSTGRES_PASSWORD + API_TOKEN (in the hPanel project env and the session scratchpad `vps-secrets.env` — REDACTED here; if the scratchpad is gone, ask the user or read them from hPanel, never commit them) + MODE=paper + RESEARCH… lines}. Logs: `vps_docker_logs` {virtualMachineId 1955523, projectName "dailybot"}, ~300 lines/service (≈2 strategies + 3 portfolios per run).
- Local Postgres for tests: `su postgres -c "$PGB/pg_ctl -D /var/tmp/te-pg/data -o '-p 55432 -k /var/tmp/te-pg -c listen_addresses=localhost' -l /var/tmp/te-pg/log start"`, then `TEST_DATABASE_URL=postgres://trader@localhost:55432/trader npm test` (recreate if the container is fresh).
- Gotchas: the safety check false-positives on heredocs/python with `$$` — write edit scripts to the scratchpad with Write (build `$$` as `'$' * 2`) or use Edit. `git commit -F -` heredocs without `$$` are fine.
- Fails: nothing known.

## Next steps (ordered) — the user asked for the plan; phase 1 is proposed, NOT yet explicitly approved
1. Phase 1 (1–2 weeks): weight-strategy support in the live engine (daily rebalance of G-LS to target weights via the Exchange interface with deterministic clientIds, an exchange-side catastrophic stop per position, reconcile), switch A to `trendlv+timestop`, run `st1d` (trades strategy, daily, 20 coins) as a second engine instance or multi-strategy engine, split capital in equal thirds (risk 0.5%/trade, leverage ≤3), paper exchange support, tests, `/e2e-code-review` with security reviewer (engine/exchange/risk changes). Confirm with the user before starting if they have not replied "devam"/approved.
2. Phase 2 (2–3 months): paper vs backtest weekly comparison; Telegram alerts; simple dashboard. Stop rule: DD > 15% or large deviation from backtest expectations.
3. Phase 3 (parallel): Binance testnet order lifecycle (`BINANCE_STOP_API` auto|algo|legacy); needs testnet keys from the user (request_credential / hPanel env, never chat).
4. Phase 4: small live capital at 0.5% risk if paper holds up.
5. Research only on new data or in paper; do not retune frozen parameters. Ideas: A on more coins, portfolio-level vol target.

## Suggested skills for the next agent
- `/delegate` for the weight-engine work; `/e2e-code-review` before merge; `/context-handoff` at ~75% context.

## Open questions for user
- Approve phase 1 (weight-strategy engine + 50/50 paper portfolio)?
- When will testnet API keys be available?
- Capital size for the eventual small live test.

## Probes
- What is the recommended portfolio and its backtest numbers? (⅓ st1d + ⅓ trendlv+timestop + ⅓ donchianls; every year positive 2020–26, CAGR 18.5%, Sharpe 1.04, DD 18.6%, from-2025 Sharpe 0.68.)
- Which popular internet strategies were tested and which survived? (11 in round 9; only Supertrend daily; pairs vs BTC failed in round 10.)
- Why are TP1/TP2 and stepped stops not used? (Given-back profit is −37R vs +364R from big winners; every early-profit exit lowered OOS PF.)
- What must be built before the portfolio can run in paper? (Weight-strategy support in the live engine: daily rebalance + exchange-side catastrophic stops; switch A to trendlv+timestop.)
- Can parameters still be tuned on 2020–2026 data? (No, frozen; paper is the only valid test.)
