-- Idempotent schema. Applied by `npm run migrate`.
CREATE TABLE IF NOT EXISTS positions (
  id                     TEXT PRIMARY KEY,
  symbol                 TEXT NOT NULL,
  side                   TEXT NOT NULL CHECK (side IN ('LONG','SHORT')),
  status                 TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  quantity               DOUBLE PRECISION NOT NULL,
  entry_price            DOUBLE PRECISION NOT NULL,
  entry_time             BIGINT NOT NULL,
  entry_candle_open_time BIGINT NOT NULL,
  initial_stop           DOUBLE PRECISION NOT NULL,
  stop                   DOUBLE PRECISION NOT NULL,
  stop_order_id          TEXT,
  leverage               INTEGER NOT NULL,
  risk_amount            DOUBLE PRECISION NOT NULL,
  exit_price             DOUBLE PRECISION,
  exit_time              BIGINT,
  exit_reason            TEXT,
  realized_pnl           DOUBLE PRECISION,
  fees                   DOUBLE PRECISION,
  strategy               TEXT NOT NULL
);
-- At most one open position per symbol, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS positions_one_open_per_symbol ON positions (symbol) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS positions_exit_time ON positions (exit_time);

CREATE TABLE IF NOT EXISTS signals (
  id                BIGSERIAL PRIMARY KEY,
  symbol            TEXT NOT NULL,
  candle_open_time  BIGINT NOT NULL,
  side              TEXT,
  accepted          BOOLEAN NOT NULL,
  gate              TEXT,
  detail            TEXT NOT NULL,
  created_at        BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS signals_created ON signals (created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  level       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  symbol      TEXT,
  message     TEXT NOT NULL,
  data        JSONB,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_created ON events (created_at DESC);

CREATE TABLE IF NOT EXISTS equity (
  time    BIGINT PRIMARY KEY,
  equity  DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_state (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);

-- Engines that trade a real exchange (testnet/live) register a fingerprint of their API key here
-- (in the main database), so two engines can never share one Binance account by mistake.
CREATE TABLE IF NOT EXISTS engine_accounts (
  fingerprint    TEXT PRIMARY KEY,
  bot_name       TEXT NOT NULL,
  -- The engine's own database: two engines with the same BOT_NAME but different databases still clash.
  instance       TEXT NOT NULL,
  registered_at  BIGINT NOT NULL
);
-- Added after the first version of the table (idempotent upgrade).
ALTER TABLE engine_accounts ADD COLUMN IF NOT EXISTS instance TEXT NOT NULL DEFAULT '';

-- Binance USD-M forced liquidations (public !forceOrder stream: at most the largest one per symbol
-- per second, so a lower bound of real activity). Collected by src/cli/liquidations.ts for research.
CREATE TABLE IF NOT EXISTS liquidations (
  id           BIGSERIAL PRIMARY KEY,
  symbol       TEXT NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('BUY','SELL')),   -- SELL = a long was liquidated
  price        DOUBLE PRECISION NOT NULL,
  avg_price    DOUBLE PRECISION NOT NULL,
  quantity     DOUBLE PRECISION NOT NULL,
  notional     DOUBLE PRECISION NOT NULL,                       -- avg_price x filled quantity, USDT
  status       TEXT NOT NULL,
  trade_time   BIGINT NOT NULL,
  received_at  BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS liquidations_dedupe ON liquidations (symbol, trade_time, side, quantity, price);
CREATE INDEX IF NOT EXISTS liquidations_time ON liquidations (trade_time);
