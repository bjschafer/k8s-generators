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
  -- Empty on a flat-rate account. In the key because under time-of-use one hour
  -- can return several rows, one per tier, and keying on the hour alone would
  -- collapse them. '' not NULL, since a key column cannot be NULL.
  tier_tou   text             NOT NULL DEFAULT '',
  rate_plan  text             NOT NULL DEFAULT '',
  kwh        double precision NOT NULL,
  ts         timestamptz      NOT NULL,
  updated_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (account, meter, local_date, hour_start, tier_tou)
);
CREATE INDEX IF NOT EXISTS hourly_usage_ts_idx ON hourly_usage (ts);

CREATE TABLE IF NOT EXISTS daily_usage (
  account    text             NOT NULL,
  meter      text             NOT NULL,
  local_date date             NOT NULL,
  tier_tou   text             NOT NULL DEFAULT '',
  rate_plan  text             NOT NULL DEFAULT '',
  kwh        double precision NOT NULL,
  updated_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (account, meter, local_date, tier_tou)
);

-- One row per billing period. `amount_usd` is what makes cost analysis possible
-- at all; the hourly feed carries no price.
CREATE TABLE IF NOT EXISTS billing_period (
  account      text             NOT NULL,
  meter        text             NOT NULL,
  period_start date             NOT NULL,
  period_end   date             NOT NULL,
  tier_tou     text             NOT NULL DEFAULT '',
  rate_plan    text             NOT NULL DEFAULT '',
  kwh          double precision NOT NULL,
  amount_usd   double precision NOT NULL,
  updated_at   timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (account, meter, period_start, tier_tou)
);

CREATE TABLE IF NOT EXISTS collector_run (
  id          bigserial PRIMARY KEY,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  hourly_rows integer     NOT NULL,
  daily_rows  integer     NOT NULL,
  billing_rows integer    NOT NULL
);

-- Migration for databases created before the time-of-use columns existed. The
-- CREATE TABLE statements above only fire on an empty database, so bringing an
-- existing one forward has to be explicit. Idempotent, so it is safe to leave
-- here permanently rather than running it once by hand and forgetting why.
ALTER TABLE hourly_usage   ADD COLUMN IF NOT EXISTS tier_tou  text NOT NULL DEFAULT '';
ALTER TABLE hourly_usage   ADD COLUMN IF NOT EXISTS rate_plan text NOT NULL DEFAULT '';
ALTER TABLE daily_usage    ADD COLUMN IF NOT EXISTS tier_tou  text NOT NULL DEFAULT '';
ALTER TABLE daily_usage    ADD COLUMN IF NOT EXISTS rate_plan text NOT NULL DEFAULT '';
ALTER TABLE billing_period ADD COLUMN IF NOT EXISTS tier_tou  text NOT NULL DEFAULT '';
ALTER TABLE billing_period ADD COLUMN IF NOT EXISTS rate_plan text NOT NULL DEFAULT '';

-- Widen each primary key to include the tier. Without this a time-of-use hour
-- that arrives as several tier rows would upsert over itself and only the last
-- tier would survive -- silent, and invisible until a bill disagreed.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('hourly_usage',   'account, meter, local_date, hour_start, tier_tou'),
      ('daily_usage',    'account, meter, local_date, tier_tou'),
      ('billing_period', 'account, meter, period_start, tier_tou')
    ) AS v(tbl, cols)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
       WHERE i.indrelid = t.tbl::regclass AND i.indisprimary AND a.attname = 'tier_tou'
    ) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t.tbl, t.tbl || '_pkey');
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (%s)', t.tbl, t.cols);
      RAISE NOTICE 'widened primary key on % to include tier_tou', t.tbl;
    END IF;
  END LOOP;
END
$$;

CREATE TEMP TABLE stg_hourly (
  account text, meter text, local_date date, hour_start smallint,
  tier_tou text, rate_plan text, kwh double precision
) ON COMMIT DROP;
CREATE TEMP TABLE stg_daily (
  account text, meter text, local_date date,
  tier_tou text, rate_plan text, kwh double precision
) ON COMMIT DROP;
CREATE TEMP TABLE stg_billing (
  account text, meter text, period_start date, period_end date,
  tier_tou text, rate_plan text, kwh double precision, amount_usd double precision
) ON COMMIT DROP;

-- FORCE_NOT_NULL because CSV cannot distinguish an empty field from NULL, and
-- an absent time-of-use tier is legitimately the empty string -- it is part of
-- the primary key, so NULL is not an option.
\copy stg_hourly  FROM '/data/hourly.csv'  WITH (FORMAT csv, HEADER true, FORCE_NOT_NULL (tier_tou, rate_plan))
\copy stg_daily   FROM '/data/daily.csv'   WITH (FORMAT csv, HEADER true, FORCE_NOT_NULL (tier_tou, rate_plan))
\copy stg_billing FROM '/data/billing.csv' WITH (FORMAT csv, HEADER true, FORCE_NOT_NULL (tier_tou, rate_plan))

INSERT INTO hourly_usage (account, meter, local_date, hour_start, tier_tou, rate_plan, kwh, ts)
SELECT account, meter, local_date, hour_start, tier_tou, rate_plan, kwh,
       -- Naive local wall time -> instant. Postgres owns the tz database, so
       -- this stays correct across DST rule changes without redeploying.
       (local_date + make_interval(hours => hour_start)) AT TIME ZONE 'America/Chicago'
  FROM stg_hourly
    ON CONFLICT (account, meter, local_date, hour_start, tier_tou) DO UPDATE
   SET kwh = EXCLUDED.kwh, ts = EXCLUDED.ts,
       rate_plan = EXCLUDED.rate_plan, updated_at = now()
    -- Skip no-op writes so updated_at stays meaningful as "when did this value
    -- last actually change".
 WHERE (hourly_usage.kwh, hourly_usage.rate_plan)
        IS DISTINCT FROM (EXCLUDED.kwh, EXCLUDED.rate_plan);

INSERT INTO daily_usage (account, meter, local_date, tier_tou, rate_plan, kwh)
SELECT account, meter, local_date, tier_tou, rate_plan, kwh FROM stg_daily
    ON CONFLICT (account, meter, local_date, tier_tou) DO UPDATE
   SET kwh = EXCLUDED.kwh, rate_plan = EXCLUDED.rate_plan, updated_at = now()
 WHERE (daily_usage.kwh, daily_usage.rate_plan)
        IS DISTINCT FROM (EXCLUDED.kwh, EXCLUDED.rate_plan);

-- DISTINCT ON, not a bare SELECT: a duplicate period in the staging table makes
-- the upsert below fail with "ON CONFLICT DO UPDATE command cannot affect row a
-- second time", which aborts this transaction and so discards the hourly and
-- daily series too -- a whole day of data lost to one bad billing row. The
-- fetcher already drops the stub row that caused that, so this is the backstop
-- for the next shape of duplicate. Ordering picks the real period over a stub:
-- longest span first, then largest consumption.
INSERT INTO billing_period (account, meter, period_start, period_end, tier_tou, rate_plan, kwh, amount_usd)
SELECT account, meter, period_start, period_end, tier_tou, rate_plan, kwh, amount_usd
  FROM (
    SELECT DISTINCT ON (account, meter, period_start, tier_tou) *
      FROM stg_billing
     ORDER BY account, meter, period_start, tier_tou, period_end DESC, kwh DESC
  ) s
    ON CONFLICT (account, meter, period_start, tier_tou) DO UPDATE
   SET period_end = EXCLUDED.period_end, kwh = EXCLUDED.kwh,
       amount_usd = EXCLUDED.amount_usd, rate_plan = EXCLUDED.rate_plan, updated_at = now()
 WHERE (billing_period.kwh, billing_period.amount_usd, billing_period.rate_plan)
        IS DISTINCT FROM (EXCLUDED.kwh, EXCLUDED.amount_usd, EXCLUDED.rate_plan);

INSERT INTO collector_run (hourly_rows, daily_rows, billing_rows)
SELECT (SELECT count(*) FROM stg_hourly),
       (SELECT count(*) FROM stg_daily),
       (SELECT count(*) FROM stg_billing);

-- Blended $/kWh per billing period, spread back over the hours it covers, so
-- hourly usage can be costed. Alliant bills on read-to-read periods that do not
-- align to months, which is exactly the join SQL makes easy and PromQL does not.
-- Joining on tier as well as period is what makes this survive the switch to
-- time-of-use. Today every tier is '' so it is a no-op. Once tiers arrive, an
-- on-peak hour costs at the on-peak period's blended rate rather than at one
-- rate smeared across the whole bill -- and, just as importantly, the join
-- stops fanning out one hourly row across every tier row of its period, which
-- would multiply the cost by the number of tiers.
--
-- Still an approximation while a period has one tier: it spreads fixed charges
-- across kWh rather than modelling the tariff, so per-hour cost is indicative
-- and the period total is exact.
-- Dropped and recreated rather than CREATE OR REPLACE: replace can only append
-- columns, so any change to the column *order* fails against an existing view.
-- Safe because a view holds no data, and the grant block below re-grants it.
DROP VIEW IF EXISTS hourly_usage_cost;
CREATE VIEW hourly_usage_cost AS
SELECT h.account, h.meter, h.ts, h.local_date, h.hour_start, h.tier_tou, h.kwh,
       b.amount_usd / NULLIF(b.kwh, 0)               AS rate_usd_per_kwh,
       h.kwh * (b.amount_usd / NULLIF(b.kwh, 0))     AS cost_usd
  FROM hourly_usage h
  LEFT JOIN billing_period b
    ON b.account = h.account AND b.meter = h.meter
   AND b.tier_tou = h.tier_tou
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
