#!/usr/bin/env python3
"""Fetch electric usage from Alliant Energy's MyAccount API and write CSVs.

Alliant's portal is a Smart Energy Water ("smartcmobile") deployment. The web UI
drives a plain JSON API, so there is nothing to scrape and no browser needed:

  1. POST Login/auth -> accessToken (valid ~30 min)
  2. GET  Addresses/User/{uuid} -> account + premise numbers
  3. POST Usages/GetMeterAndPremise -> meter numbers
  4. GET  UsageAPI/api/V1/Electric -> usage at MO / DA / HH granularity

Two quirks of that API are load-bearing here:

* The `RecaptchaToken` header and the whole SendTfa/VerifyTfa dance are enforced
  only in the browser. The token minted by Login/auth -- before any 2FA -- is the
  same token that authorizes every data call, so this runs unattended.
* `readDate` carries a nonsense `+01:00` offset. The values are really local wall
  time, so we emit naive local date/hour and let Postgres do the conversion. That
  keeps a tzdata dependency out of this image and, more importantly, keeps the
  local-day grouping exact across DST transitions.

Output is CSV rather than direct SQL because the loader ingests via \\copy into a
staging table: no string escaping, and therefore no injection surface from
values we do not control.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from typing import Any, Iterable

BASE = "https://alliant-svc.smartcmobile.com"

# Cloudflare fronts this API and rejects requests that do not look like the
# portal, so the portal's Origin/Referer/UA are required, not cosmetic.
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0"
BASE_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://myaccount.alliantenergy.com",
    "Referer": "https://myaccount.alliantenergy.com/",
}

# Earliest date worth asking for. The API simply returns nothing before service
# start, so an over-wide floor is free -- it just makes backfill self-healing.
DEFAULT_START = "2024-01-01"

TIMEOUT = 60
RETRIES = 4


def log(msg: str) -> None:
    print(msg, flush=True)


def request(
    method: str,
    path: str,
    *,
    body: Any = None,
    headers: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
) -> Any:
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)

    hdrs = dict(BASE_HEADERS)
    hdrs.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"

    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            # 4xx is a real answer (bad credentials, bad range) -- do not retry it.
            if isinstance(exc, urllib.error.HTTPError) and 400 <= exc.code < 500:
                raise
            last = exc
            if attempt < RETRIES - 1:
                backoff = 2**attempt
                log(f"  request failed ({exc}); retrying in {backoff}s")
                time.sleep(backoff)
    raise RuntimeError(f"{method} {path} failed after {RETRIES} attempts: {last}")


def login(username: str, password: str) -> tuple[str, str]:
    """Return (accessToken, uuid). Deliberately skips 2FA -- see module docstring."""
    resp = request(
        "POST",
        "/UsermanagementAPI/api/1/Login/auth",
        body={
            "username": username,
            "password": password,
            "guestToken": "",
            "customattributes": {
                "ip": "",
                "client": "Web",
                "version": "10.15",
                "deviceId": "||Firefox||140||Mac OS X||10.15||",
                "deviceName": "Firefox",
                "deviceType": 0,
                "os": "Mac OS X",
            },
        },
        headers={"ST": "PL", "uid": "1"},
    )
    status = resp.get("status", {})
    if status.get("error") or "data" not in resp:
        raise SystemExit(f"login failed: {status.get('message', resp)}")
    return resp["data"]["accessToken"], resp["data"]["user"]["uuid"]


def usage(auth: dict[str, str], account: str, meter: str, frm: str, to: str, per: str) -> list[dict]:
    resp = request(
        "GET",
        "/UsageAPI/api/V1/Electric",
        headers=auth,
        params={
            "AccountNumber": account,
            "MeterNumber": meter,
            "From": frm,
            "To": to,
            "Uom": "kWh",
            "Periodicity": per,
        },
    )
    return (resp.get("Result") or {}).get("electricUsages") or []


def hour_start(read_date: str) -> tuple[str, int]:
    """Map an hour-*ending* label to (local_date, hour-beginning 0-23).

    Alliant labels each interval by the hour it ends: 01:00 is midnight->1am, and
    24:00 is written as 00:00 on the *same* date. Storing by period start is both
    what Grafana bar charts read naturally and what Home Assistant statistics
    expect, so shift back one hour here.
    """
    day, clock = read_date[:10], read_date[11:13]
    hour = int(clock)
    return day, (hour - 1) if hour >= 1 else 23


def collect(auth: dict[str, str], account: str, meter: str, start: str, end: str):
    """Fetch all three granularities for one meter.

    The whole history comes back in one request per granularity (~12k hourly rows
    for 17 months), so there is no paging and no incremental state to corrupt --
    every run re-fetches everything and upserts.
    """
    hourly: dict[tuple[str, int], float] = {}
    # Duplicate hour rows appear on days the utility re-read the meter. They are
    # byte-identical repeats, so last-wins is right; summing them double-counts
    # (verified against the daily series: dedup matches to 0.04% over 17 months,
    # keeping duplicates overshoots by ~78 kWh).
    dupes = 0
    for row in usage(auth, account, meter, f"{start} 00:00:01", f"{end} 00:00:00", "HH"):
        key = hour_start(row["readDate"])
        if key in hourly:
            dupes += 1
        hourly[key] = float(row["consumption"])

    daily = {r["readDate"][:10]: float(r["consumption"]) for r in usage(auth, account, meter, start, end, "DA")}

    billing = [
        {
            "period_start": r["readingFrom"][:10],
            "period_end": r["readingTo"][:10],
            "kwh": float(r["consumption"]),
            "amount_usd": float(r["amount"] or 0),
        }
        for r in usage(auth, account, meter, start, end, "MO")
        # Monthly rows are keyed by billing period; anything without a real
        # period is a placeholder row the portal ignores too.
        if r.get("readingFrom", "").startswith("2")
    ]

    log(f"  meter {meter}: {len(hourly)} hourly ({dupes} dupes dropped), {len(daily)} daily, {len(billing)} billing")
    return hourly, daily, billing


def write_csv(path: str, header: Iterable[str], rows: Iterable[Iterable]) -> int:
    n = 0
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        for row in rows:
            w.writerow(row)
            n += 1
    return n


def main() -> int:
    username = os.environ["ALLIANT_USERNAME"]
    password = os.environ["ALLIANT_PASSWORD"]
    out_dir = os.environ.get("OUT_DIR", "/data")
    start = os.environ.get("ALLIANT_START_DATE", DEFAULT_START)
    # Data lags ~4 days behind real time; ask a week past today so the tail is
    # always included and late-arriving reads get corrected on the next run.
    end = (date.today() + timedelta(days=7)).isoformat()

    log(f"fetching {start} .. {end}")
    token, uuid = login(username, password)
    auth = {"Authorization": f"Bearer {token}", "uid": "2", "pt": "1"}
    log("authenticated (no 2FA required)")

    addresses = request("GET", f"/Services/api/1/Addresses/User/{uuid}", headers=auth).get("data") or []
    if not addresses:
        raise SystemExit("no accounts returned for this login")

    hourly_rows, daily_rows, billing_rows = [], [], []
    for addr in addresses:
        acct, premise = addr["accountNumber"], addr["premiseNumber"]
        log(f"account {acct} (premise {premise})")

        meters = request(
            "POST",
            "/Services/api/1/Usages/GetMeterAndPremise",
            body={"accountNumber": acct, "premiseNumber": premise},
            headers=auth,
        ).get("data") or []
        # The same meter is listed once per service period; usage is keyed by
        # meter number alone, so collapse them or we fetch identical data twice.
        for meter in sorted({m["meterNumber"] for m in meters}):
            # Usage endpoints want the composite "premise-account" form.
            hourly, daily, billing = collect(auth, f"{premise}-{acct}", meter, start, end)
            hourly_rows += [(acct, meter, d, h, v) for (d, h), v in sorted(hourly.items())]
            daily_rows += [(acct, meter, d, v) for d, v in sorted(daily.items())]
            billing_rows += [
                (acct, meter, b["period_start"], b["period_end"], b["kwh"], b["amount_usd"]) for b in billing
            ]

    if not hourly_rows:
        raise SystemExit("no hourly usage returned -- refusing to signal success")

    n_h = write_csv(f"{out_dir}/hourly.csv", ("account", "meter", "local_date", "hour_start", "kwh"), hourly_rows)
    n_d = write_csv(f"{out_dir}/daily.csv", ("account", "meter", "local_date", "kwh"), daily_rows)
    n_b = write_csv(
        f"{out_dir}/billing.csv",
        ("account", "meter", "period_start", "period_end", "kwh", "amount_usd"),
        billing_rows,
    )
    log(f"wrote {n_h} hourly, {n_d} daily, {n_b} billing rows to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
