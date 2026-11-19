# Handoff — DailyBot BTC/ETH paper portfolio (round 12) — 2026-11-19

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
- (2026-11-19) "At first lets focus on eth snd btc. And i want you to find best of best results. You have past data and you can find how we can profit for each timeline.  If you say 2 percent is good for gls, do it. I will start with 2000 euro capitql amount. I will give telegram and binance testnet keys soon"
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
- 2026-11-19 08:32 UTC: ROUND 12 DEPLOYED (commit dc641bd, CI green, after /e2e-code-review REQUEST_CHANGES → fixed). Paper engines now trade BTC+ETH only, on NEW databases (old phase-1 history kept in trader / trader_st / trader_gls):
  - service `engine` = A, `trendlv+timestop` 4h, db trader_a, paper 1150 USDT, risk 1%, kill switch 30%, API 127.0.0.1:8081
  - service `engine-st` = GC, `gcross1h` (EMA50/200 on 1h), db trader_gc, paper 575 USDT, risk 1%, kill switch 50%, API 8082
  - service `engine-gls` = TS, `tsmom4h` (long only), db trader_ts, paper 575 USDT, risk 1%, kill switch 25%, API 8083
  Service names were kept on purpose (Hostinger cannot remove renamed services' old containers). Env prefixes for testnet/live keys: A none, GC_, TS_.
- Why this portfolio (PROGRESS.md round 12): BTC/ETH data from data.binance.vision 2020-01 → 2026-11-18 (fapi.binance.com is geo-blocked from cloud sessions; environment `dailybot` allows data.binance.vision). 15m: nothing works; 1h: only golden cross; 4h: A-LV+timestop best (every year positive, Sharpe 1.15); 1d: G-LS strong but far above the 2% rule. Portfolio 0.5 A + 0.25 GC + 0.25 TS: CAGR 20.3%, Sharpe 1.18, max DD 15.2%, every year positive; from 2025 CAGR 19.7%. No parameters were tuned (published/pre-registered settings).
- 2% rule for G-LS (user: "if you say 2 percent is good, do it"): done. `maxLegRisk` caps |w| x catastrophic stop (4 x ATR14, max 50%) at 2%; `donchianls2`; outside paper an uncapped weight strategy refuses to start (`validateEngineStrategy`, mode required). On 20 coins it costs little (Sharpe 0.93 → 0.89); on BTC/ETH it kills G-LS, so G-LS is not in the live plan. Known limit: the exchange stop is not re-placed between resizes (band 0.02).
- Live plan: 2,000 EUR (~2,300 USDT assumed) split 1150/575/575 USDT, three Binance sub-accounts (one per engine). BTCUSDT minimum notional 100 USDT can make TS skip BTC entries in very volatile weeks.
- Tests: 287, all pass with local Postgres. Typecheck clean.
- Deploy / secrets: a new session gets every secret FROM THE SERVER, nothing is stored in the repo: call Hostinger `vps_docker_get` {virtualMachineId 1955523, projectName "dailybot"}; it returns `content` (current compose) and `environment` (POSTGRES_PASSWORD, API_TOKEN, MODE, RESEARCH, REPORT, and later the Telegram/Binance keys once the user adds them in hPanel). To redeploy: `vps_docker_create` {virtualMachineId 1955523, project_name "dailybot", content = docker-compose.vps.yml without comment lines (must stay <= 8192 chars, now ~7.0k), environment = the `environment` string from vps_docker_get, changing only non-secret flags (e.g. REPORT=1, RESEARCH=1)}. `environment` replaces the whole set, so always start from vps_docker_get, never from memory. Never print, commit or echo the values. Image-only update (same compose/env): `vps_docker_update` {virtualMachineId, projectName}.
- Local research: `python3 -I bv_download.py <dir>` pattern (data.binance.vision monthly+daily zips → repo CSV format); `npx tsx src/cli/backtest.ts --strategy X --interval 4h --symbols BTCUSDT,ETHUSDT --dir <dir> --brief`; `npx tsx src/cli/combo.ts --legs "trendlv+timestop:0.5,gcross1h:0.25,tsmom4h:0.25" --symbols BTCUSDT,ETHUSDT --dir <dir>` (legs may be `name@1h`). Data lives in the session scratchpad (gone in a new container; re-download takes ~2 minutes).
- Local Postgres for tests: `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/te-pg/data -o '-p 55432 -k /var/tmp/te-pg -c listen_addresses=localhost' -l /var/tmp/te-pg/log start"`, then `TEST_DATABASE_URL=postgres://trader@localhost:55432/trader npm test`.
- Gotchas: safety check false-positives on `$$` in heredocs (write scripts to the scratchpad); Google Docs blocked; printing the secrets file is blocked by the auto-mode classifier (ask the user or use the hPanel env).
- Fails: nothing known.

## Next steps (ordered)
1. Watch the three BTC/ETH paper engines daily for the first week (logs: `[A]`, `[GC]`, `[TS]` prefixes; report: redeploy with REPORT=1, read `report-1`). First trades depend on signals: A and TS on 4h closes, GC on 1h EMA50/200 crosses.
2. Paper period 2-3 months, parameters FROZEN; post-mortem at each engine's 30th trade; stop rule: drawdown beyond the backtest max or flagged deviations.
3. Telegram: user will send TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID → hPanel env + deploy `environment`.
4. Testnet: user will send keys, one Binance sub-account per engine (A: BINANCE_*, GC: GC_BINANCE_*, TS: TS_BINANCE_*; plus *_MODE=testnet, *_BINANCE_BASE_URL). Via hPanel env or request_credential, never chat. Check the order lifecycle (`BINANCE_STOP_API` auto|algo|legacy).
5. Live with 2,000 EUR split 50/25/25 if paper holds up.
6. Optional: dashboard; more coins once capital grows (min notional); before any live G-LS, re-place stops when the cap changes.

## Suggested skills for the next agent
- `/e2e-code-review` before merging anything under src/engine, src/exchange or src/risk (security reviewer mandatory); `/delegate` for larger builds (dashboard, report); `/context-handoff` at ~75% context.

## Open questions for user
- Telegram bot token/chat id for alerts? (optional)
- When will Binance testnet keys (one per engine/sub-account) be available?
- EUR/USDT rate at funding time (paper slices assume ~2,300 USDT for 2,000 EUR).

## Probes
- What is the recommended portfolio and its backtest numbers? (⅓ st1d + ⅓ trendlv+timestop + ⅓ donchianls; every year positive 2020–26, CAGR 18.5%, Sharpe 1.04, DD 18.6%, from-2025 Sharpe 0.68.)
- Which popular internet strategies were tested and which survived? (11 in round 9; only Supertrend daily; pairs vs BTC failed in round 10.)
- Why are TP1/TP2 and stepped stops not used? (Given-back profit is −37R vs +364R from big winners; every early-profit exit lowered OOS PF.)
- What is running on the VPS and where are the secrets needed to redeploy? (Three paper engines A/ST/GLS with own DBs and APIs 8081-8083; POSTGRES_PASSWORD and API_TOKEN are in the hPanel project env — ask the user, they are not in the repo.)
- What must be done before testnet/live? (The deferred review items in PROGRESS.md Deployment, then testnet validation with one sub-account per engine.)
- Can parameters still be tuned on 2020–2026 data? (No, frozen; paper is the only valid test.)
