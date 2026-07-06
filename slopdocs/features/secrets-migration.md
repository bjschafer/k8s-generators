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

## Classification (all 43) — CUTOVER COMPLETE as of 2026-07-06

Every row below is done: SealedSecret deleted from prod, ExternalSecret Ready,
Secret owned by ESO, post-cutover hash verified against the bws value. The one
open item is the gitlab-runner mount validation noted below.

| Legacy secret                           | Category         | Status                                              | Risk                 |
| --------------------------------------- | ---------------- | --------------------------------------------------- | -------------------- |
| atuin/db-creds                          | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| bookmarks/secrets                       | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| ceph/csi-rbd-secret                     | (a) generators   | **cut over, Ready, hash OK, PVC-verified**          | **HIGH**             |
| cert-manager/cloudflare-api-token       | (a) generators   | **cut over, Ready, hash OK, staging-cert-verified** | **HIGH**             |
| gitlab/runner-registration              | (a) generators   | **cut over, Ready, hash OK** (see note)             | LOW                  |
| grafana/auth-cmdcentral-oauth           | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| grafana/grafana-secrets                 | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| mealie/db-creds                         | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| mealie/oidc-creds                       | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| media/lidarr-api                        | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| media/navidrome-lastfm                  | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| media/radarr-api                        | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| media/sabnzbd-api                       | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| media/sonarr-api                        | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| metrics/alertmanager-secrets            | (a) generators   | **cut over, Ready, hash OK**                        | MED (alert delivery) |
| metrics/hass-bearer-token               | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| miniflux/db-creds                       | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| miniflux/oauth                          | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| paperless/paperless-db-creds            | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| paperless/paperless-oidc                | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| paste/secrets                           | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| pfwiki/db-creds                         | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| spoolman/spoolman-creds                 | (a) generators   | **cut over, Ready, hash OK**                        | LOW                  |
| argocd/gitlab-webhook                   | (b) prod-only    | in bws, snippet below                               | —                    |
| catbot/bot-token                        | (b) prod-only    | in bws, snippet below                               | —                    |
| cmdcentralbot/bot-token                 | (b) prod-only    | in bws, snippet below                               | —                    |
| monica/app-secrets                      | (b) prod-only    | in bws, snippet below                               | —                    |
| monica/mariadb-creds                    | (b) prod-only    | in bws, snippet below                               | —                    |
| netbox/db-creds                         | (b) prod-only    | in bws, snippet below                               | —                    |
| netbox/netbox                           | (b) prod-only    | in bws, snippet below                               | —                    |
| netbox/oidc                             | (b) prod-only    | in bws, snippet below                               | —                    |
| pfapi/db-creds                          | (b) prod-only    | in bws, snippet below                               | —                    |
| argocd/argocd-secret                    | (c) hand-migrate | **investigated, not executed** (see below)          | —                    |
| catbot/github-registry-cred             | (c) hand-migrate | **cut over by hand, Ready, hash OK**                | —                    |
| cmdcentralbot/github-registry-cred      | (c) hand-migrate | **cut over by hand, Ready, hash OK**                | —                    |
| external-secrets/bitwarden-access-token | (d) bootstrap    | **permanent manual** (see below)                    | —                    |
| recipes/secrets                         | orphan           | deleted from prod                                   | —                    |
| media/readarr-api                       | orphan           | deleted from prod                                   | —                    |
| media/doplarr-secrets                   | orphan           | deleted from prod                                   | —                    |
| metrics/unifi-creds                     | orphan           | deleted from prod                                   | —                    |
| metrics/proxmox-exporter                | orphan           | deleted from prod                                   | —                    |
| postgres/backups                        | orphan           | deleted from prod                                   | —                    |

## Per-App Cutover Checklist (category a) — all done

All LOW-risk apps were cut over in one commit (prod `15998a2d`) and verified:
`ExternalSecret` Ready, Secret re-owned by ESO, post-cutover hash matches the
phase-0-recorded hash, no new pod failures. ceph and cert-manager (HIGH risk)
were cut over individually with immediate verification (see below). gitlab was
held back for the runner-registration-token investigation, done separately
(see the gitlab note below), then cut over on its own commit.

**ceph** (prod `d2066062`): `ExternalSecret/csi-rbd-secret` Ready within
seconds, hash parity on all 4 keys (adminID/adminKey/userID/userKey). Created
a scratch 1Gi PVC on `ceph-rbd`, Bound immediately, deleted — confirms the CSI
provisioner authenticates fine with the ESO-managed secret.

**cert-manager** (prod `b6e77951`): `ExternalSecret/cloudflare-api-token`
Ready, hash parity, no auth errors in the cert-manager controller logs.
Issued a throwaway `letsencrypt-staging` Certificate
(`cutover-verify-staging`, dnsName `cutover-verify.cmdcentral.xyz`) — went
Ready in under 2 minutes (DNS01 solved fine), then deleted the Certificate and
its Secret. Existing ClusterIssuers/Certificates stayed Ready throughout.

**gitlab** (prod `da599d1d`, generators `198089df`/`0597e6c3`): see the
dedicated note below — this one needed real remediation, not just a delete.

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
  re-create the Secret by hand on cluster rebuild). Never delete it. The
  **write-scoped** token used for this cutover session (a separate, temporary
  bws access token, not this bootstrap one) should be **revoked** now that the
  cutover is done — it's not needed again until the next batch of secrets moves.
- **argocd/argocd-secret** — investigated, not executed (see below).
- **{catbot,cmdcentralbot}/github-registry-cred** — hand-migrated (see below).

## gitlab/runner-registration — the one that needed real remediation

The live `runner-registration-token` key has been empty for a while.
Investigated whether it's still needed before cutting over:

- gitlab-runner (`prod-runner-gitlab-runner`, in the `gitlab` namespace) is
  live and healthy, and its own logs confirm it registers via the modern
  authentication-token flow (`"Configuration (with the authentication token)
was saved"`), matching GitLab 16+'s deprecation of registration tokens. So
  the secret is genuinely in use — only the legacy key inside it is dead.
- But the `gitlab-runner` Helm chart's `projected-secrets` volume
  unconditionally references **both** `runner-token` and
  `runner-registration-token` whenever `runners.secret` is set (chart
  `templates/deployment.yaml`), regardless of whether the entrypoint script
  actually reads the latter. An ESO secret with only `runner-token` would mount
  fine for the _currently running_ pod (already-mounted volumes aren't
  re-validated), but the kubelet would refuse to schedule the _next_ one with
  `references non-existent secret key` — i.e. this would look fine at cutover
  and then silently break the runner's next restart (node drain, chart bump,
  `selfHeal` reconcile, anything).
- `BitwardenSecret` only supports remoteRef-sourced keys (bws itself can't
  store an empty string, which is the whole reason this key was omitted
  originally), so `apps/gitlab/app.ts` now bypasses it for this one secret:
  a hand-built `ExternalSecret` with `target.template.data` adding a static
  empty `runner-registration-token` alongside the real `runner-token`.
- First attempt at the template used `{{ .["runner-token"] }}`, which isn't
  valid Go template syntax — ESO logged `bad character U+005B '['` and never
  rendered the secret. Fixed to `{{ index . "runner-token" }}` (the correct
  way to look up a map key that isn't a valid Go identifier).
- Verified: `ExternalSecret` Ready, Secret has both keys (`runner-token`
  correctly populated, `runner-registration-token` present-but-empty), hash
  parity on `runner-token`. **Not yet verified**: the volume actually mounting
  on a fresh pod, since forcing a restart of a live Deployment is outside this
  session's authorized cluster writes. Restart the runner deployment (or wait
  for its next natural restart) and confirm the pod comes up healthy and
  re-registers.

## Registry-cred hand-migration (catbot, cmdcentralbot) — done

`.dockerconfigjson` secrets can't go through `BitwardenSecret` (no
`target.template` support), so these were migrated by hand directly in the
**prod** repo (these two apps haven't moved to generators):

- Pushed the full `.dockerconfigjson` JSON string to Bitwarden as one entry
  each: `Catbot - github-registry-cred - dockerconfigjson`,
  `Cmdcentralbot - github-registry-cred - dockerconfigjson`.
- Added `{catbot,cmdcentralbot}/externalsecret.github-registry-cred.yaml`
  (plain ESO YAML, `target.template.type: kubernetes.io/dockerconfigjson`,
  `target.template.data[".dockerconfigjson"]` templated from the bws-sourced
  value via `{{ index . "dockerconfigjson" }}`), deleted the sealed versions,
  same commit.
- Hit a real snag on push: both apps build via `kustomize` directly from
  their own prod-repo folder (not routed through the shared `secrets/` app),
  and their `kustomization.yaml` still listed the now-deleted
  `sealedsecret.github-registry-cred.yaml` — ArgoCD couldn't generate a
  manifest at all (`no such file or directory`), taking both apps to
  `Unknown` sync status. Fixed by swapping the resource list entry to the new
  `externalsecret.*.yaml` file and verifying with `kubectl kustomize` locally
  before pushing again.
- Verified: both `ExternalSecret`s Ready, Secret type `kubernetes.io/dockerconfigjson`
  owned by ESO, hash parity on the full JSON blob, both bot pods still
  `Running` unaffected (imagePullSecrets only get re-validated on the next
  actual image pull, which hadn't happened yet at verification time — same
  caveat as the gitlab volume mount, but lower risk since a plain
  imagePullSecrets reference doesn't have the strict per-key `items` list a
  projected volume does).

## argocd/argocd-secret — investigation only, do not execute yet

Compared the sealed version's `encryptedData` key names against the live
Secret's key names (names only, no values pulled) — both sides have exactly
the same 9 keys:

`accounts.bschafer.password`, `accounts.bschafer.passwordMtime`,
`accounts.bschafer.tokens`, `admin.password`, `admin.passwordMtime`,
`dex.authentik.clientSecret`, `server.secretkey`, `tls.crt`, `tls.key`.

Of those, argocd-server **self-manages and mutates at runtime**:

- `server.secretkey` — auto-generated JWT signing key if absent.
- `admin.password` / `admin.passwordMtime` — rewritten whenever the admin
  password changes (CLI/UI).
- `accounts.bschafer.password` / `.passwordMtime` / `.tokens` — same, for the
  local `bschafer` account, plus `argocd account generate-token` appends to
  `.tokens`.
- `tls.crt` / `tls.key` — argocd-server self-generates these for its internal
  gRPC/repo-server TLS if not otherwise provided.

Only **`dex.authentik.clientSecret`** (the Authentik OIDC client secret) is
genuinely externally-sourced and never touched by argocd itself.

**Recommendation**: when argocd migrates to generators, do **not** point a
`BitwardenSecret`/plain `ExternalSecret` at this Secret with the default
`creationPolicy: Owner` — ESO would take ownership of the whole Secret and
overwrite/reset the JWT signing key, admin password hash, and API tokens on
every reconcile, invalidating every active session and token. Instead use
`creationPolicy: Merge` with the ExternalSecret declaring **only**
`dex.authentik.clientSecret`, so ESO adds/updates that one key in place and
leaves everything argocd self-manages alone. Execute this when argocd
actually migrates to generators, not before.

## Orphans (deleted from prod, commit `b44c443d`)

`recipes/secrets` (empty namespace), `media/readarr-api` + `media/doplarr-secrets`
(no deployments), `metrics/unifi-creds` + `metrics/proxmox-exporter` (superseded by
ESO-based exporters in `apps/metrics-exporters/`), `postgres/backups` (superseded
by ESO-managed `postgres/s3-creds`). Deleting `metrics/proxmox-exporter` is what
unblocks the new proxmox-exporter, which reuses the same Secret name. The live
Secrets are GC'd by their ownerReferences on push. The untracked
`secrets/recipes/plaintextsecret.yaml` mentioned here previously has been removed.

**Note for next pass**: there are several more `plaintextsecret*` files sitting
untracked (gitignored) on disk across the prod repo — e.g. under
`secrets/atuin/`, `secrets/grafana/` (two), `secrets/media/`, `secrets/metrics/`
(four), `secrets/miniflux/` (two). These weren't part of this cutover's scope
(only the one under `secrets/recipes/` was called out), and weren't touched.
Worth a manual pass to confirm they're all genuinely stale local artifacts and
clean them up, same as the recipes one.

## Tooling

`bun run tools/migrate-secret.ts <ns> <name> [--execute]` (dry-run by default,
`--inventory` scans the prod repo). Needs a **write-scoped** `BWS_ACCESS_TOKEN` for
`--execute` — the cluster's `bitwarden-access-token` is read-only by design.
