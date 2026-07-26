#!/usr/bin/env python3
"""Thin NetBox REST API client for the homelab instance.

Auth comes from $NETBOX_TOKEN; base URL from $NETBOX_URL
(default https://netbox.cmdcentral.xyz). Stdlib only, no deps.

  nb.py get    dcim/devices role=disk --fields id,serial,device_type.model
  nb.py get    dcim/devices/102
  nb.py post   dcim/devices '{"name": ..., "device_type": 17, ...}'
  nb.py patch  dcim/device-bays/33 '{"installed_device": 102}'
  nb.py delete dcim/devices/102
  nb.py bays   nas-shelf01
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, NoReturn

BASE = os.environ.get("NETBOX_URL", "https://netbox.cmdcentral.xyz").rstrip("/")
TOKEN = os.environ.get("NETBOX_TOKEN")


def die(msg: str, code: int = 1) -> NoReturn:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def request(method: str, endpoint: str, params=None, body=None) -> Any:
    """Call the API. `endpoint` is a path under /api/, e.g. 'dcim/devices'."""
    path = endpoint.strip("/")
    # NetBox requires the trailing slash; detail routes end in an id.
    url = f"{BASE}/api/{path}/"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)

    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Token {TOKEN}")
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.dumps(json.loads(detail), indent=2)
        except json.JSONDecodeError:
            pass
        die(f"{method} {url} -> HTTP {e.code}\n{detail}", 2)
    except urllib.error.URLError as e:
        die(f"cannot reach {url}: {e.reason}", 3)


def paginate(endpoint: str, params: dict):
    """Follow `next` links until the result set is exhausted."""
    params = dict(params)
    params.setdefault("limit", 200)
    results = []
    offset = 0
    while True:
        params["offset"] = offset
        page = request("GET", endpoint, params=params)
        results.extend(page["results"])
        if not page.get("next") or len(results) >= page["count"]:
            return results
        offset = len(results)


def dig(obj, dotted: str):
    """Resolve 'device_type.manufacturer.name' against nested dicts."""
    for part in dotted.split("."):
        if obj is None:
            return None
        obj = obj.get(part) if isinstance(obj, dict) else None
    return obj


def project(records, fields):
    return [{f: dig(r, f) for f in fields} for r in records]


def emit(payload) -> None:
    print(json.dumps(payload, indent=2, sort_keys=False))


def resolve_device(ref: str) -> Any:
    """Accept a device id or an exact device name."""
    if ref.isdigit():
        return request("GET", f"dcim/devices/{ref}")
    hits = request("GET", "dcim/devices", params={"name": ref})["results"]
    if not hits:
        die(f"no device named {ref!r}")
    if len(hits) > 1:
        die(f"{ref!r} matches {len(hits)} devices; use an id")
    return hits[0]


def main(argv: list[str]) -> None:
    if not TOKEN:
        die("NETBOX_TOKEN is not set in the environment")
    if not argv:
        die((__doc__ or "").strip(), 64)

    cmd, rest = argv[0], argv[1:]

    if cmd == "bays":
        if not rest:
            die("usage: nb.py bays <device-name-or-id>")
        dev = resolve_device(rest[0])
        bays = paginate("dcim/device-bays", {"device_id": dev["id"]})
        emit(
            [
                {
                    "bay_id": b["id"],
                    "name": b["name"],
                    "label": b["label"],
                    "installed_device_id": dig(b, "installed_device.id"),
                    "installed": dig(b, "installed_device.display"),
                }
                for b in bays
            ]
        )
        return

    if cmd not in {"get", "post", "patch", "put", "delete"}:
        die(f"unknown command {cmd!r}")
    if not rest:
        die(f"usage: nb.py {cmd} <endpoint> ...")

    endpoint, rest = rest[0], rest[1:]

    fields = None
    if "--fields" in rest:
        i = rest.index("--fields")
        try:
            fields = [f.strip() for f in rest[i + 1].split(",")]
        except IndexError:
            die("--fields needs a comma-separated list")
        rest = rest[:i] + rest[i + 2 :]

    if cmd == "get":
        params = {}
        for arg in rest:
            if "=" not in arg:
                die(f"filters must be key=value, got {arg!r}")
            k, v = arg.split("=", 1)
            params.setdefault(k, []).append(v)
        # A detail route (…/102) returns a bare object, not a paginated list.
        if endpoint.strip("/").split("/")[-1].isdigit():
            result = request("GET", endpoint, params=params)
            emit(project([result], fields)[0] if fields else result)
        else:
            records = paginate(endpoint, params)
            emit(project(records, fields) if fields else records)
        return

    if cmd == "delete":
        request("DELETE", endpoint)
        print(f"deleted {endpoint}")
        return

    if not rest:
        die(f"{cmd} needs a JSON body")
    try:
        body = json.loads(rest[0])
    except json.JSONDecodeError as e:
        die(f"body is not valid JSON: {e}")
    emit(request(cmd.upper(), endpoint, body=body))


if __name__ == "__main__":
    main(sys.argv[1:])
