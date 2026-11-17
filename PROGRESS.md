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

## Deployment
- 2026-11-17: Hostinger VPS (KVM 2, Düsseldorf) Docker project `dailybot`, MODE=paper. db/api/engine healthy, migrate exit 0, engine ticking every 60s (~1.5s per tick). API on 127.0.0.1:8081. Secrets live in the project environment in hPanel.

## Next
2. Phase 1 continues: candidate A failed the gate; research candidates B (1h pullback with 4h trend filter) and C (mean reversion), same acceptance criteria.
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

## Deep research (2026-11-17, second pass; second-hand from search summaries)
- No directional strategy was verifiably profitable in every year 2020-2026. Trend funds/ETFs lost in 2022 and 2025; their strength is small losses versus buy-and-hold.
- The only family without losing years is hedged/market-neutral carry (needs a spot leg) and its yield has compressed to near T-bills in 2026.
- Closest candidates to test next: (G) daily Donchian ensemble, 9 lookbacks 5-360d, trailing stop at the channel midpoint, volatility targeting (Zarattini, Pagani & Barbon 2025); (H) cross-sectional funding carry, long the lowest third / short the highest third by 7-day average funding, dollar-neutral (weak evidence, holdout Sharpe ~1.1 claimed).
