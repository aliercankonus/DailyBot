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
