# trading-engine

<!-- Installed by agent-patterns bootstrap. Keep this file lean: everything here is loaded into every agent's context. -->

## Project
- Purpose: Binance USDⓈ-M futures trading bot (long + short) whose backtest and live engine run the same strategy code.
- Stack: TypeScript (Node 22, ESM), PostgreSQL 16, Fastify, Vitest, Docker Compose on a Hostinger VPS.
- Default branch: main
- Plan and phase gates: `docs/PLAN.md`. Why this rewrite exists: `docs/legacy-review.md`.

## Commands
- Install: `npm ci`
- Test (all): `npm test` (Postgres tests also run when `TEST_DATABASE_URL` is set)
- Test (single file): `npx vitest run test/engine.test.ts`
- Lint / typecheck: `npm run typecheck`
- Download data: `npm run download -- --interval 4h --from 2021-01-01`
- Backtest: `npm run backtest -- --interval 4h --split 2025-01-01 --robustness`
- Run locally: `npm run migrate && npm run engine` (MODE=paper by default), `npm run api`

## Code conventions
- `src/strategy/*` are pure functions of CLOSED candles. The backtester and `src/engine/engine.ts` call the same object. Never give a strategy a forming candle.
- Indicators return arrays aligned with input; `out[i]` may use only `input[0..i]`. Add a no-look-ahead test for every new indicator.
- The exchange is the source of truth. Every order goes through the `Exchange` interface (`src/exchange/types.ts`); Binance and paper both implement it.
- Every order uses a deterministic client id from `clientId()` so retries never double-enter.
- A position must never be left without a stop: `protectOrClose()` either places the stop or closes at market; if both fail it turns the kill switch on.
- Gates live only in `src/risk/gates.ts`. **Hard cap: 8 gates. A new gate requires removing one.** No symbol- or side-specific special cases, no "probe/bypass/override" exceptions.
- A strategy or parameter change is not done until `npm run backtest` has been re-run and the out-of-sample result is recorded in `PROGRESS.md`.
- Quantities and prices sent to Binance go through `src/risk/precision.ts`.

## Do not touch
- `.env`, API keys, `data/` (downloaded candles). `src/db/schema.sql` must stay idempotent (`IF NOT EXISTS`).
- `.claude/` (installed from agent-patterns; update via bootstrap, not by hand).
- Risk limits in `src/config.ts` (max 2% risk/trade, max 5x leverage) are deliberate; do not raise them.

## Agent workflow
- Large or parallel tasks: use `/delegate`. Read-heavy work goes to subagents, which return summaries, not file dumps.
- Before merging: run `/e2e-code-review`. Changes under `src/exchange/`, `src/engine/` or `src/risk/` always get the security reviewer.
- When the context is ~75% full, or before switching sessions: run `/context-handoff`, then resume from `handoff.md`.
- Keep durable progress in `PROGRESS.md` (goal, decisions, done/next).
- Model tiers: haiku for search/extract/classify, sonnet for focused code work, opus for planning and final judgment.
