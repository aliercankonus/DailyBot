# Progress

## Goal
Binance USDⓈ-M futures bot (long + short) with a proven out-of-sample edge, running on a Hostinger VPS. Phases and gates: `docs/PLAN.md`.

## Decisions
- 2026-11-17: Rewrite instead of repairing `dailytradingbot` (see `docs/legacy-review.md`).
- 2026-11-17: TypeScript + Postgres + Docker Compose on the VPS; Lovable/Supabase dropped.
- 2026-11-17: Futures, long + short, isolated margin, one-way mode. Max 5x leverage, max 2% risk/trade enforced in config.
- 2026-11-19: Focus on BTC + ETH (user). Portfolio 0.5 A-LV+timestop 4h + 0.25 golden cross 1h + 0.25 tsmom 4h (round 12). Live start capital 2,000 EUR. 2% rule applies to weight legs too (enforced outside paper).
- 2026-11-17: First candidate strategy: 4h trend breakout (Donchian 20, EMA 50/200, ATR 14, stop 2 ATR, trail 3 ATR).
- 2026-11-17: Stop orders: both Binance Algo Order API and legacy `/fapi/v1/order` implemented behind `BINANCE_STOP_API`; which one works must be confirmed on testnet (Binance docs were not reachable from the build environment).

## Done
- Project bootstrapped from agent-patterns (core + recommended extras).
- Core: indicators, strategy, sizing (liquidation-aware), 7 gates, precision helpers.
- Backtester: next-bar-open fills, intrabar stops, fees/slippage/funding, portfolio limits, in/out-of-sample split, ±20% robustness, acceptance check.
- Exchange: Binance futures client (signed REST, idempotent client ids, filters), paper exchange (live data, simulated account, 1m intrabar stops).
- Engine: entry, protect-or-close, trailing stop (place new, then cancel old), reconciliation, kill switch, daily loss / drawdown limits, Telegram.
- Postgres repo + schema, Fastify API (token auth, kill switch), Dockerfile, docker-compose, VPS guide.
- Tests: 52 passing (indicators no-look-ahead, sizing, gates, backtest honesty, engine scenarios on a fake exchange, paper exchange, Postgres, API, config).

- 2026-11-17: Full /e2e-code-review (6 developer units + tester + security + verifier). 1 critical (fixed: .gitignore hid src/data), 9 major and ~40 minor findings, all verified and fixed:
  - engine: pending-entry record + adoption (no unprotected position if the DB insert fails after a fill), stop placed before notifications, trailing failure keeps the old stop, no invented exit price, idempotent kill switch, drawdown re-arm fixed (peak reset on manual OFF), fresh balance per entry, reconcile runs even if balance fails, fixed 1000-candle window shared with the backtest.
  - Binance client: placeStop idempotent, -1021 resync, 429/418 handling, spent client ids, LOT_SIZE vs MARKET_LOT_SIZE, `auto` stop API (algo → legacy fallback), paginated fills; first test file (32 tests).
  - risk: gates fail closed on NaN, sizing validates inputs and counts round-trip costs as risk, precision fixes.
  - backtest: fixed window (fast, live parity), MTM fallback, configured symbol order, MTM equity sizing, settlement-time funding, robustness sweep perturbs multipliers.
  - paper: stop replay bug, flips, reduce-only stops, margin checks, approximate isolated liquidation.
  - deploy/API: per-service secrets, container hardening, CI permissions + build on PRs, heartbeat healthcheck, lock liveness check, bounded shutdown, camelCase API, 401 rate limit, engine-set kill switch needs force + reason.
  - Tests: 140 passing (Postgres included).

- 2026-11-17: Added strategies B (`pullback`, 1h, 4h trend from complete 4h buckets only) and C (`meanrev`, 1h, Bollinger + ADX regime). Strategies may now declare `shouldExit` (target / time stop): backtest fills it at the next open, the engine closes at market. Live `entryCandleOpenTime` is now the fill candle, matching the backtest. Engine selects the strategy with `STRATEGY`; the strategy sets the interval. Tests: 158 passing.

- 2026-11-17: Literature review (see "Research" below). Added D (`funding`, 1h, funding z-score crowding: short extreme positive / long extreme negative), E (`xsmom`, daily cross-sectional momentum on 20 coins, top/bottom 4, weekly, with a time-series gate; portfolio backtester `src/backtest/portfolio.ts`, backtest only, no live support yet) and F (`tsmom`, daily time-series momentum ensemble over 5-360 day lookbacks, long only by default). Backtests now charge real signed funding where history exists. Acceptance adds a per-year consistency rule (every out-of-sample year PF > 1) because many strategies are now tested on the same data. Tests: 186 passing.

## Research (2026-11-17, from abstracts; full texts were not reachable)
- Strongest recent evidence: multi-lookback trend/time-series momentum with volatility sizing on top coins (Zarattini, Pagani & Barbon 2025; Liu & Tsyvinski, RFS 2021). -> strategy F.
- Cross-sectional momentum: weak net of costs, decays after 2022 (Han, Kang & Ryu 2023; Grobys et al. 2025); a time-series gate helps. -> strategy E with gate.
- Funding carry works only delta-neutral (spot leg needed) and collapsed in 2025 (BIS WP 1087; arXiv 2510.14435). Extreme-funding contrarian evidence is weak. -> strategy D is a long shot.
- Next candidates if needed: CTREND-style cross-sectional trend factor (Fieberg et al., JFQA 2025).

- 2026-11-17: Added weight-based portfolio backtester (`src/backtest/weights.ts`: next-open execution, no-trade band, signed funding, MTM), G (`donchian`: 9-lookback Donchian ensemble, trailing midpoint stops, inverse-vol sizing, gross cap), H (`carry`: cross-sectional funding carry, dollar-neutral), benchmarks (`btchold`, `ewhold`). Equity metrics (CAGR, Sharpe, max DD, yearly returns) are printed for every strategy; weight strategies are accepted on OOS Sharpe >= 1.0, max DD <= 20%, every OOS year positive. Robustness sweep skips switches and zero-valued parameters. Daily data and funding now start 2020-01-01. Tests: 199 passing.

- 2026-11-18: Full review of the old bot by four agents (exits, risk/sizing, strategy templates, strategy modules). Key facts: the old bot traded SPOT with notional (not risk) sizing and ~15 stacked size multipliers; none of the 18 strategy templates ever reached a trade (one gate pipeline ran instead, under three names); of 23 exit mechanisms only the entry SL/TP reached the exchange, the rest were database-only, overlapping and partly crashing (undeclared variables); ~20 probe/override entries existed only to undo other gates. Cleaned, testable versions added: S1 failed-breakout reversal (1d), S2 squeeze breakout (4h), S3 capitulation/blow-off reversal (1d), S4 daily trend pullback (`src/strategy/oldIdeas.ts`); exit overlays in R units (break-even, lock tiers, R trailing, time stops; `src/strategy/exitOverlays.ts`, usable as `strategy+preset`); backtest risk modifiers (`--dd-scale`, `--loss-streak`). Not ported (reasons in the review): Kelly sizing, hedging, indicator size multipliers, decay/micro-lock/emergency exits (minute-tick based, below fee level), OI forecaster and AI veto (not backtestable), order-flow proxies (not real order flow). Tests: 217 passing.

## Deployment
- 2026-11-21 OWNER DECISION: A live -> trendlvfc+timestop+befee (round 21 funding crowding filter: no long when the last settled funding > 90th pct of the previous 540 4h candles = 90 days, no short below the 10th; missing data never blocks). CLI backtest with real signed funding, BTC+ETH 4h 2020-2026: A+befee IS PF 1.62 E 0.325R DD 13.6% / OOS 1.47 0.274R 18.0% / CAGR 20.4% Sharpe 1.20 DD 18.0% -> A-FC+befee IS 1.80 0.393R 12.8% / OOS 1.56 0.322R 16.2% / CAGR 23.2% Sharpe 1.37 DD 16.2%; 2025 PF 1.53 -> 1.61, 2026 1.41 -> 1.52; robustness (OOS): pct 0.72 PF 1.93, bars 432 / 648 PF 1.56 / 1.57. Engine: a failed funding fetch now logs FUNDING_UNAVAILABLE and the tick continues (position management never depends on funding). Expectations for A: 460 trades, win 0.43, PF 1.68, avgR 0.37, vol 0.162, DD 0.162.
- 2026-11-21 lock at 3R on top of A+befee (owner), BTC+ETH 4h 2020-2026: A+befee IS PF 1.71 / OOS 1.45, net 19.2k; lock 1R at 3R 1.71/1.45 19.2k (no change); lock 1.5R 1.73/1.45 19.7k; lock 2R 1.70/1.46 18.9k; lock 2.5R 1.57/1.30 14.2k. Already without a lock, the 87 trades that reached 3R never exited below +0.90R (avg 3.86R): at 3R the 3-ATR chandelier already sits ~+1.5R (R = 2 ATR), less when ATR has widened. A lock adds nothing below 2R and hurts at 2.5R. Not adopted.
- 2026-11-21 partial take-profit on top of A+befee (owner: 'take some profit at 1.5R'), BTC+ETH 4h 2020-2026, pass = better in both halves: A+befee IS PF 1.71 E 0.342R / OOS 1.45 0.255R, total net 19.2k; +25% at 1.5R 1.59/1.29, 13.8k; +33% at 1.5R 1.55/1.24, 12.2k; +50% at 1.5R 1.46/1.14, 9.1k; +25% at 2R 1.61/1.30, 14.4k; +25% at 3R 1.66/1.33, 16.0k; +25% at 1.5R & 3R 1.53/1.18, 11.0k. All FAIL; win rate unchanged (befee already turns those trades into small wins); every partial TP removes size from the few big winners that pay for A. No TP.
- 2026-11-22 volatility-regime risk on A live (trendlvfcd+timestop+befee; weights on R, ATR% rank within the last 50 bars): A 131R/PF 2.43/DD 10.8R IS, 36R/1.65/10.9R OOS; bottom 20% x1.3 + top 20% x0.7: 121R/2.26 | 39R/1.73 (2022: 2R vs 7R) FAIL; top 20% x0.7 only: 121R/2.39/9.6R | 34R/1.66 FAIL; bottom 20% x1.3 only: 131R/2.31 | 41R/1.71 FAIL (more R only via more risk, PF down in IS). Other suggestions of that note were already tested: stop 2.4 ATR (round 7 robustness: OOS PF 1.37 -> 1.29), ATR period 11/17 (flat/worse), ATR > 3% already blocks entries, leverage cap 3x already bounds size, chandelier/R-trailing/partial TP (rounds 2-5, 14-16, 2026-11-21).
- 2026-11-22 recent-period scan of the whole catalogue (BTC+ETH, to 2026-11-21; R per strategy, last 30 days / 2025-26 PF / 2020-24 PF): best last 30 days = gcross1h+be2 +12.6R (1.62 / 1.67), squeeze +12.3R (1.01 / 1.07), A live trendlvfcd+timestop+befee +7.9R (1.80 / 2.43), st1d +6.5R (1.60 / 1.67), st4h +4.7R (1.08 / 1.27), turtle +4.1R (1.82 / 4.70, but 65% DD). Losing recently and long-term: meanrev, night, volbo, ma2050, pullback, funding. Reading: the strategies that made money in the last month are mostly ours (GC, A) - the live engines missed it only because they started after the entries (start-up gap, round 19); squeeze's month is luck (no edge in either half). Supertrend daily (st1d) holds up in both halves on BTC/ETH too: candidate for a portfolio test as a 4th leg, not adopted.
- 2026-11-22 weak-break analysis on history (BTC+ETH 4h 2020-01..2026-10, trades the old rule took vs the 0.25-ATR margin): 143 weak breaks (about 1.7 a month for both symbols) won 41%, avg +0.13R, total +18.4R, full stops 19%; decisive breaks (314) won 46%, avg +0.47R, full stops 20%. By break distance: 0-0.1 ATR +0.35R avg (58), 0.1-0.25 ATR -0.02R (85), 0.25-0.5 +0.43R (102), 0.5-1 +0.53R (129), > 1 +0.43R (83). Reading: weak breaks are not more likely to be stopped out; they are lower-value trades, and skipping them lowers variance and drawdown more than it costs. The 0-0.1 bucket being good while 0.1-0.25 is flat says the effect is noisy at the edges; live checking needs months, not 1-2 weeks (about 2 weak breaks a month). Decision detail now logs 'break X ATR' (signed distance beyond the extreme) and the report counts categories (taken, weak break, funding block, atr block, no break, no trend).
- 2026-11-22 OWNER DECISION: A live -> trendlvfcd+timestop+befee (round 24 decisive-break margin 0.25 ATR on top of the funding filter and befee). CLI backtest with real funding, BTC+ETH 4h 2020-01..2026-10: IS 262 trades, win 48.9%, PF 2.13, E 0.480R, DD 11.2%; OOS 111, 40.5%, 1.59, 0.345R, 12.4%; full CAGR 22.7%, Sharpe 1.45, max DD 12.3% (A-FC before: IS PF 1.80 DD 12.8%, OOS 1.56 DD 16.2%, CAGR 23.2%, Sharpe 1.37, DD 16.2%). Weak breaks the margin rejects are logged in the decision detail as 'BLOCKED: weak break (...)' (parallel log the owner asked for). Expectations for A: 373 trades / 2496 days, win 0.46, PF 1.85, avgR 0.44, vol 0.149, DD 0.123. Owner note: re-check 0.30 after a few months of live data.
- 2026-11-22 OWNER DECISION: engine A (testnet) decides on MAINNET candles and funding (MARKET_DATA_BASE_URL=https://fapi.binance.com via A_MARKET_DATA_BASE_URL; keyless public calls only) while orders, stops, positions, balance and fills stay on Binance demo (src/exchange/marketDataSplit.ts). Reason: the demo printed a BTC wick to 50000 (mainnet low 55127) that distorted A's 20-bar low and ATR; the demo rehearsal should decide like live. Stops still trigger on the demo mark price; a stop already through it falls back to protectOrClose. Security review: no defects (no key reaches the market-data host; freshness, lastProcessed and backstop stay consistent). No strategy change.
- 2026-11-21 OWNER: break-even must also cover fees -> A live strategy is trendlv+timestop+befee (new preset: stop to entry + 0.3% at MFE 1R). Buffer test (BTC+ETH 4h 2020-2026): 0.2% IS PF 1.73 / OOS 1.44, 88 break-even exits avg +2.34 USDT, 27 still slightly negative (funding, slippage); 0.3% IS 1.71 / OOS 1.45, 90 exits avg +5.29, 6 negative (gaps); 0.4% 1.72 / 1.40, 5 negative. Full backtest befee: IS 347 trades win 45.2% PF 1.65 E 0.342R DD 13.4%; OOS 152 / 38.8% / 1.42 / 0.255R / 18.3%; full CAGR 20.9%, Sharpe 1.23, DD 18.3%. Expectations for A: 499 trades, win 0.43, PF 1.54, avgR 0.32, vol 0.166, DD 0.183. Trades that never reach +1R (about 83% of losers) still lose up to 1R.
- 2026-11-21 OWNER DECISION: A live strategy trendlv+timestop -> trendlv+timestop+be (stop to entry + 0.2% once MFE >= 1R; exits otherwise unchanged). Backtest exactly as live (BTC+ETH 4h, 2020-01..2026-11-20, data.binance.vision, taker+slippage 0.05%/side, 1% risk): IS (to 2025) A 340 trades win 35.0% PF 1.60 E 0.349R DD 14.8% -> A+be 345 / 41.5% / 1.66 / 0.352R / 13.5%; OOS (2025-26) A 150 / 29.3% / 1.37 / 0.239R / 19.2% -> A+be 152 / 32.9% / 1.41 / 0.251R / 18.4%; full period CAGR 20.3% -> 21.2%, Sharpe 1.18 -> 1.24, max DD 19.2% -> 18.4%; every year within noise (2023 -2.6%, others up). Robustness (OOS, each parameter +-20%): PF 1.04-1.58, same shape as A (trailAtr 2.4 is the weak point in both). Better in both halves, so it also passes the pre-registered rule. (The earlier 'neutral' result was trendlv+be WITHOUT the time stop.) A had 3 demo trades, so the demo record is barely affected. Paper expectations for A updated: 497 trades, win 0.39, PF 1.55, avgR 0.32, vol 0.166, DD 0.184.
- 2026-11-21 root cause of the ETH loss, second look: the 3-ATR chandelier uses the CURRENT ATR, which grew during the drop itself (ETH ATR ~2.8% at the low), so the stop could only reach low 1547 + 3 x ATR = ~1686, above entry, at the trade's best point (MFE 1.8R). Tested a trail on the ATR frozen at entry (stop = extreme + k x R/2, tighter of the two), pre-registered 'better in both halves': k=3 IS PF 1.37 / OOS 1.10 (A 1.43 / 1.37), k=2.4 1.22 / 0.87, k=3.6 1.40 / 1.11; winners >= 5R drop 15 -> 9 / 3 / 10. FAIL: the widening ATR is what keeps A in the big trends. Exits tested for this loss: be2 (no help), be at 1R (neutral, candidate for the 30-trade post-mortem), TP ladders (worse), frozen-ATR trail (worse).
- 2026-11-21 TP / break-even for A (owner: 'with a TP the worst case should be 0'): BTC+ETH 2021-2026, 421 trades, 68% losers; 240 of 288 losers (83%) never reached +1R before the stop (154 < 0.5R, 86 at 0.5-1R, 48 at 1-2R, 0 >= 2R), so no TP/break-even can make the worst case 0. Winners +293R, losers -202R; 15 winners >= 5R give 118R. Variants (IS PF / OOS PF / full Sharpe / CAGR): A+timestop 1.39/1.37/0.85/13.1%; +be (stop to entry+0.2% at 1R) 1.36/1.41/0.82/12.6%, win 42%/36% (about neutral: OOS better, IS and 2021 worse); +tp1 (half at 1R + BE) 1.01/0.87/-0.10/-1.6%; +tp2 (half at 2R + BE) 1.19/1.05/0.43/4.7%; +step 1.20/1.15/0.51/6.3%. Only 'be' does not hurt; candidate for A's 30-trade post-mortem, not adopted now.
- 2026-11-21 ETH loss review (A demo): ETH short @1652.16 (20.11 16:00 signal, matches mainnet) ran to a low of 1547 (MFE ~1.8R: 105 points vs a 58.8-point initial stop), then ETH bounced ~9% and the exchange stop at 1686.1 (3-ATR chandelier: low 1547 + 3 x ATR, never loosened) filled between 12:00 and 16:00 on 21.11: about -21 USDT (-0.6R). Classification: normal strategy loss / structural giveback, no bug (stop on the exchange, filled as designed, POSITION_CLOSED event, no errors). be2 would NOT have saved it (MFE 1.8R < 2R; corrected 21.11); be at 1R would have. be2 re-tested for A on BTC+ETH 2021-2026: A+timestop IS PF 1.39 / OOS PF 1.37, Sharpe 0.85, DD 19.2%; A+be2 IS PF 1.34 / OOS PF 1.34, Sharpe 0.76, DD 20.5% -> worse; not adopted (consistent with round 6: giveback is a small cost next to the big winners). A after 3 trades: +38.6 USDT (+0.77%), win 33%, PF 2.73, avg R 0.28 (backtest 0.31).
- 2026-11-21 daily review: A (demo) equity 5078.53 (+1.57%), 2 closed trades (win 50%, avg R 0.65), max DD 1.1%. 20.11 16:00 signals (mainnet 12:00 candle: BTC close 59445 < 20-bar low, ETH 1654.33 < low) -> demo shorts BTC @59506.1 / ETH @1652.16, matching mainnet. BTC closed 21.11 04:00 by TRAIL_THROUGH_PRICE, about +1.3R: the DEMO printed a BTC wick to 50000 (mainnet low on 20.11 was 57700), the 3-ATR chandelier jumped below price and the engine closed at market (designed behaviour; the backtest would do the same on that candle). Demo order responses carry NO avgPrice field (raw log 04:00: fields list without avgPrice) -> the fill-price fallback resolved it (no FILL_PRICE_MISSING) - settles the 'mapping or demo' question: demo. ETH short open, stop trailed 1710.99 -> 1686.1. First trade (20.11 00:00) without the bug, mainnet replay: +1.36R open at the end of 20.11 (MFE 1.91R, stop trailed to 61504), i.e. the bug cost about 1.4R on that signal. One demo klines 408 timeout (07:53), handled by retry. GC/TS: no signal (no cross; TS long-only, momentum -1).
- 2026-11-20 market review (BTC/ETH, 18.11 12:00 -> 20.11 00:00 UTC, mainnet archive replay of all three strategies): every live decision matches the replay (A's 20.11 00:00 BTC short signal identical: close 61959.3, stop 64189.6; ETH no breakout; TS momentum -1.0 = no long; GC no cross). Missed profit is a START-UP GAP, not a calculation error: BTC -19% / ETH -21% since 5-6.11; the backtest holds GC shorts from 5.11/6.11 (+6.4R / +6.8R open) and an A BTC short from 12.11 (+4.9R open), but the live engines started (GC 19.11, A on demo 19.11) after those entry bars and GC/A only enter on the cross/breakout bar. TS is long-only, so it sat out the fall (TS short variant is already on the later-test list). Idea for later (needs a pre-registered backtest, not during the paper freeze): 'join an existing signal at start-up' vs waiting for the next fresh signal.
- 2026-11-20 daily review: A (Binance demo) first trade = BTCUSDT short, entry 61975, exit 61989.2 after 47 s, net -1.53 USDT (-0.03R). Cause: BUG, not the strategy (demo returned avgPrice 0 -> stop computed at 1955 -> rejected -2021 -> protectOrClose closed at market). Fixed (7191c7a + review fixes, deployed 07:09) and the row was repaired from the exchange fills (08:17). The strategy's own outcome for this signal (stop ~3.2% above entry) is not known yet; compute it from the 2026-11-20 data.binance.vision archive tomorrow (fapi.binance.com is geo-blocked from the session). Liquidation collector fixed (07:24, /market websocket route). GC/TS: no trades, no errors.
- 2026-11-18 23:41 UTC: phase-2 code deployed (dc6060e): registry, per-engine base URLs, partial-fill retry, report service; all containers healthy, first report A -0.09% (2 shorts open), ST/GLS flat. Deploy content limit 8192 chars.
- 2026-11-18 23:12 UTC: paper portfolio live on the VPS (image 1b510ff, after /e2e-code-review: REQUEST_CHANGES → fixes in 62cc9c7 and 1b510ff, re-verified). Three engines, each with its own database and a 10,000 USDT paper account: `engine` (A-LV + time stop, 4h, 5 coins, db trader), `engine-st` (Supertrend(10,3) daily, 20 coins, db trader_st), `engine-gls` (G-LS weights, daily rebalance after 00:00 UTC, db trader_gls). APIs on 127.0.0.1:8081 / 8082 / 8083. Kill-switch drawdowns 35% / 25% / 40%. All containers healthy; migrate created trader_st and trader_gls. Before testnet/live: (done in 134ec90/bf8b0be) one Binance (sub-)account per engine enforced via the engine_accounts key-fingerprint registry (testnet/live refuses to start without it), per-engine base URL, partial fills retried. OPEN DECISION for the user: how the 2% per-trade risk rule applies to G-LS legs (today: portfolio volatility target 25%/yr, gross <= 2x equity, 4 ATR catastrophic stop per leg; a per-leg cap would change the tested strategy and needs a new backtest).
- 2026-11-17: Hostinger VPS (KVM 2, Düsseldorf) Docker project `dailybot`, MODE=paper. db/api/engine healthy, migrate exit 0, engine ticking every 60s (~1.5s per tick). API on 127.0.0.1:8081. Secrets live in the project environment in hPanel.

## Next
0. Decide: build engine support for weight strategies (daily rebalance orders + exchange-side catastrophic stops) and forward-test G-LS (and G) in paper mode at a 15% vol target. This is the only out-of-sample test left that is not contaminated by research.
1. Old-bot ideas: done (three rounds, all fail; see Backtest results).
3. Testnet run: confirm `BINANCE_STOP_API`, full order lifecycle.
4. Dashboard (React) reading the API.
5. Not yet done: Docker image build was not tested in the build environment (no Docker daemon); first `docker compose up --build` on the VPS is the check.

## Backtest results

### 2026-11-17 — trend-breakout(20, 50/200, atr14 x2/3), 4h, BTC/ETH/SOL/BNB/XRP, data 2021-01 → 2026-11
Run on the VPS by the `research` service (image d7f6871). Costs: taker 0.05%/side, slippage 0.05%/fill, funding 0.01%/8h, risk 1%/trade.

| | trades | win rate | PF | expectancy | net return | max DD |
|---|---|---|---|---|---|---|
| In-sample (< 2025) | 636 | 35.5% | 1.25 | 0.14R | +94.8% | 22.7% |
| Out-of-sample (≥ 2025) | 320 | 30.6% | 1.09 | 0.11R | +18.7% | 35.3% |

OOS per symbol: ETH +0.31R, SOL +0.24R, BTC +0.01R, BNB 0.00R, XRP −0.08R. 2026 YTD is negative (−1690 USDT).
Robustness (±20% per parameter): PF 0.98–1.15, no parameter value reaches the gate; trailAtr 2.4 drops to PF 0.98.

**Phase 1 gate: FAIL** (PF 1.09 < 1.3, expectancy 0.11R < 0.3R, DD 35% > 20%). The edge is small and not robust enough for real money. Do not go live with this strategy. The paper engine keeps running to validate the infrastructure, not the strategy.

### 2026-11-17 — B and C, 1h, same 5 coins, same costs (image af06212)

| | IS trades | IS PF | OOS trades | OOS PF | OOS expectancy | OOS max DD | Years profitable |
|---|---|---|---|---|---|---|---|
| B pullback(4h ema20/50, rsi14@35, 1.5 ATR, 2R) | 1046 | 0.88 | 469 | 0.71 | −0.24R | 62% | 0 of 6 |
| C mean-reversion(bb20x2, adx<20, 1.5 ATR, 24 bars) | 2325 | 0.61 | 1127 | 0.65 | −0.21R | 82% | 0 of 6 |

Robustness: no ±20% variant of either reaches PF 1.0. **Both FAIL clearly.** Costs dominate on 1h: C paid 4403 USDT in fees on 1127 OOS trades. Conclusion: intraday indicator strategies on these coins have no edge after costs; focus on daily-horizon strategies (D/E/F).

### 2026-11-17 — A (re-run with real funding), D, E, F (image 5518637, historical signed funding for all)

| | Universe / risk | IS trades | IS PF | OOS trades | OOS PF | OOS exp. | OOS max DD | OOS 2025 PF | OOS 2026 PF |
|---|---|---|---|---|---|---|---|---|---|
| A trend-breakout 4h | 5 coins, 1%, max 3 | 636 | 1.25 | 320 | 1.12 | 0.12R | 34.8% | 1.33 | 0.95 |
| D funding crowding 1h | 5 coins, 1%, max 3 | 926 | 0.90 | 418 | 0.60 | −0.23R | 58.8% | 0.65 | 0.52 |
| E xs-momentum 1d (top/bottom 4, weekly, TS gate) | 20 coins, 0.5%, max 8 | 644 | 1.33 | 315 | 0.91 | −0.02R | 6.3% | 0.90 | 0.91 |
| F ts-momentum ensemble 1d (long only) | 20 coins, 0.5%, max 10 | 144 | 2.17 | 72 | 0.55 | −0.18R | 11.6% | 0.74 | 0.25 |

Notes:
- F with shorts allowed (robustness row): OOS 157 trades, PF 0.99, DD 8.5%. Long-only trend is hurt by the 2025-26 bear/chop regime, consistent with live trend ETFs (BTOP −15.9% in 2025).
- E has low drawdown but no OOS edge; its IS edge (PF 1.33) disappeared after 2024, consistent with the literature on decaying cross-sectional momentum.
- D loses in 4 of 6 years. Extreme-funding contrarian has no edge after costs here.
- Robustness sweep flaw found: zero-valued params (exitScore) and switches (tsGate) are not perturbed meaningfully; fix before the next run.

**All six candidates (A-F) FAIL.** No strategy is approved for real money.

### 2026-11-17 — G, H, E, F and benchmarks, daily, 20 coins, data from 2020 (image 7c365bd)

Calendar-year returns (full-period run; G and E/F size risk conservatively, so compare Sharpe and sign, not raw %):

| | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 YTD | CAGR | Sharpe | Max DD | OOS (2025+) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| G Donchian ensemble (long only) | +2.2% | +0.6% | −0.4% | +4.6% | +15.2% | +0.4% | −1.5% | 2.9% | 0.85 | 4.3% | Sharpe −0.34 FAIL |
| H funding carry (dollar-neutral) | −8.7% | +171% | −9.9% | −14.8% | +2.9% | +23.0% | +22.1% | 17.0% | 0.76 | 38.2% | Sharpe 0.60 FAIL |
| E xs-momentum | +6.1% | +11.1% | −3.5% | +3.8% | +20.2% | −2.0% | −2.1% | 4.6% | 0.64 | 11.0% | PF 0.91 FAIL |
| F ts-momentum (long only) | +0.3% | +10.6% | −3.4% | +10.2% | +17.8% | −1.1% | −4.4% | 4.1% | 0.36 | 28.8% | PF 0.55 FAIL |
| BM1 BTC buy & hold | +241% | +17% | −66% | +138% | +97% | −11% | −29% | 22.5% | 0.64 | 79.4% | — |
| BM2 equal-weight 20 coins | +146% | +501% | −67% | +112% | +72% | −37% | −26% | 36.0% | 0.80 | 76.3% | — |

Findings:
- No strategy is profitable in every year; none passes the out-of-sample gate.
- G has the best full-period Sharpe (0.85) with tiny drawdowns, and the typical trend profile: small losses in 2022/2025/2026 while benchmarks lost 11-67%. Its sizing under-shoots the 25% vol target (realised vol 3.7%) because of the 1/N risk budget; returns scale with exposure, Sharpe does not.
- H is fragile: 2021 (+171%) carries the whole result, 2022-23 lose, and the 2025 result differs between runs that start on different days (+5.4% vs +23.0%) — path/rebalance-day dependent.
- E and F: same profile as G but weaker.

### 2026-11-18 — G with portfolio-level volatility targeting (25%), long-only vs long/short (image fa89bce)

| | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 YTD | CAGR | Sharpe | Max DD | OOS 2025+ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| G long only | +104% | +113% | −17.0% | +120% | +64.6% | +7.8% | −11.5% | 44.2% | 1.27 | 44.3% | Sharpe 0.06, DD 44% FAIL |
| G-LS long/short | +70.3% | +29.0% | +23.3% | +10.7% | +44.4% | −17.8% | +33.4% | 25.4% | 0.92 | 32.6% | Sharpe 0.31, DD 25.5% FAIL |
| BTC buy & hold | +241% | +17% | −66% | +138% | +97% | −11% | −28% | 22.5% | 0.64 | 79.4% | — |
| Equal-weight 20 | +146% | +501% | −67% | +112% | +72% | −37% | −25% | 36.3% | 0.80 | 76.3% | — |

Findings:
- Best results of the whole research. G long-only: highest full-period Sharpe (1.27); G-LS: positive in 6 of 7 years including 2022 (+23%) and 2026 (+33%) when the market fell 25-66%.
- Neither passes the strict out-of-sample gate (2025-26 is a hard regime for trend: G lost −11.5% in 2026, G-LS −17.8% in 2025).
- Robustness: ±20% on volTarget/volLookback/maxGross changes OOS Sharpe by at most ~0.2; no cliff.
- Drawdown scales roughly with the volatility target: at a 15% target, G-LS max DD would be ~20%.
- About ten candidates have now been tested on the same data; treat the best in-sample numbers with suspicion. The only clean test left is forward (paper) trading.

### 2026-11-18 — Old-bot ideas, three rounds (image 11c9014, same costs and funding, split 2025-01-01)

Round 1: cleaned old strategies (S1/S3/S4 daily on 20 coins from 2020, S2 4h on 5 coins from 2021)

| | IS PF | OOS trades | OOS PF | OOS DD | Full CAGR | Full Sharpe | Losing years |
|---|---|---|---|---|---|---|---|
| S1 failed breakout | 0.74 | 639 | 0.90 | 25.3% | −14.2% | −0.78 | 6 of 7 |
| S2 squeeze breakout | 0.90 | 402 | 1.03 | 32.9% | −5.2% | −0.07 | 4 of 6 |
| S3 capitulation | 0.27 | 78 | 1.29 | 4.3% | −5.4% | −1.47 | 5 of 7 |
| S4 daily pullback | 0.77 | 259 | 0.94 | — | −3.6% | −0.44 | 5 of 7 |

Round 2: old exit mechanisms as overlays on A (4h breakout, 5 coins)

| | IS PF | OOS PF | OOS E | OOS DD | Full Sharpe | 2026 |
|---|---|---|---|---|---|---|
| A baseline | 1.25 | 1.12 | — | 34.8% | ~0.74 | — |
| A+be (stop to entry+0.2% after 1R) | 1.30 | 1.11 | 0.10R | 33.9% | 0.74 | −6.2% |
| A+lock (tiered profit lock) | 1.34 | 1.04 | 0.05R | 36.9% | 0.77 | −17.2% |
| A+trail (R trailing from 1.2R) | 1.17 | 1.04 | 0.05R | 37.9% | 0.56 | −15.2% |
| A+timestop (cut non-moving losers) | 1.21 | 1.14 | 0.12R | 34.0% | 0.67 | −2.4% |

Round 3: old risk modifiers (`--dd-scale --loss-streak`)

| | IS PF | OOS PF | OOS DD | Full CAGR | Full Sharpe | Full DD |
|---|---|---|---|---|---|---|
| A + risk modifiers | 1.21 | 1.01 | 19.1% | 5.8% | 0.47 | 17.8% |
| A+timestop + risk modifiers | 1.16 | 1.03 | 18.4% | 4.4% | 0.40 | 17.2% |

Findings:
- All fail. The old strategies have no edge after costs (S1-S4 negative over the full period; S3's OOS PF 1.29 rests on 78 trades after an IS PF of 0.27).
- Exit overlays move results by a few hundredths of PF; profit locks and R trailing raise IS PF and lower OOS PF (overfit signature: they cut the large winners a trend system lives on). Only the time stop is neutral-to-slightly positive.
- Risk modifiers halve drawdown but cut return by more (Sharpe 0.74 → 0.47): trend losses cluster just before the big winners, so de-risking after losses misses them. Lower fixed risk gives the same drawdown at a better Sharpe.
- Conclusion: the old bot's problems were execution and complexity, not missing filters; none of its ideas adds an edge. Best candidates remain G / G-LS (forward test).

### 2026-11-18 — Round 4: partial take-profits (TP1/TP2) on A (image a74c71e)

Break-even after TP1 in all; a candle touching stop and TP is a stop-out; TP fills at level minus slippage.

| | Levels (R: fraction of original size) | IS trades | IS win | IS PF | OOS win | OOS PF | OOS E | OOS DD | Full CAGR | Full Sharpe |
|---|---|---|---|---|---|---|---|---|---|---|
| A baseline | none (trailing only) | — | — | 1.25 | — | 1.12 | — | 34.8% | — | ~0.74 |
| A+tpold (old bot exact) | 0.66:50%, 1.32:30%, 2:20% | 1185 | 64.4% | 0.82 | 58.5% | 0.65 | −0.15R | 61.0% | −23.6% | −1.66 |
| A+tp1 | 1:50% | 744 | 50.0% | 1.03 | 44.9% | 0.83 | −0.07R | 36.8% | −3.7% | −0.12 |
| A+tp12 | 1:33%, 2:33% | 744 | 50.0% | 0.97 | 44.9% | 0.75 | −0.12R | 42.8% | −9.2% | −0.47 |
| A+tp23 | 1.5:40%, 3:30% | 673 | 39.7% | 1.10 | 33.3% | 0.89 | −0.05R | 42.4% | +1.2% | 0.16 |

Findings:
- Every ladder makes A worse, and the earlier the TP the worse: the old bot's ladder turns a profitable system into −24%/year with a 64% win rate (avg win 0.45R vs avg loss 0.97R). This is the "high win rate" trap: winners are capped at 2R while losers stay 1R, and a trend system lives on a few large winners.
- Trade count nearly doubles with tpold (1185 vs 649 for A+be): break-even stops after TP1 end trades early and the strategy re-enters, paying fees again.
- Caveat: break-even in the TP1 candle is assumed stopped (pessimistic). Checked in round 5 below.

### 2026-11-18 — Round 5: stepped stop toward a 2R target, and TP ladders without break-even (image 2e7a586)

| | Rule | IS PF | OOS win | OOS PF | OOS E | OOS DD | 2025 PF | 2026 PF | Full CAGR | Full Sharpe |
|---|---|---|---|---|---|---|---|---|---|---|
| A baseline | trailing 3 ATR only | 1.25 | — | 1.12 | — | 34.8% | — | — | — | ~0.74 |
| A+step | BE at 1R (50% of 2R), +0.5R at 1.5R, +1R at 2R, then 1R behind the peak | 1.16 | 41.9% | 0.97 | 0.00R | 35.0% | 1.19 | 0.73 | 7.5% | 0.43 |
| A+steptight | same, 0.75R behind the peak | 1.08 | 41.6% | 0.97 | 0.00R | 38.2% | 1.18 | 0.72 | 3.5% | 0.27 |
| A+tpoldnb | old ladder, no break-even | 1.16 | 52.2% | 0.96 | −0.01R | 29.0% | 1.12 | 0.77 | 6.4% | 0.47 |
| A+tp1nb | 1R:50%, no break-even | 1.17 | 41.7% | 0.95 | −0.01R | 33.2% | 1.19 | 0.72 | 6.1% | 0.41 |

Findings:
- The pessimistic break-even rule explained most of tpold's collapse (Sharpe −1.66 → 0.47 without break-even), but even the most favourable ladder is clearly worse than A without TPs (OOS PF 0.96 vs 1.12, Sharpe 0.47 vs 0.74). Conclusion holds: no partial TP for A.
- Stepped stops (the user's "move the stop as price approaches the target") also lower OOS PF to 0.97 and Sharpe to 0.43/0.27; the tighter, the worse. The 3-ATR trailing stop already follows price; a tighter R-based step adds stop-outs on normal pullbacks inside trends.
- Across rounds 2, 4 and 5, every exit that takes profit earlier than the 3-ATR trail hurts A; only the loser time stop is neutral-to-positive.

### 2026-11-18 — Round 6: same-side cap (max 2) + re-entry cooldown (3 candles after a stop)

| | IS PF | IS DD | OOS trades | OOS PF | OOS E | OOS DD | 2025 PF | 2026 PF | Full CAGR | Full Sharpe | Full DD |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A baseline | 1.25 | — | — | 1.12 | — | 34.8% | — | — | — | ~0.74 | — |
| A + cap + cooldown | 1.23 | 21.6% | 262 | 1.04 | 0.06R | 28.6% | 1.31 | 0.82 | 9.6% | 0.54 | 27.5% |
| A+timestop + cap + cooldown | 1.18 | 18.5% | 273 | 1.09 | 0.08R | 27.6% | 1.35 | 0.87 | 9.1% | 0.52 | 26.4% |

Findings: the portfolio rules cut drawdown by ~7 points (fewer correlated positions), but return falls more than risk, so Sharpe drops. They are a risk-budget choice, not an edge. 2026 remains the losing year in every variant; the next step is to find out why (loss attribution, `--analyze`).

### 2026-11-18 — Round 7: loss attribution of A (`--analyze`, 957 trades 2021-2026, 321 OOS)

Where the result comes from (all data, sum of R):
- Winners: 66 trades of 3R+ (7% of trades) = +364R; 94 trades of 1-3R = +168R; 168 small winners = +74R.
- Losers: never more than 0.25R in profit (bad entry/false breakout) 201 trades = −208R; 0.25-1R then stopped 308 = −235R; 1R+ then given back 120 = −37R.
- By time held: 1-6 candles 247 trades = −197R (false breakouts); 19+ candles 312 trades = +395R.
- Longest losing streak: 23 trades (OOS). At 1% risk that is a ~20% drawdown by itself.

Causes and what follows from them:
1. Giving back profit is a small cost (−37R). That is why break-even, lock, trail, stepped stops and TP ladders cannot help: they cut the +364R from big winners to save a fraction of −37R.
2. Most losses are false breakouts that never work (−443R in two groups). They are the price of catching the 7% big trends; only filters that remove false breakouts without removing big trends can help. The loser time stop (closes non-movers early) is the one exit that targets this group and is the one that helped.
3. Volatility at entry: ATR/price <1% PF 2.3, 1-2% 1.20, 2-3% 1.04, >=3% 0.88 (all data); OOS >=3% PF 0.10 (21 trades); in-sample >=3% avgR +0.06 vs 0.98 for <1%. Same direction in both periods → testable filter (`trendlv`, maxAtrPct 3%).
4. ADX at signal >=30: OOS PF 0.63/0.29, but in-sample ADX>=30 trades were as good as ADX<30 (avgR ~0.16 vs ~0.13). An ADX cap would be fitted to the OOS period — not adopted.
5. Shorts are weaker than longs (PF 1.07 vs 1.29) but positive in both periods and they carry 2022 and 2026; shorts while BTC is above its EMA200 lose (PF 0.68, 45 trades) — small sample, noted only.
6. 2026: longs win 18% (PF 0.77), shorts PF 1.13. A choppy, falling year for breakouts; worst months 2026-05, 2026-10, 2026-07.

How to reduce losses (in order of evidence): (a) lower risk per trade (DD scales with risk: 0.5% ≈ half the drawdown, the 23-loss streak ≈ −11%); (b) the loser time stop; (c) volatility filter (round 8); (d) combine with an uncorrelated return stream (G-LS) instead of adding more filters to A.

### 2026-11-18 — Round 8: volatility filter, and portfolios (image 13e0043)

Single strategies (4h, 5 coins, 1% risk):

| | IS PF | OOS trades | OOS PF | OOS E | OOS DD | 2025 PF | 2026 PF | Full CAGR | Full Sharpe | Full DD | OOS PF range ±20% |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 1.25 | 321 | 1.13 | 0.12R | 34.8% | 1.33 | 0.95 | 16.3% | 0.70 | 34.6% | 1.00-1.18 |
| A-LV (ATR < 3%) | 1.24 | 306 | 1.20 | 0.17R | 34.4% | 1.52 | 0.97 | 16.4% | 0.73 | 34.3% | 1.06-1.27 |
| A-LV + time stop | 1.22 | 321 | 1.20 | 0.16R | 32.9% | 1.46 | 1.00 | 15.8% | 0.72 | 31.8% | 1.06-1.27 |

Portfolios (50/50 of capital, daily rebalanced; each leg with its own default risk; A legs start 2021, so 2020 is half G-LS and half cash):

| | Corr. | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 | CAGR | Vol | Sharpe | Max DD | From 2025: Sharpe / DD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A + G-LS | 0.40 | +32.2% | +17.7% | +14.7% | +28.5% | +33.6% | +5.2% | +14.1% | 20.8% | 22.2% | 0.96 | 22.1% | 0.51 / 22.1% |
| **A-LV+timestop + G-LS** | 0.35 | +32.2% | +17.0% | +21.7% | +20.5% | +25.8% | +9.2% | +16.6% | 20.6% | 21.2% | **0.99** | **20.7%** | 0.66 / 20.7% |
| A-LV+timestop + G | 0.29 | +45.0% | +51.2% | +0.3% | +70.9% | +34.5% | +25.1% | −4.9% | 29.8% | 22.4% | 1.28 | 31.2% | 0.47 / 31.2% |
| (G-LS alone) | | +70.3% | +29.0% | +23.3% | +10.7% | +44.4% | −17.8% | +33.4% | 25.4% | 29.3% | 0.92 | 32.6% | 0.31 / 26.8% |

Findings:
- The volatility filter is the first change to A that improves the out-of-sample result (PF 1.13 → 1.20) while staying robust (every ±20% neighbour ≥ 1.06, maxAtrPct 2.4% / 3.6% both fine) and leaving in-sample unchanged. Adopted.
- A-LV + time stop + G-LS (50/50) is the best result of the project: positive in every calendar year 2020-2026, max drawdown 20.7%, Sharpe 0.99. The two legs lose in different years (A in 2026, G-LS in 2025), correlation 0.35. It still misses the strict out-of-sample gate (Sharpe 0.66 < 1.0 from 2025), and the volatility filter and time stop were chosen after seeing 2025-26 data, so the true forward result will be worse than this backtest.
- About 35 variants have now been tested on the same 2020-2026 data. Decision: freeze the parameters here and treat paper trading from now on as the only valid test.

### 2026-11-18 — Round 9: the most recommended public strategies at their published settings (image 31557d8, `--brief`)

The user asked for a wide search of indicator and other methods (videos, blogs, papers). Sources: independent default-setting tests (edgoro.com, dev.to 49-strategy and tessen.ai 13-strategy reviews), LazyBear squeeze (TradingView), Padysak & Vojtko 2022 (SSRN 4081000) and Quantpedia follow-ups (10-day max/min, 21-23 UTC seasonality), Larry Williams volatility breakout, Turtle rules, Connors RSI(2). No parameter was tuned; daily strategies run on 20 coins at 0.5% risk, 4h/1h on 5 coins at 1%.

| | Strategy | IS n / PF | OOS n / PF | OOS DD | 2025 / 2026 PF | Full CAGR | Sharpe | DD | Yearly |
|---|---|---|---|---|---|---|---|---|---|
| P1-1d | **Supertrend(10,3) daily** | 460 / 1.87 | 187 / 1.22 | 9.4% | 0.82 / 1.69 | 13.3% | 0.82 | 19.7% | +2.9 +46.7 −1.2 +33.9 +4.2 +3.1 +10.0 |
| P1-4h | Supertrend(10,3) 4h | 654 / 1.22 | 333 / 1.06 | 28.2% | 1.25 / 0.91 | 10.9% | 0.59 | 27.8% | +23.4 −2.3 +11.8 +27.2 +13.5 −5.8 |
| P2 | MACD + EMA200 4h | 588 / 0.96 | 293 / 1.23 | 21.4% | 1.21 / 1.24 | 3.3% | 0.27 | 30.5% | IS loses |
| P3 | LazyBear squeeze 4h | 1139 / 0.90 | 519 / 1.06 | 24.0% | 1.07 / 1.05 | −3.9% | −0.09 | 46.4% | IS loses |
| P4 | Ichimoku daily | 449 / 1.60 | 227 / 1.00 | 11.5% | 0.53 / 1.70 | 5.9% | 0.51 | 18.3% | 2025 −8.0 |
| P5 | 10-day max/min (Padysak-Vojtko) | 6963 / 0.96 | 2818 / 0.84 | 23.7% | 0.82 / 0.87 | −4.8% | −0.42 | 46.7% | costs eat it |
| P6 | Volatility breakout k=0.5 (1h) | 3848 / 0.92 | 1795 / 0.86 | 68.9% | 0.83 / 0.93 | −31.5% | −0.79 | 92.2% | fails |
| P7 | 21-23 UTC seasonality (1h) | 4419 / 0.61 | 2076 / 0.52 | 76.2% | 0.56 / 0.44 | −49.0% | −3.99 | 98.2% | fails |
| P8 | Turtle system 2 daily | 349 / 1.98 | 158 / 1.02 | 14.6% | 0.91 / 1.10 | 24.0% | 0.74 | 65.0% | 2021 +207%, then flat |
| P9 | Golden cross daily | 94 / 1.59 | 33 / 1.81 | 7.8% | 1.69 / 2.29 | 1.5% | 0.17 | 34.0% | too few trades |
| P10 | Connors RSI(2) daily | 1201 / 0.76 | 548 / 0.79 | 11.9% | 0.93 / 0.64 | −5.0% | −0.66 | 33.5% | 60% win, loses |
| ref | A-LV + time stop | 537 / 1.22 | 321 / 1.20 | 32.9% | 1.46 / 1.00 | 15.8% | 0.72 | 31.8% | |

Findings:
- Supertrend(10,3) on the daily chart over 20 coins is the one new candidate: profitable in both periods, 6 of 7 years positive (2022 −1.2%), max DD 19.7% at 0.5% risk. Next: robustness and portfolios (round 10).
- Short-horizon ideas (10-day max/min, volatility breakout, hour-of-day seasonality) have real gross effects in the papers but do not survive 0.1% per side costs on futures; Connors RSI(2) wins 60% of trades and still loses (the same high-win-rate trap as the old TP ladder).
- MACD and squeeze look fine after 2025 but lose before it: no stable edge.

### 2026-11-18 — Round 10: Supertrend robustness, relative value vs BTC, portfolios (image 5143e09)

Supertrend(10,3) daily, 20 coins, 0.5% risk: OOS PF across ±20% of period and multiplier 1.16 / 1.30 / 1.16 / 1.30 (no cliff). 2025 trades PF 0.82 but the 2025 equity year is +3.1%.

Relative value vs BTC (dollar-neutral, standard settings) — all fail:
| | Full CAGR | Sharpe | Max DD | Notes |
|---|---|---|---|---|
| ETH/BTC z-score reversion (20, 2) | −26.1% | −0.65 | 89.8% | ETH/BTC trended for years; reversion keeps fighting it |
| 19 alts/BTC reversion | −23.1% | −0.88 | 86.5% | same |
| 19 alts/BTC ratio trend (50d) | 11.8% | 0.51 | 44.4% | 2021 +161%, then mostly losing; OOS Sharpe −0.48 |

Portfolios (daily rebalanced; each leg with its own default risk):
| | Correlations | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 | CAGR | Sharpe | Max DD | From 2025 Sharpe / DD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Supertrend-1d + G-LS (50/50) | 0.60 | +33.5% | +38.5% | +11.2% | +22.5% | +23.5% | −7.4% | +21.9% | 20.0% | 0.98 | 22.9% | 0.43 / 15.7% |
| Supertrend-1d + A-LV+timestop (50/50) | 0.32 | +1.7% | +24.9% | +8.4% | +32.1% | +6.3% | +21.8% | +5.5% | 14.1% | 0.90 | 20.3% | **0.79** / 20.3% |
| **Supertrend-1d + A-LV+timestop + G-LS (⅓ each)** | 0.32 / 0.60 / 0.35 | +21.7% | +27.1% | +13.7% | +25.3% | +18.4% | +7.4% | +14.8% | 18.5% | **1.04** | **18.6%** | 0.68 / 16.8% |
| (previous best: A-LV+timestop + G-LS) | 0.35 | +32.2% | +17.0% | +21.7% | +20.5% | +25.8% | +9.2% | +16.6% | 20.6% | 0.99 | 20.7% | 0.66 / 20.7% |

Findings:
- The three-way portfolio is the best result of the project: positive every year 2020-2026, Sharpe 1.04 (first above 1.0), max drawdown 18.6% (first under the 20% limit), from 2025 Sharpe 0.68 and DD 16.8%. Supertrend was taken from public sources at its default settings and only tested here, which adds independent evidence; it is correlated with G-LS (0.60) but not with A (0.32).
- Relative-value (pairs) ideas do not work on these coins at standard settings.
- Recommended paper portfolio is now the three-way split. Parameters frozen as before.

### 2026-11-18 — Round 11: the user's guide baseline (AI Flow Lab "Self-Improving AI Trader"), image 3e779d3

MA20 > MA50 long-only on BTCUSDT 1h (enter on the cross up, exit on the cross down, 3 ATR catastrophic stop; the guide's own costs were 0.15% per switch, ours 0.1% per side + funding):
| IS trades / PF | OOS trades / PF | OOS E | OOS DD | Full CAGR | Sharpe | Max DD | Yearly |
|---|---|---|---|---|---|---|---|
| 421 / 1.00 | 188 / 0.78 | −0.09R | 25.5% | −3.6% | −0.15 | 31.0% | −7.0 −18.0 +16.3 +12.0 −15.0 −4.4 |

Finding: as expected, no edge after costs (about 100 switches a year; fees+funding ≈ 2,600 USDT over the period on 10k). The guide's useful part is its process (one versioned change at a time, validation on later data, post-mortem after N paper trades), which is now in the paper report (post-mortem notice every 30 closed trades).

### 2026-11-19 — Round 12: BTC + ETH only, every timeframe (local, data.binance.vision archive 2020-01 → 2026-11-18)
User request: focus on BTC and ETH, best result per timeframe, start with 2,000 EUR. Data: Binance public archive (candles 15m/1h/4h/1d + funding), same costs (0.05% taker + 0.05% slippage per side, historical funding), split 2025-01-01. No parameters were tuned: published/pre-registered settings only, so the selection bias is the choice among 23 strategies x 4 timeframes.

Screen (23 strategies x 15m/1h/4h/1d, `--brief`, best per timeframe, full-period equity view):
| Timeframe | Best | IS PF | OOS PF | CAGR | Sharpe | Max DD | Note |
|---|---|---|---|---|---|---|---|
| 15m | none | | | | | | every strategy loses to costs (e.g. capitulation −42%/yr) |
| 1h | golden cross EMA50/200 (`gcross1h`) | 1.37 | 1.61 | 25.9% | 0.87 | 39.4% | the only 1h strategy positive in both periods; 2021 −13.5% |
| 4h | A-LV + time stop (`trendlv+timestop`) | 1.58 | 1.40 | 19.8% | 1.15 | 18.9% | positive every year 2020-2026; ±20% robust (only trailAtr 2.4 drops to PF 1.04) |
| 4h | tsmom on 4h bars (`tsmom4h`) | 2.08 | 1.58 | 12.6% | 1.01 | 14.6% | long only, ±20% robust |
| 1d | G-LS (`donchianls`) | | | 25.8% | 0.90 | 44.2% | OOS Sharpe 1.06, robust, but legs far above the 2% rule |
(trade strategies at 1% risk of their own capital; Supertrend daily on BTC/ETH only Sharpe 0.59)

2% rule for G-LS (new `maxLegRisk`: |weight| x catastrophic-stop distance <= 2% of equity, `donchianls2`):
| | Full CAGR | Sharpe | Max DD | OOS Sharpe |
|---|---|---|---|---|
| G-LS BTC/ETH uncapped | 25.8% | 0.90 | 44.2% | 1.06 |
| G-LS BTC/ETH capped 2% | 7.3% | 0.73 | 14.0% | 0.09 |
| G-LS 20 coins uncapped | 25.7% | 0.93 | 32.6% | 0.34 |
| G-LS 20 coins capped 2% | 23.7% | 0.89 | 30.4% | 0.40 |
Decision: the 2% rule is kept and now enforced in code: outside paper mode a weight strategy must cap each leg at 2% (`validateEngineStrategy`), so live G-LS can only be `donchianls2`. On BTC/ETH the cap leaves G-LS with almost nothing, so G-LS is not in the BTC/ETH portfolio.

Portfolios (combo CLI, daily rebalanced, BTC/ETH, legs correlated 0.54-0.60):
| Weights | Full CAGR | Sharpe | Max DD | From 2025 CAGR / DD | Yearly |
|---|---|---|---|---|---|
| A-LV+timestop alone | 19.8% | 1.15 | 18.9% | 17.4% / 18.9% | +52.4 +7.5 +9.1 +27.9 +12.2 +17.4 +15.0 |
| **0.5 A + 0.25 gcross1h + 0.25 tsmom4h** | **20.3%** | **1.18** | **15.2%** | **19.7% / 15.2%** | +61.1 +1.9 +3.8 +30.1 +15.2 +12.4 +24.7 |
| 0.4 / 0.3 / 0.3 | 20.4% | 1.15 | 15.9% | 20.1% / 14.4% | +62.6 +0.7 +2.8 +30.5 +15.7 +11.4 +26.6 |
| 0.34 A + 0.33 gcross1h + 0.33 G-LS-2% | 13.9% | 1.12 | 12.7% | 12.2% / 12.7% | |
| 0.5 A + 0.5 G-LS (uncapped, not allowed live) | 23.7% | 1.11 | 23.7% | 26.0% / 16.0% | |

**Chosen for paper → live (2,000 EUR ≈ 2,300 USDT):** 0.5 A (4h) + 0.25 GC (golden cross 1h) + 0.25 TS (tsmom 4h), BTC+ETH, each engine 1% risk of its own slice (≈ 0.5% / 0.25% / 0.25% of total capital per trade). Paper engines retargeted on 2026-11-19 with the live slice sizes (1150 / 575 / 575 USDT) so minimum notionals behave as live (BTCUSDT minimum 100 USDT: TS on BTC can be skipped in very volatile weeks). Caveats: legs are correlated (one market, two coins), 2021-2022 were nearly flat, and these are backtests (selection among 92 runs).
Review (/e2e-code-review, REQUEST_CHANGES → fixed): guard `mode` is now required (compiler enforces cfg.MODE), guard tests added (uncapped `donchian`/`donchianls` rejected on testnet/live), ATR <= 0 no longer gives an infinite cap, `maxLegRisk` is excluded from the robustness sweep, combo rejects bad intervals/empty legs, test that every compose BOT_NAME has an expectation. Known limit before G-LS goes live: the exchange stop is re-placed only when the position size changes and the 0.02 band can skip small resizes, so a leg's risk can drift above 2% between resizes (by at most the band, ~2% of equity in notional); G-LS is not in the BTC/ETH live plan.

### 2026-11-19 — Round 13: order-flow (taker buy/sell balance) confirmation for A (local, data.binance.vision 2020-01 → 2026-11-18)
User question: are volume / order-flow data (funding, open interest, liquidations, taker balance) useful? Funding was already tested (D crowding PF 0.65, H carry Sharpe 0.60: both fail). Taker balance is in the kline archive (column 9, taker buy base volume), so it was tested first.
Rule (pre-registered, not tuned): `minTakerShare` 0.5 — the breakout candle's aggressive volume must be majority on the trade's side (taker buy / volume >= 0.5 for a long, taker sell share >= 0.5 for a short). Registry `trendlvtk` = A-LV + this filter. BTC+ETH 4h, 1% risk, same costs, split 2025-01-01.

| | trades (all) | OOS trades | OOS PF | OOS E | OOS DD | CAGR | Sharpe | max DD |
|---|---|---|---|---|---|---|---|---|
| A-LV + time stop (live) | 490 | 150 | 1.36 | 0.235R | 19.2% | 20.2% | 1.17 | 19.2% |
| + taker >= 0.5 (`trendlvtk+timestop`) | 478 | 146 | 1.40 | 0.259R | 18.4% | 21.0% | 1.22 | 18.4% |

Robustness of the filter: 0.4 = the baseline (no trade removed), 0.6 = 1 trade in 2 years (a cliff, not a plateau).
Finding: the filter removes only ~2.5% of trades (12 of 490); breakout candles that close above the 20-bar high almost always have buyer-majority taker volume already, so the information is mostly in the price. The small improvement (PF +0.04, Sharpe +0.05) is within noise for 12 trades and the 0.6 cliff shows no usable gradient. NOT ADOPTED; the live set stays frozen. Infrastructure kept (candles and CSVs carry `takerBuyVolume`, parseKline reads it, filter off by default) for open-interest/liquidation work later.

### 2026-11-19 — Round 13b: open-interest confirmation for A (data.binance.vision daily `metrics`, 5-min OI; BTC from 2020-09, ETH from 2021-12)
Rule (pre-registered, not tuned): `oiLookback` 6 bars (24h) — a breakout needs OI at the signal close above OI 24h earlier (new positions rather than short covering). Missing OI does not block (so ETH before 2021-12 and BTC before 2020-09 equal the baseline). Registry `trendlvoi`. Same setup as round 13.

| | OOS trades | OOS PF | OOS E | OOS DD | CAGR | Sharpe | max DD |
|---|---|---|---|---|---|---|---|
| A-LV + time stop (live) | 150 | 1.36 | 0.235R | 19.2% | 20.2% | 1.17 | 19.2% |
| + OI rising 24h (`trendlvoi+timestop`) | 130 | 1.43 | 0.277R | 17.3% | 18.0% | 1.12 | 17.3% |

Net per year (all data), baseline vs OI filter: 2020 7105 / 7464, 2021 301 / −255, 2022 1476 / 1510, 2023 5162 / 4194, 2024 2953 / 590, 2025 4277 / 4595, 2026 4204 / 3182. OOS robustness: oiLookback 5 → PF 1.46, 7 → PF 1.45 (stable).
Finding: better out of sample (PF 1.36 → 1.43, DD 19.2% → 17.3%) but worse in sample where the data exists (2021 turns negative, 2023 and 2024 much lower) and worse over the full period (CAGR −2.2 pts, Sharpe −0.05). An edge that appears only out of sample is the same pattern that rejected the ADX cap (round 7): NOT ADOPTED. Re-check on paper-period data later (pre-registered rule unchanged) if wanted; the live engine would also need an OI feed (`/futures/data/openInterestHist`).

### 2026-11-19 — Loss attribution of the live set (BTC+ETH, `--analyze`, all data 2020-01 → 2026-11)
- A (490 trades): losses are false breakouts. 165 trades closed within 1-6 candles for −119R; losers that never reached +0.25R −89R, reached 0.25-1R −121R, gave back 1R+ only −18R. The 40 trades at 3R+ made +254R (more than the total). The time stop exits failing trades at −0.64R on average instead of −1R (98 trades). ATR 2-3% at signal is marginal (PF 1.04). 2026 longs weak (PF 0.87), 2025 shorts weak (PF 0.87): the two sides alternate.
- GC (522): 314 stop-outs at −1.09R (−342R) vs 206 cross exits at +2.65R (+546R). 155 losers were 1R+ in profit before the fixed 3-ATR stop hit (−139R given back): the only large "given back" bucket in the set. Idea for after the paper period (not now: parameters frozen): a trailing stop for GC, tested as one pre-registered change.
- TS (267): losers are small (−0.5R, score exit), only 18 stop-outs; losses happen in 1-18 candles, profits in 49+ candles; 2022 (bear, long only) PF 0.14.

### 2026-11-19 — Round 14: trailing stop for GC (user request; pre-registered 3-ATR chandelier = GC's own initial stop distance)
`gcross1htr`: highest high (lowest low) since entry ∓ 3 × ATR(14) on 1h, tighten only; exit on the reverse cross unchanged. BTC+ETH, split 2025-01-01.

| | IS trades | IS win | IS avg win | IS PF | OOS PF | CAGR | Sharpe | max DD |
|---|---|---|---|---|---|---|---|---|
| GC (live, fixed 3-ATR stop) | 369 | 23% | 4.85R | 1.35 | 1.48 | 24.0% | 0.82 | 37.7% |
| GC + 3-ATR trail | 501 | 34% | 0.97R | 0.92 | 0.76 | −4.5% | −0.40 | 33.0% |
Robustness: trail 2.4 → OOS PF 0.77, 3.6 → 0.62. Finding: the trail stops winners out on ordinary 1h noise (avg win 4.85R → 0.97R); GC's edge is the few long trends that run from cross to cross. The "given back" losers are the price of holding those. REJECTED, same lesson as A (rounds 4-7).

### 2026-11-19 — Round 15: why the GC trail failed, and wide profit protection (user request)
GC MFE table (all data, 522 trades): MFE 0-1R 243 trades −246R (bad entries); 1-2R 78 trades, 76 losers −73R; 2-3R 59 trades, 47 losers −36R; 3-5R 60 trades, 28 losers +12R; 5-10R 51 trades +144R; 10R+ 31 trades +414R. Winners capture 50% of their MFE (avg MFE 9.7R, avg win 4.8R).
Why the 3-ATR trail failed: trades reaching 10R+ fell from 31 to 1 (a 1R-wide trail on 1h is hit by ordinary noise), and stopped-out positions free the slot, so later whipsaw crosses are taken (704 trades vs 522; MFE < 0.5R trades 162 → 311).
Pre-registered fixes (protection only after a large MFE, distances in R, no tight trail), BTC+ETH 1h, split 2025-01-01:

| GC exit | IS PF | OOS PF | OOS E | avg win (IS) | CAGR | Sharpe | max DD |
|---|---|---|---|---|---|---|---|
| live (fixed 3-ATR stop) | 1.35 | 1.48 | 0.445R | 4.85R | 24.0% | 0.82 | 37.7% |
| `+be2` stop to entry at MFE 2R | 1.43 | 1.47 | 0.389R | 5.11R | 26.8% | 0.90 | 25.7% |
| `+lock3` lock +1R at MFE 3R | 1.40 | 1.39 | 0.358R | 3.75R | 28.9% | 0.96 | 22.6% |
| `+wide3` stepped stop 3R behind peak from 3R | 1.37 | 1.16 | 0.178R | 4.25R | 20.5% | 0.81 | 31.2% |
be2 robustness (trigger ±20%): 1.6R → IS 1.43 / OOS 1.45, DD 26.5%; 2.4R → IS 1.37 / OOS 1.48, DD 27.4%. Portfolio 0.5 A + 0.25 GC + 0.25 TS: live Sharpe 1.18 / DD 15.7% / OOS Sharpe 0.95; with GC+be2 Sharpe 1.21 / DD 15.9% / OOS Sharpe 0.93.
Finding: wide protection keeps the big winners (be2 avg win 5.11R vs the trail's 0.97R) and cuts GC's own drawdown by a third (37.7% → 25.7%), robust to its trigger; but the gain is in sample (mostly 2021), out of sample it is flat (PF 1.48 → 1.47) and the portfolio barely moves. lock3 and wide3 are worse out of sample. Not adopted now (parameters frozen during paper); be2 is the candidate to re-check on paper-period data at GC's post-mortem.

### 2026-11-19 — Round 16: three more ways to keep GC's profits (user: "there must be a solution")
Pre-registered, different mechanisms from round 15: `gcross1hdt` chandelier at 3 × DAILY ATR(14) (wide, daily-noise scale); `gcross1hema` exit on a close through EMA50 once MFE >= 3R (structure exit); `gcross1h+tp5` take 1/3 off at 5R (research only, live refuses TPs).

| GC exit | IS PF | OOS PF | OOS E | CAGR | Sharpe | max DD | robustness (OOS PF at ±20%) |
|---|---|---|---|---|---|---|---|
| live | 1.35 | 1.48 | 0.445R | 24.0% | 0.82 | 37.7% | |
| be2 (round 15) | 1.43 | 1.47 | 0.389R | 26.8% | 0.90 | 25.7% | 1.45 / 1.48 |
| 3 × daily ATR trail | 1.26 | 1.42 | 0.399R | 19.3% | 0.73 | 30.1% | 1.21 / 1.40 |
| EMA50 exit after 3R | 1.11 | 1.18 | 0.197R | 7.9% | 0.44 | 33.4% | 1.18 / 1.14 |
| 1/3 off at 5R | 1.29 | 1.35 | 0.332R | 18.2% | 0.75 | 31.2% | |
Finding: all three lower returns; the earlier the exit reacts, the worse (EMA50 exit worst). Over seven exit designs (rounds 14-16) only be2 helps, and only on drawdown. GC's winners already capture 50% of their MFE; the part given back on the way out of a trend is what pays for the 10R+ tails. Conclusion: per-trade giveback is a structural cost of trend following, not a bug; the account-level answer is diversification (3 engines, correlation ~0.55) and sizing, not tighter exits. be2 stays the only candidate for GC's post-mortem.

### 2026-11-19 — Round 17: be2 adopted for GC (owner's decision), tested for TS
Owner: "we have no profit protection; protect without cutting the trade". GC had zero paper trades, so changing it now does not contaminate the paper record. GC live strategy: `gcross1h` → `gcross1h+be2` (stop to entry + 0.2% once MFE >= 2R; exits otherwise unchanged). Backtest all data: 574 trades, win 20%, PF 1.44, E 0.41R, avg win 5.11R, CAGR 26.8%, Sharpe 0.90, max DD 25.7% (was 37.7%); OOS PF 1.47 (was 1.48). Paper expectations (paperStats GC) updated to these numbers.
TS + be2: no effect (IS PF 2.22 → 2.26, OOS identical 1.51, max DD identical 13.1%; 1.6R / 2.4R the same) because TS's losers almost never reach 2R (2 of 17 trades in the 2-3R bucket lost) and its score exit already protects. TS unchanged.

### 2026-11-19 — Round 18: decide every 15 minutes on the forming 4h candle? (user question)
Harness `src/strategy/intrabar.ts`: A-LV + time stop on 15m candles (data.binance.vision 2020-01 → 2026-11-18), stops/exits updated only at 4h closes in both variants, so only entry timing differs. `trendlv15c` = entries at 4h closes (control); `trendlv15i` = entries at every 15m close on the forming 4h candle.

| | trades | IS PF | OOS PF | OOS E | fees+funding | CAGR | Sharpe | max DD | losing years |
|---|---|---|---|---|---|---|---|---|---|
| wait for the 4h close (control) | 477 | 1.66 | 1.47 | 0.300R | 4,350 | 21.5% | 1.23 | 19.4% | none |
| every 15 min, forming candle | 606 | 1.41 | 1.54 | 0.325R | 5,616 | 21.9% | 1.14 | 18.2% | 2022 (−3.2%) |
Finding: deciding on the forming candle adds 27% more trades (breakouts that do not hold to the close) and 29% more costs; in sample PF falls 1.66 → 1.41, Sharpe 1.23 → 1.14 and 2022 turns negative; the OOS gain (PF 1.47 → 1.54) is the out-of-sample-only pattern again. NOT ADOPTED: the live engine keeps deciding at closed candles. (The control on 15m data is close to the 4h backtest, Sharpe 1.23 vs 1.17: the harness is sound.)

### 2026-11-20 — Round 19: join the strategy's open position at engine start-up? (user request)
Question: the live engines missed the 5.11-20.11 fall (backtest GC +6.4R/+6.8R, A BTC +4.9R open) because they started after the entry bars. Rule tested: at start-up, if the strategy holds a position, enter at once with the strategy's CURRENT stop and leave when the strategy leaves. Method: BTC+ETH single-symbol backtests 2021-01..2026-11-19 (data.binance.vision), a start day every day at 00:00 UTC; joined R = (move from the start price to the strategy's exit - fees/slippage) / distance to the current stop; days whose stop is < 0.2% away skipped. Samples are overlapping days of the same trades (not independent). Pre-registered pass: mean joined R > 0 in BOTH halves (split 2025-01-01).
| strategy | joined IS (2021-24) | joined OOS (2025-26) | fresh trades IS / OOS (reference) | verdict |
|---|---|---|---|---|
| A trendlv+timestop | +0.10R (n=607 days, win 30%) | +0.73R (n=319, win 35%) | +0.21R / +0.24R | passes, weak: IS +0.10 is within noise (~±0.12) and below a fresh trade; OOS lifted by the 2025-26 trends (ETH +0.97) |
| GC gcross1h+be2 | -0.04R (n=1630) | +0.16R (n=804) | +0.16R / +0.40R | FAIL (IS negative) |
| TS tsmom4h | +0.05R (n=950) | -0.05R (n=390) | +0.22R / +0.20R | FAIL (OOS negative) |
Conclusion: no change. Joining mid-trend is worth much less than a fresh signal (the good part of the move is usually gone, and the current stop is often far); only A is marginally positive and not robust in IS. Missing an ongoing trend after a start is a one-off cost of starting, not a recurring loss. Script: session scratchpad join.mts (not committed).

### 2026-11-21 — Round 20: native 15m strategies, holding as long as the exits allow (owner request)
Pre-registered, default parameters, BTC+ETH 2021-01..2026-11-20 15m (data.binance.vision), split 2025-01-01, 1% risk. Costs: taker 0.05% + slippage 0.05% per side (standard); sensitivity "maker" 0.02% + 0.01% (optimistic: assumes every order, stops included, fills as a limit order).
| strategy (15m) | trades IS/OOS | IS PF | OOS PF | maker IS / OOS PF | avg hold |
|---|---|---|---|---|---|
| S1 Donchian-20 breakout, A rules | 5412 / 2671 | 0.72 | 0.70 | 0.90 / 0.89 | 2.8h |
| S2 S1 + only with the 4h EMA50/200 trend | 3047 / 1506 | 0.69 | 0.68 | 0.89 / 0.90 | 2.8h |
| S3 Golden cross EMA50/200 | 1192 / 614 | 0.94 | 0.79 | 1.08 / 0.94 | 31.8h |
| S4 S3 + only with the 4h trend | 772 / 395 | 0.86 | 0.91 | 1.01 / 1.06 | 30.0h |
| S5 Supertrend(10,3) | 5847 / 3048 | 0.82 | 0.83 | 0.96 / 1.03 | 8.6h |
| S6 mean reversion (strategy C) | 4154 / 2054 | 0.51 | 0.32 | 0.76 / 0.66 | 1.2h |
| S7 intraday momentum (Shen et al. 2022: 00:00-00:30 UTC sign -> 23:30-24:00) | 1460 / 689 days | gross -0.7 / +0.4 bp per trade (BTC/ETH), hit 50-51% | | net -5 to -7 bp even at maker cost | 30 min |
Conclusion: nothing works on 15m. With real (taker) costs every strategy loses in both periods; even the optimistic maker case is break-even at best. Cause: on 15m the stop is ~0.5-1% away, so the 0.2% round trip costs 0.2-0.4R per trade (on 4h ~0.06R), and 15m breakouts are mostly noise. Holding longer (S3/S4, ~30h) does not fix it. Consistent with Laly (2025): no 15-300 minute momentum/contrarian strategy beats the benchmark after costs. Script: scratchpad m15.mts (not committed).

### 2026-11-21 — Round 21: ideas from a wide search (web, YouTube write-ups, GitHub/freqtrade, Claude skill repos)
Search finding: no public strategy with a verified live record; most "best" claims are unverifiable backtests or overfit (freqtrade showcase repos, a viral TradingView rebuild at coin-flip odds). Testable ideas from the literature and write-ups, each on A live (trendlv+timestop+befee), BTC+ETH 4h 2020-01..2026-11-20, pre-registered pass = PF and E better than A+befee in both halves:
| idea | IS n / PF / E | OOS n / PF / E | net (2 x 10k) | verdict |
|---|---|---|---|---|
| A+befee (live) | 347 / 1.71 / 0.342R | 152 / 1.45 / 0.255R | 19.2k | - |
| T1 no entries from weekend candles (weekend-effect papers) | 314 / 1.72 / 0.336R | 133 / 1.67 / 0.346R | 18.1k | FAIL (IS E lower) |
| T2 funding crowding: skip longs when the last funding > its 90-day 90th pct, shorts < 10th | 309 / 2.00 / 0.433R | 133 / 1.51 / 0.285R | 22.3k | PASS |
| T3 only after volatility contraction (ATR% < 100-bar median; squeeze idea) | 225 / 1.84 / 0.398R | 89 / 1.34 / 0.175R | 12.0k | FAIL |
| T4 pullback-in-trend entry (RSI(3) < 20 / > 80 in A's trend; "reversion layer") | 717 / 1.02 / 0.018R | 270 / 1.31 / 0.142R | 4.3k | FAIL |
T2 robustness (IS PF / OOS PF / net): p85 2.13 / 1.60 / 23.8k; p95 1.87 / 1.42 / 20.5k; 60d 1.94 / 1.56 / 22.1k; 120d 2.00 / 1.44 / 21.2k; p80 2.28 / 1.75 / 25.8k. IS improves in every variant; OOS improves in 4 of 6, flat in 2 (p95, 120d); both symbols improve (BTC PF 1.58 -> 1.68, ETH 1.62 -> 1.87); gain mostly 2022-2023, 2025-26 about equal. Reading: entering a breakout when the perp is already crowded on that side tends to fail; a real but modest out-of-sample effect. Candidate for A (needs a funding-aware trendlv variant; live engine already attaches funding for needsFunding strategies). Not deployed: owner's decision.

### 2026-11-21 — Round 22: Fibonacci retracement entries (owner question)
Pre-registered: A's trend (EMA50 vs EMA200), 50-bar impulse (low before high for longs), enter when a candle touches the retracement level and closes back on the trend side, stop beyond the 78.6% level, A's exits (chandelier, time stop, befee). Control: the same rule at non-Fibonacci ratios. BTC+ETH 4h 2020-01..2026-11-20 (IS PF / OOS PF / net, 2 x 10k): A live breakout 1.71 / 1.45 / 19.2k; 0.382 0.94 / 1.41 / 1.4k; 0.45 1.08 / 1.42 / 3.7k; 0.50 1.14 / 1.09 / 2.5k; 0.55 1.19 / 1.55 / 6.4k; 0.618 1.08 / 1.74 / 6.0k; 0.70 0.75 / 1.90 / 1.0k.
Conclusion: 0.618 is not special (0.55 beats it before 2025, 0.70 beats it after); every ratio is near break-even before 2025 and better after, i.e. a regime effect, not a Fibonacci effect. All far below the breakout (net 1-6k vs 19k). Not adopted.

### 2026-11-22 — Round 23: an external review's suggestions, tested on A live
A live = trendlvfc+timestop+befee, BTC+ETH 4h 2020-01..2026-10, size changes as weights on R; pass = more total R AND better return/maxDD in both halves. Regimes in R: 2020-21 / 2022 bear / 2023-24 bull / 2025-26.
| suggestion | IS R, PF, DD | OOS R, PF, DD | regimes | verdict |
|---|---|---|---|---|
| A live | 130R, 2.06, 12.7R | 35R, 1.51, 15.6R | 67 / 14 / 49 / 35 | - |
| funding hard +-0.025% block (instead of percentile) | 129R, 2.05, 12.7R | 32R, 1.42, 18.0R | 68 / 10 / 51 / 32 | FAIL |
| funding soft +-0.010% = half size, +-0.025% block | 97R, 2.01, 11.8R | 34R, 1.49, 18.0R | 39 / 10 / 48 / 34 | FAIL (0.01% is Binance's default rate, so it halves most longs) |
| top-trader account L/S fixed: long > 1.7 / short < 0.55 blocked | 137R, 2.23, 12.7R | 17R, 1.25, 15.6R | 65 / 14 / 58 / 17 | FAIL (top traders are long-biased: L/S > 1.7 in 38% of BTC and 70% of ETH candles, < 0.55 almost never) |
| top-trader L/S above its 90-day 90th pct blocked | 132R, 2.07, 12.7R | 35R, 1.51, 15.6R | 68 / 14 / 49 / 35 | no effect (blocks 1 trade; overlaps the funding filter) |
| ATR 2-3% = 70% size | 120R, 2.08, 12.7R | 38R, 1.58, 14.4R | 61 / 8 / 50 / 38 | FAIL (better after 2025, worse before) |
| x1.5 size when GC and TS agree | 188R, 2.12, 16.9R | 44R, 1.46, 22.3R | 93 / 20 / 75 / 44 | FAIL (more R only through more risk; OOS return/DD 2.27 -> 1.96) |
Already settled: decide on real market data (done 2026-11-22); loss-streak / drawdown risk cuts failed in round 3 (OOS PF 1.12 -> 1.01); risk per trade is already volatility-based (stop = 2 ATR, 1% risk). Data: L/S and OI from data.binance.vision um/daily/metrics (5-min, from 2020-09 BTC / 2021-12 ETH). Nothing adopted.

### 2026-11-22 — Round 24: signal quality, regime, confirmation (external review, second round)
Same setup as round 23 (A live, BTC+ETH 4h 2020-01..2026-10; pass = more total R and better return/maxDD in both halves). Exits were not retested: rounds 2-3, 5, 14-16 and 2026-11-21 (TP ladders, partial TP at 1.5-3R, lock at 3R, R trailing, frozen-ATR trail, be variants) already cover them; only befee helped.
| idea | IS R, PF, DD | OOS R, PF, DD | regimes 20-21/22/23-24/25-26 | verdict |
|---|---|---|---|---|
| A live | 130R, 2.06, 12.7R | 35R, 1.51, 15.6R | 67/14/49/35 | - |
| Q1 volume > 1.5x 20-bar average on the signal candle | 124R, 2.18, 11.5R | 39R, 1.67, 11.3R | 61/17/47/39 | FAIL (IS R lower; PF and DD better in both) |
| Q2 decisive break: close beyond the 20-bar extreme by >= 0.25 ATR | 131R, 2.43, 10.8R | 36R, 1.65, 10.9R | 70/7/54/36 | PASS |
| Q3 regime: EMA50 10-bar slope in the trade direction | 121R, 2.09, 10.7R | 34R, 1.53, 15.6R | 60/11/50/34 | FAIL |
| Q4 GC or TS must agree, else skip | 124R, 2.08, 11.2R | 36R, 1.54, 15.6R | 64/13/47/36 | FAIL |
Q2 robustness (IS R/PF/DD | OOS R/PF/DD): k=0.15 130/2.20/12.6 | 37/1.64/12.7; 0.20 131/2.30/11.4 | 33/1.56/12.7; 0.30 125/2.36/10.8 | 42/1.85/10.9; 0.35 126/2.40/10.6 | 44/1.99/9.0; 0.50 102/2.32/10.0 | 42/2.03/9.1. Every k raises PF and lowers max DD in both halves with about the same total R (about 20% fewer trades); weak spot: the 2022 bear (6-13R vs 14R). The note "close below the average of the 3 lowest lows" in the review would be a weaker break, not a stronger one (that average sits above the lowest low), so the ATR margin was used instead. Candidate for A (owner's decision).

### 2026-11-22 — Round 25: regime filters on A live (trendlvfcd+timestop+befee)
Same setup as rounds 23-24 (BTC+ETH 4h 2020-01..2026-10; pass = more total R and better return/maxDD in both halves). IS R/PF/DD | OOS R/PF/DD:
A live 131.0/2.43/10.8 | 35.9/1.65/10.9. F1 daily EMA50/200 must agree: 64/2.02/10.7 | 21/1.72/6.5 FAIL (halves the trades and the profit). Owner's exact version (daily EMA50/200 agrees and |gap| >= 0.5%, else no trade): 64.7/2.05/10.7 | 16.3/1.54/7.4, trades 373 -> 227 (-39%), 2022 1R vs 7R: FAIL on profit and PF in both halves (the daily EMA200 spans ~200 days and turns long after A's 4h EMAs, so it removes the early-trend trades that pay most). F2 ADX(14) < 20 skip: 114/2.79/6.8 | 10/1.20/13.1 FAIL (collapses after 2025). F4 EMA50/200 gap < 1.5% skip: 94/2.25/9.9 | 22/1.53/9.8 FAIL. F5 momentum not strongly against: identical to A (never binds: A's EMA trend condition already implies it). F6 ATR rising (ATR now > ATR 10 bars ago): 130.7/3.34/9.3 | 36.4/1.96/5.6, misses the pass by 0.3R in IS. F3 "price near the middle of the 20-bar range" was not run: A only enters beyond the 20-bar extreme, so it can never bind.
F6 robustness (lookback L): 5: 114.7/2.41/10.8 | 39.3/1.80/9.4; 8: 122.7/2.88/9.7 | 33.9/1.79/6.6; 12: 111.7/2.81/8.1 | 31.1/1.77/6.2; 15: 111.1/3.01/9.2 | 31.5/1.84/5.4; 20: 113.4/3.27/7.1 | 33.7/1.94/6.6. Every L raises PF and cuts OOS drawdown (5.4-9.4R vs 10.9R) but usually costs 6-15% of the IS profit; L=10 sits at the top of its neighbours (suspicious), and stacking a second entry filter on the decisive-break rule cuts trades to about 70%. Not adopted (failed the pre-registered rule); candidate to re-check at A's 30-trade post-mortem.

## Deep research (2026-11-17, second pass; second-hand from search summaries)
- No directional strategy was verifiably profitable in every year 2020-2026. Trend funds/ETFs lost in 2022 and 2025; their strength is small losses versus buy-and-hold.
- The only family without losing years is hedged/market-neutral carry (needs a spot leg) and its yield has compressed to near T-bills in 2026.
- Closest candidates to test next: (G) daily Donchian ensemble, 9 lookbacks 5-360d, trailing stop at the channel midpoint, volatility targeting (Zarattini, Pagani & Barbon 2025); (H) cross-sectional funding carry, long the lowest third / short the highest third by 7-day average funding, dollar-neutral (weak evidence, holdout Sharpe ~1.1 claimed).
