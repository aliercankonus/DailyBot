# Progress

## Goal
Binance USDⓈ-M futures bot (long + short) with a proven out-of-sample edge, running on a Hostinger VPS. Phases and gates: `docs/PLAN.md`.

## Decisions
- 2026-11-17: Rewrite instead of repairing `dailytradingbot` (see `docs/legacy-review.md`).
- 2026-11-17: TypeScript + Postgres + Docker Compose on the VPS; Lovable/Supabase dropped.
- 2026-11-17: Futures, long + short, isolated margin, one-way mode. Max 5x leverage, max 2% risk/trade enforced in config.
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

## Deep research (2026-11-17, second pass; second-hand from search summaries)
- No directional strategy was verifiably profitable in every year 2020-2026. Trend funds/ETFs lost in 2022 and 2025; their strength is small losses versus buy-and-hold.
- The only family without losing years is hedged/market-neutral carry (needs a spot leg) and its yield has compressed to near T-bills in 2026.
- Closest candidates to test next: (G) daily Donchian ensemble, 9 lookbacks 5-360d, trailing stop at the channel midpoint, volatility targeting (Zarattini, Pagani & Barbon 2025); (H) cross-sectional funding carry, long the lowest third / short the highest third by 7-day average funding, dollar-neutral (weak evidence, holdout Sharpe ~1.1 claimed).
