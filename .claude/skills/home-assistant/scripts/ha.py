#!/usr/bin/env python3
"""Home Assistant client for the homelab. Stdlib only.

Reads $HASS_ACCESS_TOKEN. Speaks REST for states/services/templates/automations and
raw websocket for anything registry- or dashboard-shaped (HA exposes those over ws only).

Run `ha.py` with no arguments for usage.
"""
from __future__ import annotations

import base64
import json
import os
import re
import socket
import ssl
import struct
import sys
import urllib.error
import urllib.request

URL = os.environ.get("HASS_URL", "https://hass.cmdcentral.xyz")
TOKEN = os.environ.get("HASS_ACCESS_TOKEN", "")


def die(msg: str, code: int = 1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


if not TOKEN:
    die("$HASS_ACCESS_TOKEN is not set")


# --------------------------------------------------------------------------- REST
def rest(path: str, method: str = "GET", body=None):
    req = urllib.request.Request(
        f"{URL}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        die(f"HTTP {e.code} on {method} {path}: {e.read().decode()[:400]}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


# ---------------------------------------------------------------------- websocket
class WS:
    """Minimal RFC6455 client. Enough for HA's JSON command/result protocol."""

    def __init__(self, url: str):
        m = re.match(r"(https?)://([^/:]+)(?::(\d+))?", url)
        if not m:
            die(f"cannot parse URL {url}")
        scheme, host, port = m.group(1), m.group(2), m.group(3)
        tls = scheme == "https"
        port = int(port) if port else (443 if tls else 80)
        sock = socket.create_connection((host, port), timeout=30)
        if tls:
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        self.sock = sock
        self.buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        sock.sendall(
            f"GET /api/websocket HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        while b"\r\n\r\n" not in self.buf:
            self._fill()
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        if b"101" not in head.split(b"\r\n")[0]:
            die(f"websocket handshake failed: {head.decode(errors='replace')[:200]}")

    def _fill(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            die("websocket closed by server")
        self.buf += chunk

    def _read(self, n: int) -> bytes:
        while len(self.buf) < n:
            self._fill()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, obj):
        payload = json.dumps(obj).encode()
        header = bytearray([0x81])  # FIN + text
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv(self):
        """Return the next complete text message, reassembling continuation frames."""
        data = b""
        while True:
            b0, b1 = self._read(2)
            opcode, fin, masked, n = b0 & 0x0F, b0 & 0x80, b1 & 0x80, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if masked else b""
            payload = self._read(n)
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:  # ping -> pong
                self.sock.sendall(b"\x8a\x80" + os.urandom(4))
                continue
            if opcode == 0x8:  # close
                die("websocket closed by server")
            if opcode == 0xA:  # pong
                continue
            data += payload
            if fin:
                return json.loads(data.decode())


def ws_cmds(cmds: list[dict]) -> list[dict]:
    """Authenticate, run commands in order, return their result messages."""
    ws = WS(URL)
    hello = ws.recv()
    if hello.get("type") != "auth_required":
        die(f"unexpected greeting: {hello}")
    ws.send({"type": "auth", "access_token": TOKEN})
    if (auth := ws.recv()).get("type") != "auth_ok":
        die(f"auth failed: {auth}")
    out = []
    for i, cmd in enumerate(cmds, start=1):
        ws.send({"id": i, **cmd})
        while True:
            msg = ws.recv()
            if msg.get("id") == i and msg.get("type") == "result":
                break
        if not msg.get("success"):
            die(f"ws command {cmd.get('type')} failed: {msg.get('error')}")
        out.append(msg.get("result"))
    return out


def ws_one(cmd_type: str, **kw):
    return ws_cmds([{"type": cmd_type, **kw}])[0]


# ----------------------------------------------------------------------- commands
def out(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def cmd_states(args):
    """states [substring] — one line per entity: id, state, unit."""
    pat = args[0] if args else ""
    for e in rest("/api/states"):
        if pat in e["entity_id"]:
            unit = e["attributes"].get("unit_of_measurement", "")
            print(f"{e['entity_id']:70} {str(e['state'])[:40]:42} {unit}")


def cmd_get(args):
    """get <entity_id> — full state JSON including attributes."""
    out(rest(f"/api/states/{args[0]}"))


def cmd_call(args):
    """call <domain.service> [json] — e.g. call light.turn_on '{"entity_id":"light.x"}'"""
    domain, service = args[0].split(".", 1)
    body = json.loads(args[1]) if len(args) > 1 else {}
    out(rest(f"/api/services/{domain}/{service}", "POST", body))


def cmd_template(args):
    """template ['<jinja>'] — renders against live state; reads stdin if omitted."""
    tpl = args[0] if args else sys.stdin.read()
    print(rest("/api/template", "POST", {"template": tpl}))


def cmd_ws(args):
    """ws <type> [json] — raw websocket command."""
    kw = json.loads(args[1]) if len(args) > 1 else {}
    out(ws_one(args[0], **kw))


def cmd_entity(args):
    """entity <entity_id> [json] — show registry entry, or update it with the given fields."""
    if len(args) > 1:
        out(ws_one("config/entity_registry/update", entity_id=args[0], **json.loads(args[1])))
    else:
        out(ws_one("config/entity_registry/get", entity_id=args[0]))


def cmd_device(args):
    """device <device_id|name-substring> [json] — list/show devices, or update one."""
    if len(args) > 1 and args[1].startswith("{"):
        out(ws_one("config/device_registry/update", device_id=args[0], **json.loads(args[1])))
        return
    pat = args[0].lower() if args else ""
    for d in ws_one("config/device_registry/list"):
        name = d.get("name_by_user") or d.get("name") or ""
        if pat in d["id"].lower() or pat in name.lower():
            print(f"{d['id']}  {name:40.40} {d.get('model') or '':24.24} {d.get('manufacturer') or ''}")


def cmd_dash_get(args):
    """dash-get <url_path> — dump a storage dashboard's config as JSON."""
    out(ws_one("lovelace/config", url_path=args[0]))


def cmd_dash_save(args):
    """dash-save <url_path> <file.json> — replace a dashboard's config. Validate first."""
    cfg = json.load(open(args[1]))
    ws_one("lovelace/config/save", url_path=args[0], config=cfg)
    print(f"saved {args[1]} -> dashboard '{args[0]}'")


def cmd_dash_list(args):
    """dash-list — storage dashboards and their url_paths."""
    for d in ws_one("lovelace/dashboards/list"):
        print(f"{d['url_path']:24} {d.get('title'):24} sidebar={d.get('show_in_sidebar')}")


def cmd_dash_create(args):
    """dash-create <url_path> <title> [icon] — single-word url_path is allowed."""
    out(ws_one("lovelace/dashboards/create", url_path=args[0], title=args[1],
               icon=args[2] if len(args) > 2 else "mdi:view-dashboard",
               show_in_sidebar=True, require_admin=False, allow_single_word=True))


def cmd_automation_put(args):
    """automation-put <id> <file.json> — writes automations.yaml and reloads."""
    cfg = json.load(open(args[1]))
    out(rest(f"/api/config/automation/config/{args[0]}", "POST", cfg))


def cmd_automation_del(args):
    """automation-del <id> — delete from automations.yaml and reload."""
    out(rest(f"/api/config/automation/config/{args[0]}", "DELETE"))


def _dash_types(cfg):
    """Classify every `type:` in a dashboard config by where it appears."""
    cards, features, other = set(), set(), set()

    def walk_card(c):
        if not isinstance(c, dict):
            return
        if isinstance(c.get("type"), str):
            cards.add(c["type"])
        for f in c.get("features") or []:
            if isinstance(f, dict) and isinstance(f.get("type"), str):
                features.add(f["type"])
        for key in ("cards", "card", "elements", "sections"):
            v = c.get(key)
            for sub in (v if isinstance(v, list) else [v] if v else []):
                walk_card(sub)

    for view in cfg.get("views", []):
        if isinstance(view.get("type"), str):
            other.add(view["type"])
        for sec in view.get("sections", []) or []:
            if isinstance(sec.get("type"), str):
                other.add(sec["type"])
            for c in sec.get("cards", []) or []:
                walk_card(c)
        for c in view.get("cards", []) or []:
            walk_card(c)
    return cards, features, other


def cmd_check_dash(args):
    """check-dash <url_path> — verify every entity ref resolves; list card/feature types."""
    cfg = ws_one("lovelace/config", url_path=args[0])
    live = {e["entity_id"] for e in rest("/api/states")}
    refs = set()

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ("entity", "image_entity", "camera_image") and isinstance(v, str):
                    refs.add(v)
                elif k == "entities" and isinstance(v, list):
                    for it in v:
                        refs.add(it["entity"] if isinstance(it, dict) else it)
                else:
                    walk(v)
        elif isinstance(o, list):
            for i in o:
                walk(i)

    walk(cfg)
    missing = sorted(r for r in refs if r not in live)
    print(f"{len(refs)} entity refs, {len(missing)} missing")
    for m in missing:
        print(f"  MISSING ENTITY: {m}")

    cards, features, other = _dash_types(cfg)
    print(f"cards:    {' '.join(sorted(cards))}")
    print(f"features: {' '.join(sorted(features)) or '-'}")
    print(f"layout:   {' '.join(sorted(other))}")
    print("run `ha.py check-cards " + " ".join(sorted(cards)) + "` to confirm they exist")
    sys.exit(1 if missing else 0)


def cmd_check_cards(args):
    """check-cards <type>... — does each card type actually exist? (needs kubectl)"""
    import subprocess

    core = [t for t in args if not t.startswith("custom:")]
    custom = [t for t in args if t.startswith("custom:")]
    bad = False

    if core:
        pod = subprocess.run(["kubectl", "get", "pods", "-n", "hass", "-o",
                              "jsonpath={.items[0].metadata.name}"],
                             capture_output=True, text=True).stdout.strip()
        if not pod:
            die("could not find the hass pod (is kubectl configured?)")
        globs = "/usr/local/lib/python3*/site-packages/hass_frontend/frontend_latest"
        for t in core:
            n = subprocess.run(
                ["kubectl", "exec", "-n", "hass", pod, "--", "sh", "-c",
                 f"grep -rlo 'hui-{t}-card' {globs}/*.js 2>/dev/null | wc -l"],
                capture_output=True, text=True).stdout.strip()
            ok = n not in ("", "0")
            bad |= not ok
            print(f"  {'OK  ' if ok else 'MISS'} {t:24} (hui-{t}-card in {n} bundle files)")

    if custom:
        resources = {r["url"] for r in ws_one("lovelace/resources")}
        print(f"  custom cards come from Lovelace resources; {len(resources)} registered:")
        for r in sorted(resources):
            print(f"       {r}")
        print("  confirm the bundle serves and grep it for the exact element name:")
        print("       curl -s -o /dev/null -w '%{http_code}\\n' -H \"Authorization: Bearer $HASS_ACCESS_TOKEN\" <url>")
    sys.exit(1 if bad else 0)


COMMANDS = {
    "states": cmd_states, "get": cmd_get, "call": cmd_call, "template": cmd_template,
    "ws": cmd_ws, "entity": cmd_entity, "device": cmd_device,
    "dash-list": cmd_dash_list, "dash-get": cmd_dash_get, "dash-save": cmd_dash_save,
    "dash-create": cmd_dash_create, "check-dash": cmd_check_dash,
    "check-cards": cmd_check_cards,
    "automation-put": cmd_automation_put, "automation-del": cmd_automation_del,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        print(f"Server: {URL}\n\nCommands:")
        for name, fn in COMMANDS.items():
            doc = (fn.__doc__ or "").split("\n")[0]
            print(f"  {name:16} {doc}")
        sys.exit(0 if len(sys.argv) < 2 else 2)
    COMMANDS[sys.argv[1]](sys.argv[2:])
