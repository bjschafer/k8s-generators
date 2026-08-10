-- Alliant residential rate model, applied to real hourly usage.
--
-- Alliant's hourly feed carries no price at all -- the only money in the API is
-- a total per billing period. So to answer "what did this hour cost" (and, more
-- usefully, "what would it have cost on another plan") the tariff has to be
-- modelled here.
--
-- The account is on RD1 (Peak Nights and Weekends). RG5 and RG1 are carried too
-- so the plans can be compared against the same real usage, which is the only
-- honest way to judge whether the switch was worth it.
--
-- IMPORTANT: while Alliant has not actually moved billing over yet (tier_tou is
-- still empty in the feed), everything here is a *projection*. Once real tiers
-- start arriving, billing_period stays the source of truth for what was charged
-- and this stays the model of what should have been.

CREATE TABLE IF NOT EXISTS tou_plan (
  plan                 text PRIMARY KEY,
  description          text          NOT NULL,
  is_flat              boolean       NOT NULL,
  monthly_customer_usd numeric(10,2) NOT NULL,
  -- Charged on the highest demand seen in the window, not on energy. Only RD1
  -- has one, and it is the main reason RD1's per-kWh prices undercut RG5's.
  demand_usd_per_kw    numeric(10,2) NOT NULL DEFAULT 0
);

INSERT INTO tou_plan (plan, description, is_flat, monthly_customer_usd, demand_usd_per_kw) VALUES
  ('RD1', 'Peak Nights and Weekends (Residential Demand Service) -- current plan', false, 10.00, 5.88),
  ('RG5', 'Nights and Weekends (Residential Service Electric TOD)',                false, 15.00, 0.00),
  ('RG1', 'Residential Electric Service (flat)',                                   true,  15.00, 0.00)
ON CONFLICT (plan) DO UPDATE
   SET description = EXCLUDED.description, is_flat = EXCLUDED.is_flat,
       monthly_customer_usd = EXCLUDED.monthly_customer_usd,
       demand_usd_per_kw = EXCLUDED.demand_usd_per_kw;

CREATE TABLE IF NOT EXISTS tou_price (
  plan        text NOT NULL REFERENCES tou_plan(plan),
  period      text NOT NULL,               -- low | regular | high | flat
  usd_per_kwh numeric(10,4) NOT NULL,
  PRIMARY KEY (plan, period)
);

INSERT INTO tou_price (plan, period, usd_per_kwh) VALUES
  ('RD1', 'low', 0.09), ('RD1', 'regular', 0.18), ('RD1', 'high', 0.26),
  ('RG5', 'low', 0.10), ('RG5', 'regular', 0.21), ('RG5', 'high', 0.30),
  ('RG1', 'flat', 0.17)
ON CONFLICT (plan, period) DO UPDATE SET usd_per_kwh = EXCLUDED.usd_per_kwh;

-- Weekends AND holidays bill at the low rate all day, so the holiday list is
-- rate-affecting, not decoration. Only holidays landing on a weekday actually
-- change anything -- a weekend is already low.
--
-- ASSUMPTION: the six holidays Alliant's residential TOD rate normally lists.
-- The footnote on the rate sheet was not legible, so this is worth confirming;
-- getting it wrong misprices at most a handful of days a year.
CREATE TABLE IF NOT EXISTS tou_holiday (
  day         date PRIMARY KEY,
  name        text NOT NULL,
  is_observed boolean NOT NULL DEFAULT false   -- shifted off a weekend
);

DO $$
DECLARE
  y   int;
  d   date;
  obs date;
BEGIN
  FOR y IN 2024..2035 LOOP
    -- Fixed-date holidays, shifted to the nearest weekday when they land on a
    -- weekend (Sat -> Fri, Sun -> Mon), which is how observed holidays work.
    FOR d IN SELECT unnest(ARRAY[make_date(y,1,1), make_date(y,7,4), make_date(y,12,25)]) LOOP
      obs := CASE extract(isodow FROM d)
               WHEN 6 THEN d - 1
               WHEN 7 THEN d + 1
               ELSE d
             END;
      INSERT INTO tou_holiday (day, name, is_observed)
      VALUES (obs,
              CASE to_char(d, 'MM-DD')
                WHEN '01-01' THEN 'New Year''s Day'
                WHEN '07-04' THEN 'Independence Day'
                ELSE 'Christmas Day'
              END,
              obs <> d)
      ON CONFLICT (day) DO NOTHING;
    END LOOP;

    -- Memorial Day: last Monday in May.
    INSERT INTO tou_holiday (day, name)
    SELECT max(g)::date, 'Memorial Day'
      FROM generate_series(make_date(y,5,1), make_date(y,5,31), '1 day') g
     WHERE extract(isodow FROM g) = 1
    ON CONFLICT (day) DO NOTHING;

    -- Labor Day: first Monday in September.
    INSERT INTO tou_holiday (day, name)
    SELECT min(g)::date, 'Labor Day'
      FROM generate_series(make_date(y,9,1), make_date(y,9,30), '1 day') g
     WHERE extract(isodow FROM g) = 1
    ON CONFLICT (day) DO NOTHING;

    -- Thanksgiving: fourth Thursday in November.
    INSERT INTO tou_holiday (day, name)
    SELECT (array_agg(g ORDER BY g))[4]::date, 'Thanksgiving'
      FROM generate_series(make_date(y,11,1), make_date(y,11,30), '1 day') g
     WHERE extract(isodow FROM g) = 4
    ON CONFLICT (day) DO NOTHING;
  END LOOP;
END
$$;

-- Which rate window an hour falls in. Hours are period-start (hour_start = 6
-- means 06:00-07:00), so "6-11 a.m." is hours 6..10 inclusive. Each branch
-- covers all 24 hours exactly once.
CREATE OR REPLACE FUNCTION tou_period_for(p_month int, p_offpeak_day boolean, p_hour int)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    -- Weekends and holidays: low all day, every season.
    WHEN p_offpeak_day THEN 'low'
    -- Jun/Jul/Aug weekdays: 6-11a regular, 11a-7p high, 7-11p regular, 11p-6a low.
    WHEN p_month IN (6,7,8) THEN
      CASE WHEN p_hour BETWEEN 6 AND 10  THEN 'regular'
           WHEN p_hour BETWEEN 11 AND 18 THEN 'high'
           WHEN p_hour BETWEEN 19 AND 22 THEN 'regular'
           ELSE 'low' END
    -- Jan/Feb/Dec weekdays: 6a-5p regular, 5-9p high, 9-11p regular, 11p-6a low.
    WHEN p_month IN (1,2,12) THEN
      CASE WHEN p_hour BETWEEN 6 AND 16  THEN 'regular'
           WHEN p_hour BETWEEN 17 AND 20 THEN 'high'
           WHEN p_hour BETWEEN 21 AND 22 THEN 'regular'
           ELSE 'low' END
    -- Shoulder months: no high window at all, 6a-11p regular, 11p-6a low.
    ELSE
      CASE WHEN p_hour BETWEEN 6 AND 22 THEN 'regular' ELSE 'low' END
  END;
$$;

-- Drops a view or materialized view by name whichever it currently is. Needed
-- because DROP VIEW and DROP MATERIALIZED VIEW each raise if the name exists as
-- the other kind -- precisely what happens on a deploy that converts one to the
-- other, which would wedge the load for everyone after.
CREATE OR REPLACE FUNCTION drop_relation_any_kind(p_name text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE k "char";
BEGIN
  SELECT relkind INTO k FROM pg_class
   WHERE relname = p_name AND relnamespace = 'public'::regnamespace;
  IF    k = 'v' THEN EXECUTE format('DROP VIEW %I', p_name);
  ELSIF k = 'm' THEN EXECUTE format('DROP MATERIALIZED VIEW %I', p_name);
  END IF;
END
$fn$;

-- Every hour of usage priced under every plan. One row per (hour, plan), which
-- is what makes a like-for-like plan comparison a plain GROUP BY.
--
-- MATERIALIZED deliberately. As a plain view the planner re-evaluated it once
-- per billing period inside bill_estimate and the aggregate took over 90s; as a
-- table it is ~37k rows built once a day and every dashboard query is instant.
-- The data only changes when the collector runs, so there is nothing to gain
-- from computing it per query.
SELECT drop_relation_any_kind('bill_estimate');
SELECT drop_relation_any_kind('billing_day');
SELECT drop_relation_any_kind('demand_estimate');
SELECT drop_relation_any_kind('hourly_usage_priced');
CREATE MATERIALIZED VIEW hourly_usage_priced AS
SELECT h.account, h.meter, h.ts, h.local_date, h.hour_start, h.kwh,
       pl.plan,
       d.is_offpeak_day,
       CASE WHEN pl.is_flat THEN 'flat'
            ELSE tou_period_for(extract(month FROM h.local_date)::int, d.is_offpeak_day, h.hour_start)
       END AS period,
       pr.usd_per_kwh,
       h.kwh * pr.usd_per_kwh AS energy_cost_usd
  FROM hourly_usage h
 CROSS JOIN tou_plan pl
  JOIN LATERAL (
    SELECT (extract(isodow FROM h.local_date) >= 6
            OR EXISTS (SELECT 1 FROM tou_holiday x WHERE x.day = h.local_date)) AS is_offpeak_day
  ) d ON true
  JOIN tou_price pr
    ON pr.plan = pl.plan
   AND pr.period = CASE WHEN pl.is_flat THEN 'flat'
                        ELSE tou_period_for(extract(month FROM h.local_date)::int, d.is_offpeak_day, h.hour_start)
                   END;

CREATE INDEX hourly_usage_priced_plan_date_idx ON hourly_usage_priced (plan, local_date);
CREATE INDEX hourly_usage_priced_ts_idx         ON hourly_usage_priced (ts);

-- Demand charge basis: the single highest hour on nonholiday weekdays between
-- 10:00 and 20:00, per billing period.
--
-- APPROXIMATE, and biased low. Utilities meter demand over 15- or 30-minute
-- intervals; averaging a whole hour flattens exactly the short spikes a demand
-- charge is meant to catch. Treat this as a floor on the real charge.
CREATE VIEW demand_estimate AS
SELECT b.account, b.meter, b.period_start, b.period_end,
       max(h.kwh) AS peak_kw_est
  FROM billing_period b
  JOIN hourly_usage h
    ON h.account = b.account AND h.meter = b.meter
   AND h.local_date > b.period_start AND h.local_date <= b.period_end
 WHERE h.hour_start BETWEEN 10 AND 19
   AND extract(isodow FROM h.local_date) < 6
   AND NOT EXISTS (SELECT 1 FROM tou_holiday x WHERE x.day = h.local_date)
 GROUP BY 1, 2, 3, 4;

-- Modelled all-in bill per plan per billing period: energy + demand + the fixed
-- monthly charge. Comparable to billing_period.amount_usd, which is what was
-- actually charged.
-- One row per (billing period, day). Exists purely so the aggregates below can
-- join on date *equality*: joining hourly rows to periods on a range predicate
-- forces a nested loop that re-evaluates the priced view once per period, which
-- took bill_estimate from milliseconds to over 90 seconds.
CREATE VIEW billing_day AS
SELECT b.account, b.meter, b.period_start, b.period_end, d.day::date AS local_date
  FROM billing_period b
  JOIN LATERAL generate_series(b.period_start + 1, b.period_end, interval '1 day') d(day) ON true
 WHERE b.tier_tou = '';

CREATE MATERIALIZED VIEW bill_estimate AS
SELECT p.account, p.meter, bd.period_start, bd.period_end, p.plan,
       sum(p.energy_cost_usd)                                      AS energy_usd,
       coalesce(max(d.peak_kw_est), 0) * max(pl.demand_usd_per_kw)  AS demand_usd,
       max(pl.monthly_customer_usd)                                AS customer_usd,
       sum(p.energy_cost_usd)
         + coalesce(max(d.peak_kw_est), 0) * max(pl.demand_usd_per_kw)
         + max(pl.monthly_customer_usd)                            AS total_usd,
       sum(p.kwh)                                                  AS kwh
  FROM hourly_usage_priced p
  JOIN billing_day bd
    ON bd.account = p.account AND bd.meter = p.meter AND bd.local_date = p.local_date
  JOIN tou_plan pl ON pl.plan = p.plan
  LEFT JOIN demand_estimate d
    ON d.account = p.account AND d.meter = p.meter AND d.period_start = bd.period_start
 GROUP BY 1, 2, 3, 4, 5;

-- Grafana reads these through grafanareader; the grant block in load.sql runs
-- before these views exist on a fresh database, so re-grant here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafanareader') THEN
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafanareader;
  END IF;
END
$$;
