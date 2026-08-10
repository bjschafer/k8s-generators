-- Load Alliant usage CSVs into Postgres. Run under psql --single-transaction:
-- either the whole snapshot lands or none of it does.
--
-- The collector re-fetches all history every run, so this is written to be
-- idempotent: staging tables + UPSERT, never DELETE-then-INSERT. A run that
-- fetches a short window cannot erase history, and late-arriving meter reads
-- correct themselves in place.

CREATE TABLE IF NOT EXISTS hourly_usage (
  account    text             NOT NULL,
  meter      text             NOT NULL,
  -- local_date/hour_start are the real key, deliberately: they survive DST
  -- transitions unambiguously, where a bare instant does not. `ts` is derived
  -- for Grafana's benefit and is not authoritative.
  local_date date             NOT NULL,
  hour_start smallint         NOT NULL CHECK (hour_start BETWEEN 0 AND 23),
  kwh        double precision NOT NULL,
  ts         timestamptz      NOT NULL,
  updated_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (account, meter, local_date, hour_start)
);
CREATE INDEX IF NOT EXISTS hourly_usage_ts_idx ON hourly_usage (ts);

CREATE TABLE IF NOT EXISTS daily_usage (
  account    text             NOT NULL,
  meter      text             NOT NULL,
  local_date date             NOT NULL,
  kwh        double precision NOT NULL,
  updated_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (account, meter, local_date)
);

-- One row per billing period. `amount_usd` is what makes cost analysis possible
-- at all; the hourly feed carries no price.
CREATE TABLE IF NOT EXISTS billing_period (
  account      text             NOT NULL,
  meter        text             NOT NULL,
  period_start date             NOT NULL,
  period_end   date             NOT NULL,
  kwh          double precision NOT NULL,
  amount_usd   double precision NOT NULL,
  updated_at   timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (account, meter, period_start)
);

CREATE TABLE IF NOT EXISTS collector_run (
  id          bigserial PRIMARY KEY,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  hourly_rows integer     NOT NULL,
  daily_rows  integer     NOT NULL,
  billing_rows integer    NOT NULL
);

CREATE TEMP TABLE stg_hourly (
  account text, meter text, local_date date, hour_start smallint, kwh double precision
) ON COMMIT DROP;
CREATE TEMP TABLE stg_daily (
  account text, meter text, local_date date, kwh double precision
) ON COMMIT DROP;
CREATE TEMP TABLE stg_billing (
  account text, meter text, period_start date, period_end date,
  kwh double precision, amount_usd double precision
) ON COMMIT DROP;

\copy stg_hourly  FROM '/data/hourly.csv'  WITH (FORMAT csv, HEADER true)
\copy stg_daily   FROM '/data/daily.csv'   WITH (FORMAT csv, HEADER true)
\copy stg_billing FROM '/data/billing.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO hourly_usage (account, meter, local_date, hour_start, kwh, ts)
SELECT account, meter, local_date, hour_start, kwh,
       -- Naive local wall time -> instant. Postgres owns the tz database, so
       -- this stays correct across DST rule changes without redeploying.
       (local_date + make_interval(hours => hour_start)) AT TIME ZONE 'America/Chicago'
  FROM stg_hourly
    ON CONFLICT (account, meter, local_date, hour_start) DO UPDATE
   SET kwh = EXCLUDED.kwh, ts = EXCLUDED.ts, updated_at = now()
    -- Skip no-op writes so updated_at stays meaningful as "when did this value
    -- last actually change".
 WHERE hourly_usage.kwh IS DISTINCT FROM EXCLUDED.kwh;

INSERT INTO daily_usage (account, meter, local_date, kwh)
SELECT account, meter, local_date, kwh FROM stg_daily
    ON CONFLICT (account, meter, local_date) DO UPDATE
   SET kwh = EXCLUDED.kwh, updated_at = now()
 WHERE daily_usage.kwh IS DISTINCT FROM EXCLUDED.kwh;

INSERT INTO billing_period (account, meter, period_start, period_end, kwh, amount_usd)
SELECT account, meter, period_start, period_end, kwh, amount_usd FROM stg_billing
    ON CONFLICT (account, meter, period_start) DO UPDATE
   SET period_end = EXCLUDED.period_end, kwh = EXCLUDED.kwh,
       amount_usd = EXCLUDED.amount_usd, updated_at = now()
 WHERE (billing_period.kwh, billing_period.amount_usd)
        IS DISTINCT FROM (EXCLUDED.kwh, EXCLUDED.amount_usd);

INSERT INTO collector_run (hourly_rows, daily_rows, billing_rows)
SELECT (SELECT count(*) FROM stg_hourly),
       (SELECT count(*) FROM stg_daily),
       (SELECT count(*) FROM stg_billing);

-- Blended $/kWh per billing period, spread back over the hours it covers, so
-- hourly usage can be costed. Alliant bills on read-to-read periods that do not
-- align to months, which is exactly the join SQL makes easy and PromQL does not.
CREATE OR REPLACE VIEW hourly_usage_cost AS
SELECT h.account, h.meter, h.ts, h.local_date, h.hour_start, h.kwh,
       b.amount_usd / NULLIF(b.kwh, 0)               AS rate_usd_per_kwh,
       h.kwh * (b.amount_usd / NULLIF(b.kwh, 0))     AS cost_usd
  FROM hourly_usage h
  LEFT JOIN billing_period b
    ON b.account = h.account AND b.meter = h.meter
   AND h.local_date > b.period_start AND h.local_date <= b.period_end;

-- Grafana reads through the shared hand-made `grafanareader` role against the
-- prod-pg17-ro replica, so it needs SELECT here. Done on every run rather than
-- once by hand: it is idempotent, and it means a table added later is readable
-- without anyone remembering to re-grant.
--
-- Guarded because the role is not managed by this repo (or by CNPG) -- if it is
-- ever absent, the collector should still load data rather than abort the whole
-- transaction on a missing grantee.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafanareader') THEN
    GRANT CONNECT ON DATABASE energy TO grafanareader;
    GRANT USAGE ON SCHEMA public TO grafanareader;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafanareader;
    -- Covers tables and views created by future runs of this script.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafanareader;
  END IF;
END
$$;
