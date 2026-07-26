---
name: netbox
description: Use when querying or updating the homelab NetBox DCIM inventory — looking up devices, device types, racks, or serials, and recording hardware changes like swapping a drive in the NAS, adding a new server, or decommissioning gear. Use when asked to "check netbox", "add a drive", "what's in bay N", "record this hardware", or "update the inventory".
---

# NetBox

DCIM/IPAM source of truth for the homelab.

**Server:** `https://netbox.cmdcentral.xyz` (NetBox 4.6)
**Auth:** `$NETBOX_TOKEN` from the environment — a v1 token with write access. Never print it.
**Client:** `.claude/skills/netbox/scripts/nb.py` (stdlib Python, no deps), run from the repo root.

```bash
nb=.claude/skills/netbox/scripts/nb.py

$nb get   dcim/devices role=disk --fields id,serial,device_type.model
$nb get   dcim/devices/102
$nb post  dcim/devices '{"device_type": 17, "role": 5, "site": 1}'
$nb patch dcim/device-bays/33 '{"installed_device": 102}'
$nb delete dcim/devices/102
$nb bays  nas-shelf01
```

`get` auto-paginates and always returns a JSON array for list endpoints, a bare object for
detail routes (`…/102`). **Always pass `--fields`** on list queries — full device objects are
~60 keys each and will flood the context. Dotted paths work: `--fields id,device_type.manufacturer.name`.
Repeatable filters are ANDed as NetBox expects (`$nb get dcim/devices site=cmdcentral role=disk`).

## Data model in this instance

Read this before writing anything — the conventions here are hand-rolled, not NetBox defaults.

| Object       | Convention                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Sites        | `Cmdcentral` (1, the house), `Lake Lair` (2), `Dad` (4)                                                          |
| Racks        | `Basement` (1), `Computer Desk` (2), `WW Basement` (3)                                                           |
| Device roles | Server (3), Network Device (1), Disk (5), Power (2), Camera (6), Miscellaneous (4)                               |
| Device types | ~2255 — nearly all from the upstream devicetype-library import. Hand-made ones exist for gear the library lacks. |

**Drives are full `Device` objects**, not inventory items or modules. There are zero inventory
items, modules, and module bays in this instance — do not introduce them. A drive is:

- a device type with `subdevice_role: "child"`, `u_height: 0`, `part_number` = the OEM model
  number (e.g. `ST10000NM0086-2A`),
- a device with `role: 5` (Disk), `name: null`, `serial` = the drive serial, sited/racked with
  its host,
- installed into a **device bay** on the parent chassis.

Bay-bearing parents today:

| Device             | Type           | Bays               | Bay naming                                             |
| ------------------ | -------------- | ------------------ | ------------------------------------------------------ |
| `nas-shelf01` (61) | NetApp DS4246  | 24, named `0`–`23` | `label` = last 4 chars of the installed drive's serial |
| `nas` (62)         | PowerEdge R610 | 6, named `0`–`5`   | labels unused                                          |
| `NVR` (14)         | NV2116-HS      | —                  | one disk installed                                     |

The `label`-is-serial-suffix convention on `nas-shelf01` is how you physically identify which
sled to pull. Keep it in sync when swapping drives — a stale label means pulling the wrong disk.

## Workflow: replace a drive in the NAS

### 1. Find the bay and the outgoing drive

```bash
$nb bays nas-shelf01
```

Gives `bay_id`, bay `name`, `label`, and the currently installed device. Cross-check the serial:

```bash
$nb get dcim/devices/<installed_device_id> --fields id,serial,device_type.model
```

### 2. Find or create the device type for the new drive

Search before creating — the imported library covers a lot:

```bash
$nb get dcim/device-types q=exos --fields id,manufacturer.name,model,part_number,subdevice_role.value
$nb get dcim/device-types manufacturer=seagate q=10tb --fields id,model,part_number
```

Confirm the manufacturer exists (`$nb get dcim/manufacturers q=seagate --fields id,name,slug`);
create it only if genuinely absent.

If no type matches, create one matching the existing drive-type style:

```bash
$nb post dcim/device-types '{
  "manufacturer": 12,
  "model": "Exos X18 (18TB)",
  "slug": "exos-x18-18tb",
  "part_number": "ST18000NM000J",
  "u_height": 0,
  "subdevice_role": "child"
}'
```

`u_height: 0` and `subdevice_role: "child"` are **required** — a drive with a nonzero height or
no child role cannot be installed into a device bay. Use a descriptive unique slug; some older
hand-made types have poor auto-generated slugs (device type 17's slug is literally `10tb`), do
not copy that.

### 3. Create the drive device

```bash
$nb post dcim/devices '{
  "device_type": <type-id>,
  "role": 5,
  "site": 1,
  "rack": 1,
  "serial": "<DRIVE SERIAL>",
  "status": "active"
}'
```

Leave `name` unset (`null`) — drives are identified by serial, and NetBox only enforces name
uniqueness per site, so blank names avoid collisions. Do **not** set `parent_device` or
`position`; a child device is placed by installing it into a bay, not by setting a parent.

### 4. Install into the bay, and evict the old drive first

A bay holds one device. Clear it before installing:

```bash
$nb patch dcim/device-bays/<bay-id> '{"installed_device": null}'
$nb patch dcim/device-bays/<bay-id> '{"installed_device": <new-device-id>, "label": "<last 4 of serial>"}'
```

### 5. Deal with the removed drive — ask, don't assume

Removing a drive from a bay leaves its device record orphaned but alive. The right disposition
depends on why it came out, so **ask the user** rather than picking one:

- **Failed / discarded** → `$nb patch dcim/devices/<id> '{"status": "offline"}'` plus a comment,
  or delete the record outright.
- **Kept as a spare** → set `status` to `inventory` and leave it uninstalled.
- **Moved elsewhere** → install it into the destination bay.

Deleting is irreversible and loses the serial's history; prefer a status change unless the user
says to remove it.

### 6. Verify

```bash
$nb bays nas-shelf01
```

Labels should match the last 4 of each installed serial, and the new drive should show in the
right bay.

## Other common queries

```bash
# Every disk with its parent chassis
$nb get dcim/devices role=disk --fields id,serial,device_type.model,parent_device.name

# Find a device by serial (searches serials, names, asset tags)
$nb get dcim/devices q=ZA2137NT --fields id,name,serial,device_type.model

# What's in a rack
$nb get dcim/devices rack_id=1 --fields id,name,device_type.model,position,role.name

# Devices at a site, by role
$nb get dcim/devices site=cmdcentral role=server --fields id,name,device_type.model

# Interfaces / IPs on a device (only 29 of 1315 IPs are interface-assigned,
# so an empty result usually means "not modelled yet", not a bad filter)
$nb get dcim/interfaces device_id=62 --fields id,name,type.label,enabled
$nb get ipam/ip-addresses device_id=81 --fields id,address,assigned_object.name

# Free bays anywhere
$nb bays nas-shelf01 | python3 -c 'import sys,json;print([b["name"] for b in json.load(sys.stdin) if not b["installed_device_id"]])'
```

Filters follow NetBox's REST filter names: `q=` full-text, `<field>=` exact by slug/value,
`<field>_id=` by numeric id, `limit`/`offset` handled automatically. Add `brief=true` for
compact reference objects when you don't need `--fields`.

## Notes

- **Confirm writes with the user first.** This is the hardware source of truth and there is no
  undo — read back the current state, state what you're about to change, then apply it.
- This instance is **not** GitOps-managed and has no manifests in this repo. Writing via the API
  is the correct and only way to change it; nothing here needs a commit.
- Three other tokens exist (Proxmox IPAM, device-type importer, atuin-stored). Some objects are
  written by automation — prefer surgical `patch` over wholesale `put`, which replaces every
  field and will silently blank anything you omit.
- Serial numbers are the durable identity for drives. Record them exactly as printed on the
  label, including case.
