---
name: secrets-migration
description: SealedSecrets → Bitwarden Secrets Manager + External Secrets Operator migration — classification of all 43 legacy secrets, per-app cutover runbook, HIGH-risk maintenance-window list, and prod-only app snippets
metadata:
  type: project
---

# SealedSecrets → Bitwarden + ESO Migration

All 43 SealedSecrets from the legacy prod repo (`~/development/k8s/prod`) have been
classified and, where applicable, their values copied into Bitwarden Secrets Manager
(project `01e3e960-5d95-4bbc-b63c-b2bc00226981`, "K8S") and wired into this repo as
`BitwardenSecret` constructs (`lib/secrets.ts`). This doc is the cutover runbook.

## Naming Convention

One bws entry per Secret key: `<Title Case Namespace> - <secret-name> - <KEY>`
(e.g. `Atuin - db-creds - ATUIN_DB_URI`). Matches the pre-existing human-readable
"App - Thing" organization of the project. `tools/migrate-secret.ts` generates this
automatically. remoteRefs in ExternalSecrets use UUIDs, so the names are purely for
findability in the Bitwarden UI.

## Cutover Mechanics (why nothing breaks on push)

- `BitwardenSecret` renders an `ExternalSecret` with the **same target Secret
  name and keys** as the legacy Secret, so no workload changes are needed.
- ESO's default `creationPolicy: Owner` **refuses to adopt** an existing Secret it
  does not own (the legacy Secrets are owned by the sealed-secrets controller via
  ownerReference). Until the SealedSecret is deleted, the ExternalSecret sits in a
  `SecretSyncedError`-style condition. **This is harmless** — the existing Secret
  keeps working untouched.
- Cutover per app = delete the SealedSecret manifest from the prod repo and push.
  The sealed-secrets controller GCs the Secret (ownerReference cascade), and ESO
  creates its replacement on the next reconcile. The refresh interval is
  `1h0m0s` (ESO default, confirmed on live ExternalSecrets), but ESO also reacts
  to the Secret deletion event much sooner; to force an immediate sync:
  `kubectl annotate externalsecret -n <ns> <name> force-sync=$(date +%s)`.
- Worst case for LOW-risk apps: pod restarts during the gap fail to start until the
  Secret reappears. Running pods are unaffected (env vars are baked in at start).

## Classification (all 43)

| Legacy secret                           | Category         | Status                               | Risk                 |
| --------------------------------------- | ---------------- | ------------------------------------ | -------------------- |
| atuin/db-creds                          | (a) generators   | migrated + wired                     | LOW                  |
| bookmarks/secrets                       | (a) generators   | migrated + wired                     | LOW                  |
| ceph/csi-rbd-secret                     | (a) generators   | migrated + wired                     | **HIGH**             |
| cert-manager/cloudflare-api-token       | (a) generators   | migrated + wired                     | **HIGH**             |
| gitlab/runner-registration              | (a) generators   | migrated + wired (see note)          | LOW                  |
| grafana/auth-cmdcentral-oauth           | (a) generators   | migrated + wired                     | LOW                  |
| grafana/grafana-secrets                 | (a) generators   | migrated + wired                     | LOW                  |
| mealie/db-creds                         | (a) generators   | migrated + wired                     | LOW                  |
| mealie/oidc-creds                       | (a) generators   | migrated + wired                     | LOW                  |
| media/lidarr-api                        | (a) generators   | migrated + wired                     | LOW                  |
| media/navidrome-lastfm                  | (a) generators   | migrated + wired                     | LOW                  |
| media/radarr-api                        | (a) generators   | migrated + wired                     | LOW                  |
| media/sabnzbd-api                       | (a) generators   | migrated + wired                     | LOW                  |
| media/sonarr-api                        | (a) generators   | migrated + wired                     | LOW                  |
| metrics/alertmanager-secrets            | (a) generators   | migrated + wired                     | MED (alert delivery) |
| metrics/hass-bearer-token               | (a) generators   | migrated + wired                     | LOW                  |
| miniflux/db-creds                       | (a) generators   | migrated + wired                     | LOW                  |
| miniflux/oauth                          | (a) generators   | migrated + wired                     | LOW                  |
| paperless/paperless-db-creds            | (a) generators   | migrated + wired                     | LOW                  |
| paperless/paperless-oidc                | (a) generators   | migrated + wired                     | LOW                  |
| paste/secrets                           | (a) generators   | migrated + wired                     | LOW                  |
| pfwiki/db-creds                         | (a) generators   | migrated + wired                     | LOW                  |
| spoolman/spoolman-creds                 | (a) generators   | migrated + wired                     | LOW                  |
| argocd/gitlab-webhook                   | (b) prod-only    | in bws, snippet below                | —                    |
| catbot/bot-token                        | (b) prod-only    | in bws, snippet below                | —                    |
| cmdcentralbot/bot-token                 | (b) prod-only    | in bws, snippet below                | —                    |
| monica/app-secrets                      | (b) prod-only    | in bws, snippet below                | —                    |
| monica/mariadb-creds                    | (b) prod-only    | in bws, snippet below                | —                    |
| netbox/db-creds                         | (b) prod-only    | in bws, snippet below                | —                    |
| netbox/netbox                           | (b) prod-only    | in bws, snippet below                | —                    |
| netbox/oidc                             | (b) prod-only    | in bws, snippet below                | —                    |
| pfapi/db-creds                          | (b) prod-only    | in bws, snippet below                | —                    |
| argocd/argocd-secret                    | (c) hand-migrate | skipped (multi-key argocd internals) | —                    |
| catbot/github-registry-cred             | (c) hand-migrate | skipped (.dockerconfigjson blob)     | —                    |
| cmdcentralbot/github-registry-cred      | (c) hand-migrate | skipped (.dockerconfigjson blob)     | —                    |
| external-secrets/bitwarden-access-token | (d) bootstrap    | **permanent manual** (see below)     | —                    |
| recipes/secrets                         | orphan           | deleted from prod                    | —                    |
| media/readarr-api                       | orphan           | deleted from prod                    | —                    |
| media/doplarr-secrets                   | orphan           | deleted from prod                    | —                    |
| metrics/unifi-creds                     | orphan           | deleted from prod                    | —                    |
| metrics/proxmox-exporter                | orphan           | deleted from prod                    | —                    |
| postgres/backups                        | orphan           | deleted from prod                    | —                    |

## Per-App Cutover Checklist (category a)

For each row: delete the listed prod file(s), push prod, then verify. Order within
the LOW group doesn't matter; do a couple first and build confidence.

### LOW risk — anytime

| App       | Delete from prod repo                                                                                                                                      | Verify after                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| atuin     | `secrets/atuin/db-creds.yaml`                                                                                                                              | `kubectl get es -n atuin db-creds` Ready; restart pod, syncs still work                                                                                                                                                                                                                                                                                                    |
| bookmarks | `secrets/bookmarks/secrets.yaml`                                                                                                                           | ES Ready; linkwarden login (SSO) works                                                                                                                                                                                                                                                                                                                                     |
| gitlab    | `secrets/gitlab/runner-registration.yaml`                                                                                                                  | ES Ready; runner pod re-registers and picks up a job. **Note:** legacy Secret had an _empty_ `runner-registration-token` key that Bitwarden can't store; the ESO Secret only has `runner-token`. Modern gitlab-runner chart auths with `runner-token` (glrt-…) only, but if the chart complains about the missing key, add a template/placeholder or re-check chart values |
| grafana   | `secrets/grafana/sealedsecret.auth-cmdcentral-oauth.yaml`, `secrets/grafana/sealedsecret.grafana-secrets.yaml`                                             | Both ES Ready; grafana pods restart OK (DB + OAuth login)                                                                                                                                                                                                                                                                                                                  |
| mealie    | `secrets/mealie/sealedsecret.db-creds.yaml`, `secrets/mealie/sealedsecret.oidc-creds.yaml`                                                                 | ES Ready; app restart connects to postgres, OIDC login                                                                                                                                                                                                                                                                                                                     |
| media     | `secrets/media/lidarr.yaml`, `secrets/media/radarr.yaml`, `secrets/media/sabnzbd.yaml`, `secrets/media/sonarr.yaml`, `secrets/media/navidrome-lastfm.yaml` | ES Ready ×5; exportarr sidecars scrape OK, navidrome lastfm still linked                                                                                                                                                                                                                                                                                                   |
| metrics   | `secrets/metrics/alertmanager-secrets.yaml`, `secrets/metrics/hass-bearer-token.yaml`                                                                      | ES Ready; send a test alert (pushover/email), hass scrape target up                                                                                                                                                                                                                                                                                                        |
| miniflux  | `secrets/miniflux/sealedsecret.db-creds.yaml`, `secrets/miniflux/sealedsecret.oauth.yaml`                                                                  | ES Ready; app restart, OIDC login                                                                                                                                                                                                                                                                                                                                          |
| paperless | `secrets/paperless/sealedsecret.paperless-db-creds.yaml`, `secrets/paperless/sealedsecret.paperless-oidc.yaml`                                             | ES Ready; web pod restart, SSO login                                                                                                                                                                                                                                                                                                                                       |
| paste     | `secrets/paste/secrets.yaml`                                                                                                                               | ES Ready; admin login                                                                                                                                                                                                                                                                                                                                                      |
| pfwiki    | `secrets/pfwiki/db-creds.yaml`                                                                                                                             | ES Ready; **both** the mariadb StatefulSet and bookstack consume `db-creds` — restart both, wiki loads                                                                                                                                                                                                                                                                     |
| spoolman  | `secrets/spoolman/sealedsecret.spoolman-creds.yaml`                                                                                                        | ES Ready; app restart connects to postgres                                                                                                                                                                                                                                                                                                                                 |

### HIGH risk — maintenance window, verify immediately

| App          | Delete from prod repo                            | Verify after                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ceph         | `secrets/ceph/csi.yaml`                          | `kubectl get es -n ceph csi-rbd-secret` Ready **within seconds of deletion** (force-sync if not); then create a scratch PVC on `ceph-rbd` AND `cephfs`, confirm Bound, delete it. Existing mounted volumes are unaffected (node-stage creds only needed at attach time), but new provisioning/attach/expand/snapshot breaks while the Secret is absent |
| cert-manager | `secrets/cert-manager/cloudflare-api-token.yaml` | ES Ready; issue a test cert (`letsencrypt-staging` ClusterIssuer) and confirm DNS01 solves. Renewals fail silently-ish while the Secret is absent, so don't leave this broken overnight                                                                                                                                                                |

## Category (b) — prod-only apps (values already in Bitwarden)

No code exists in this repo for these yet. When each app migrates to generators,
paste its snippet. UUIDs are the bws entry IDs (values live only in Bitwarden).

```typescript
new BitwardenSecret(app, "gitlab-webhook", {
  name: "gitlab-webhook",
  namespace: "argocd",
  data: { GITLAB_WEBHOOK_SECRET: "71c6bae5-37c9-4455-afa9-b47e0182795b" },
});

new BitwardenSecret(app, "bot-token", {
  name: "bot-token",
  namespace: "catbot",
  data: { BOT_TOKEN: "90a18b3e-cf95-4d62-b8dc-b47e018279de" },
});

new BitwardenSecret(app, "bot-token", {
  name: "bot-token",
  namespace: "cmdcentralbot",
  data: { BOT_TOKEN: "206f1cf4-94b9-4b68-96a0-b47e01827a95" },
});

new BitwardenSecret(app, "app-secrets", {
  name: "app-secrets",
  namespace: "monica",
  data: {
    APP_KEY: "537738c1-63d2-4f1f-bb8a-b47e01827b0e",
    DB_PASSWORD: "af1728d6-4c2b-422a-9b88-b47e01827b54",
    HASH_SALT: "4ee89060-7c73-469d-a732-b47e01827b82",
  },
});

new BitwardenSecret(app, "mariadb-creds", {
  name: "mariadb-creds",
  namespace: "monica",
  data: { MARIADB_ROOT_PASSWORD: "d64591f7-dafd-4178-b36a-b47e01827c29" },
});

new BitwardenSecret(app, "db-creds", {
  name: "db-creds",
  namespace: "netbox",
  data: { password: "421b33c5-ec6c-40ec-a488-b47e01827cbc" },
});

new BitwardenSecret(app, "netbox", {
  name: "netbox",
  namespace: "netbox",
  data: { SECRET_KEY: "1131094d-5258-4d6f-bf9d-b47e01827d5c" },
});

new BitwardenSecret(app, "oidc", {
  name: "oidc",
  namespace: "netbox",
  data: {
    SOCIAL_AUTH_OIDC_KEY: "63035698-a60b-4ea0-915d-b47e01827df8",
    SOCIAL_AUTH_OIDC_SECRET: "ce4cbbd8-3fa5-44da-bdef-b47e01827e30",
  },
});

new BitwardenSecret(app, "db-creds", {
  name: "db-creds",
  namespace: "pfapi",
  data: {
    Database_Database: "302c4529-0e67-488a-acce-b47e01827ec2",
    Database_Host: "98b5df13-e42f-4a38-8b12-b47e01827f0b",
    Database_Password: "cd9acc1c-c087-44b0-9875-b47e01827f38",
    Database_Port: "2e96ce16-64f9-46ef-9848-b47e01827f64",
    Database_Type: "0f88cf46-0ab3-4096-a9ac-b47e01827fb0",
    Database_Username: "b4ce08bd-6169-4a12-ae62-b47e0182b531",
  },
});
```

## Special / Bootstrap Cases

- **external-secrets/bitwarden-access-token** — the token ESO itself uses to reach
  Bitwarden. ESO cannot manage its own credential (chicken-and-egg), so this stays
  a **permanent manual bootstrap**: keep the SealedSecret in the prod repo (or
  re-create the Secret by hand on cluster rebuild). Never delete it.
- **argocd/argocd-secret** — argocd-internal multi-purpose secret (admin/user
  password hashes, server signature key). Hand-migrate if ever needed; argocd also
  mutates it in-cluster.
- **{catbot,cmdcentralbot}/github-registry-cred** — `.dockerconfigjson` structured
  blobs. ESO can build these with `target.template`, which `BitwardenSecret`
  doesn't support yet. Hand-migrate when those apps move to generators.

## Orphans (deleted from prod, commit `b44c443d`)

`recipes/secrets` (empty namespace), `media/readarr-api` + `media/doplarr-secrets`
(no deployments), `metrics/unifi-creds` + `metrics/proxmox-exporter` (superseded by
ESO-based exporters in `apps/metrics-exporters/`), `postgres/backups` (superseded
by ESO-managed `postgres/s3-creds`). Deleting `metrics/proxmox-exporter` is what
unblocks the new proxmox-exporter, which reuses the same Secret name. The live
Secrets are GC'd by their ownerReferences on push. An untracked
`secrets/recipes/plaintextsecret.yaml` remains on disk in the prod repo; remove it
by hand.

## Tooling

`bun run tools/migrate-secret.ts <ns> <name> [--execute]` (dry-run by default,
`--inventory` scans the prod repo). Needs a **write-scoped** `BWS_ACCESS_TOKEN` for
`--execute` — the cluster's `bitwarden-access-token` is read-only by design.
