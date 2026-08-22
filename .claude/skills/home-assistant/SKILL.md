---
name: home-assistant
description: Use when inspecting or changing Home Assistant in the homelab — entities, devices, areas, dashboards, automations, notifications, unit/display overrides, or integration config entries. Use when asked to "add a dashboard", "check an entity", "make an automation", "notify my phone", "why is this sensor in °F", "rename this device", or "what does HA see for X".
---

# Home Assistant

**Server:** `https://hass.cmdcentral.xyz` (HA 2026.8.3, `hass` namespace, hostNetwork)
**Auth:** `$HASS_ACCESS_TOKEN` from the environment — a long-lived token for an admin
account. Never print it; pass it via the client below.
**Client:** `.claude/skills/home-assistant/scripts/ha.py` (stdlib only, no deps — it
implements the websocket framing itself). Run from the repo root.

```bash
ha=.claude/skills/home-assistant/scripts/ha.py

$ha states bambuzled                  # entity_id / state / unit, substring filtered
$ha get sensor.x                      # full state JSON incl. attributes
$ha call light.turn_on '{"entity_id":"light.x"}'
$ha template "{{ states('sensor.x') }}"
$ha entity sensor.x                   # registry entry
$ha entity sensor.x '{"name":"Nicer name"}'
$ha device bambuzled                  # device id lookup by name substring
$ha dash-list / dash-get <path> / dash-save <path> <file.json>
$ha check-dash <path>                 # entity refs resolve? which card types?
$ha check-cards tile picture heading  # do those card types exist?
$ha automation-put <id> <file.json> / automation-del <id>
$ha ws <command/type> '{"arg":1}'     # anything not wrapped above
```

## HA's config is **not** in this repo

`apps/hass/app.ts` defines only the Deployment, PVC and Ingress. Everything HA
*is* — integrations, entity registry, dashboards, `automations.yaml`,
`configuration.yaml`, `secrets.yaml` — lives on the `config` PVC in the `hass`
namespace. Changing it through the API or `kubectl exec` does **not** violate the
repo's GitOps rule; that rule covers manifests. Nothing you do here needs a
commit, a `mise run build`, or an ArgoCD sync.

## Which surface: REST or websocket

| Task | Surface |
|------|---------|
| Read states, call services, render templates | REST (`/api/states`, `/api/services/...`, `/api/template`) |
| Automations (create/update/delete) | REST `/api/config/automation/config/<id>` — writes `automations.yaml` **and reloads** |
| Config entry reload | REST `POST /api/config/config_entries/entry/<id>/reload` |
| Entity registry (rename, area, unit, disable, hide) | **websocket only** |
| Device registry (rename, area) | **websocket only** |
| Dashboards (create, read, save) | **websocket only** |
| Config entries (list, disable, options flow) | **websocket only** |

### The `unknown_command` trap

A websocket command name is the `vol.Required("type")` **string** in the component
source, *not* the Python handler's function name. `websocket_update_entity` is
reachable as `config/entity_registry/update`; guessing `.../update_entity` returns
`unknown_command` and reads exactly like the command not existing in this build.
Before concluding a command is missing, grep the running image:

```bash
pod=$(kubectl get pods -n hass -o name | head -1)
kubectl exec -n hass $pod -- grep -rn 'vol.Required("type")' \
  /usr/src/homeassistant/homeassistant/components/config/entity_registry.py
```

Same trick for `.../components/lovelace/`, `.../config/device_registry.py`, etc.

### Never hand-edit `/config/.storage/*` while HA is running

HA holds those registries in memory and rewrites them on its own schedule and at
shutdown, so a live edit gets silently clobbered. Read them for diagnosis, write
them only through the API. If you genuinely must edit the files (HA won't start),
scale the deployment to 0 first.

## Units and display: `us_customary` bites integrations

Core is set to `unit_system: us_customary`, so **every** `device_class: temperature`
entity is converted to °F for display. Do not change the global unit system to fix
one integration — it moves thermostats and weather too.

Integrations that ship `suggested_unit_of_measurement: °C` keep °C automatically
(it lands in the registry as `sensor.private.suggested_unit_of_measurement`). Those
that don't — commonly `number.*` target-temperature entities — show °F with °F
slider ranges. Override per entity:

```bash
$ha entity number.x '{"options_domain":"number","options":{"unit_of_measurement":"°C"}}'
$ha entity sensor.x '{"options_domain":"sensor","options":{"unit_of_measurement":"°C"}}'
```

`options_domain` and `options` must be passed together. This also corrects a
number entity's min/max, so sliders get the real range back. Effective immediately,
no restart.

## Dashboards

Storage-mode dashboards are created then filled in two steps:

```bash
$ha dash-create printlab Printlab mdi:printer-3d-nozzle   # single-word path is fine
$ha dash-save printlab /path/to/config.json               # replaces the whole config
```

`dash-save` **replaces** the entire config — always `dash-get` first if you are
modifying rather than authoring. Generate the JSON from a small Python script
rather than by hand; it keeps entity-id prefixes DRY and diffable.

Sections-view shape (the modern layout, and what you want for phone use):

```jsonc
{"views": [{"title": "Print", "path": "print", "type": "sections", "max_columns": 2,
  "sections": [{"type": "grid", "column_span": 1, "cards": [
      {"type": "heading", "heading": "Now printing", "icon": "mdi:printer-3d-nozzle"},
      {"type": "tile", "entity": "sensor.x", "name": "Task",
       "icon": "mdi:file-document-outline", "grid_options": {"columns": 12},
       "features": [{"type": "numeric-input", "style": "slider"}]}]}]}]}
```

Sections align in rows, so a very tall card leaves dead space beside a short
section — merge short sections or set `column_span` rather than living with the gap.

**Verify before you believe it.** An invalid card type renders as a red
"Configuration error" tile that you only see by looking at the page:

```bash
$ha check-dash printlab      # 0 missing entity refs, and lists the types in use
$ha check-cards tile picture heading history-graph
```

`check-cards` greps the frontend bundle in the pod for `hui-<type>-card`. Known
trap: **there is no `image` card** — an image entity goes in `type: picture` with
`image_entity`. Custom cards come from registered Lovelace resources (`$ha ws
lovelace/resources`); for those, confirm the JS serves and grep it for the exact
element name.

## Automations

Write JSON, POST it, done — the config API appends to `automations.yaml` and
reloads. `<id>` is any stable string; use a readable slug.

```bash
kubectl exec -n hass $(kubectl get pods -n hass -o name | head -1) -- \
  cp /config/automations.yaml /config/automations.yaml.bak-$(date +%Y%m%d)
$ha automation-put bambu_print_finished /tmp/auto.json
```

Use modern syntax (`triggers` / `conditions` / `actions`, `trigger:` and `action:`
keys inside them). Multi-trigger automations should give each trigger an `id` and
branch on `{{ trigger.id }}` in the message.

**Always render templates against live state before trusting them** — a broken
Jinja template fails silently at 2am, not now:

```bash
$ha template "{{ states('sensor.x') }} at layer {{ states('sensor.y') }}"
```

Watch out: Jinja's `{% %}` collides with Python `%`-formatting. Build template
strings with `.replace()` or `.format()`, never `%`.

## Phone notifications

Companion-app notify targets (`$ha ws get_services` to re-check):

| Service | Device |
|---------|--------|
| `notify.mobile_app_whizflip` | user's Galaxy Z Flip (Android) |
| `notify.mobile_app_whizphone` | user's iPhone |
| `notify.mobile_app_jackie_s_phone` | Jackie's phone — do not target without asking |

Useful `data` keys: `tag` (replaces a prior notification with the same tag),
`channel`, `notification_icon`, `color`, `importance: high`,
`clickAction`/`url` (deep-link, e.g. `/printlab/print`) for Android;
`push.interruption-level: time-sensitive` for iOS. Both platforms ignore the
other's keys, so one payload can serve both.

To attach a camera/cover image, use the entity's **signed** `entity_picture`
rather than building a proxy URL — it carries a token, so the phone loads it
without auth:

```jinja
{{ state_attr('image.x_cover_image', 'entity_picture') }}
```

## Other things worth knowing

- **Disabling a registry entry does not purge it from the live state machine** —
  that needs a restart. Batch registry work, restart once at the end.
- **Restart HA:** `$ha call homeassistant.restart '{}'`. Validate config first —
  `curl -s -X POST -H "Authorization: Bearer $HASS_ACCESS_TOKEN"
  https://hass.cmdcentral.xyz/api/config/core/check_config` returns
  `{"result":"valid","errors":null,...}`. Prefer
  `kubectl rollout restart deploy/home-assistant -n hass` if the pod is wedged.
  (`$HASS_URL` overrides the server for `ha.py`, but is not normally set.)
- **HomeKit:** never create a new HomeKit config entry — each one is a new unpaired
  bridge that nags on every restart. Widen the filter on the already-paired bridge
  `21065` instead. See the `project-hass-homekit-topology` memory.
- **Recorder is Postgres** (`pg-prod.cmdcentral.xyz/hass`), with an `exclude` list in
  `configuration.yaml` — excluded entities have no history or statistics, which is why
  some entities can't back a graph or the Energy dashboard.
- **Bambu H2D** is LAN-only with local MQTT; its cards are
  `custom:ha-bambulab-{print_status,print_control,ams,spool,skipobject}-card` (note the
  underscores) and they key off **device** ids, not entity ids. See the
  `project-hass-bambu-h2d-lan` memory.
- HACS custom components live in `/config/custom_components/`. When an integration's
  behaviour is unclear, read its source in the pod — it is faster and more reliable
  than guessing from docs.
