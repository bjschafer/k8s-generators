---
name: security-contexts
description: Pod/container securityContext hardening audit — current rollout state, permanent opt-outs, and untested candidates for runAsNonRoot and readOnlyRootFilesystem
metadata:
  type: project
---

# Security Context Hardening

## Current State

`AppPlusProps` (`lib/app-plus.ts`) exposes two override props on top of the shared defaults:

- `securityContext?: PodSecurityContextProps`
- `containerSecurityContext?: ContainerSecurityContextProps`

They exist to opt an individual app out of `lib/consts.ts`'s `DEFAULT_SECURITY_CONTEXT` into something stricter — never to relax it further (see the comment directly above the props in `app-plus.ts`).

`lib/consts.ts` defines two constants:

```ts
export const DEFAULT_SECURITY_CONTEXT = {
  ensureNonRoot: false,
  readOnlyRootFilesystem: false,
};

export const NONROOT_SECURITY_CONTEXT = {
  ensureNonRoot: true,
  readOnlyRootFilesystem: false,
};
```

`DEFAULT_SECURITY_CONTEXT` is unchanged and stays permissive — most apps haven't been audited yet. `NONROOT_SECURITY_CONTEXT` is Phase 1 of the hardening rollout: it only flips `ensureNonRoot`, not `readOnlyRootFilesystem`, which is a separate future phase.

cdk8s-plus already injects `allowPrivilegeEscalation: false` and `privileged: false` everywhere by default, regardless of this rollout — that part needed no changes.

### Phase 1 (`runAsNonRoot`) — applied

Confirmed via live probes (see Verification Method below) and switched to `NONROOT_SECURITY_CONTEXT`:

| App / container                             | Where                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| atuin                                       | `apps/atuin/app.ts`                                                                      |
| authentik-server                            | `apps/authentik/app.ts`                                                                  |
| authentik-worker                            | `apps/authentik/app.ts`                                                                  |
| pdns-admin                                  | `apps/pdns-admin/app.ts`                                                                 |
| watchstate                                  | `apps/watchstate/app.ts`                                                                 |
| noms                                        | `apps/noms/app.ts`                                                                       |
| miniflux                                    | `apps/miniflux/app.ts`                                                                   |
| external-dns (unifi-webhook container only) | `apps/external-dns/app.ts`                                                               |
| statsd-exporter                             | `apps/metrics-exporters/statsd-exporter.ts`                                              |
| proxmox-exporter                            | `apps/metrics-exporters/proxmox.ts`                                                      |
| gotenberg                                   | `apps/paperless/app.ts`                                                                  |
| tika                                        | `apps/paperless/app.ts`                                                                  |
| cloudflared                                 | `apps/cloudflared/app.ts`                                                                |
| exportarr sidecars                          | `lib/media-app.ts` (shared across all `*arr` media apps that carry an exportarr sidecar) |

## Group B — Permanent `runAsNonRoot` opt-outs

These stay on `DEFAULT_SECURITY_CONTEXT`. Evidence gathered shows the image genuinely requires root, so there's no further work item here — re-verify only if the upstream image changes its entrypoint model:

- **All LSIO/s6 images** — sonarr, radarr, lidarr, sabnzbd, prowlarr, resilio-sync, pfwiki/bookstack, manyfold, paperless-ngx. `s6-svscan` runs as PID 1 as root and does the PUID/PGID step-down itself; forcing non-root breaks that init path.
- **pure-ftpd** — needs root for privilege separation.
- **smtp/postfix** — `USER=root` by design.
- **monica** — root Apache prefork model.
- **immich** (all 3 workloads: server, microservices, machine-learning) — upstream doesn't support rootless operation.

## Group C — `NEEDS_RUNTIME_TEST`

Image runs as root today, but there's no _proven_ requirement for it the way there is for Group B. Untested — test one at a time, not as a batch, since a bad guess here breaks a running app:

| App                                                            | Notes                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bookmarks/linkwarden                                           | Best-effort guess, not yet probed                                                                                                                                                                                                                                                                             |
| home/starbase-80                                               | Best-effort guess, not yet probed                                                                                                                                                                                                                                                                             |
| homebox                                                        | **Best candidate.** Static Go binary, runs as root with no step-down — looks like an unexamined packaging default rather than a real requirement                                                                                                                                                              |
| paste/microbin                                                 | Same shape as homebox                                                                                                                                                                                                                                                                                         |
| tautulli                                                       | Entrypoint does a `gosu` step-down. Kubelet's `runAsNonRoot` check is **static** (checks the image's declared USER, not what the entrypoint execs into), so this needs an explicit `runAsUser` set _and_ a real test — just flipping `ensureNonRoot` would fail since the image itself is still declared root |
| mealie                                                         | Same `gosu` step-down caveat as tautulli                                                                                                                                                                                                                                                                      |
| wizarr                                                         | Runs `uv` as root; leans toward opt-out rather than fixable                                                                                                                                                                                                                                                   |
| romm                                                           | gunicorn/rq worker processes run as root continuously (not just at startup); leans toward opt-out                                                                                                                                                                                                             |
| navidrome                                                      | Binary runs as root, no step-down; docs mention UID/GID env vars, so may be fixable                                                                                                                                                                                                                           |
| klipper-exporter                                               | Low risk, just hasn't been gotten to                                                                                                                                                                                                                                                                          |
| unifi-exporter                                                 | Low risk, just hasn't been gotten to                                                                                                                                                                                                                                                                          |
| paperless-ai                                                   | Not yet probed                                                                                                                                                                                                                                                                                                |
| external-dns (main deployments, not the unifi-webhook sidecar) | `USER='0'` in the image, but it's a stateless Go binary — commonly run non-root elsewhere, likely just needs `runAsUser` set explicitly                                                                                                                                                                       |

## Future Phase: `readOnlyRootFilesystem`

Not started. Candidates once Phase 1 settles:

1. **Best candidates**: miniflux, noms — no volumes, external DB, nothing else likely to want to write to the rootfs.
2. **Next**: gotenberg, tika, atuin, cloudflared, exportarr — all need a `/tmp` `emptyDir` mounted first (these write to `/tmp` during normal operation).
3. **Effectively permanent opt-outs**: all the Group B apps (LSIO/s6, monica, postfix, pure-ftpd) — same reasoning as the `runAsNonRoot` opt-out, a read-only rootfs would break the same root-required init/privilege-separation paths.

## Special Cases

- **`lib/mysql.ts`** hardcodes its own permissive security context — it does **not** consume `DEFAULT_SECURITY_CONTEXT` from `lib/consts.ts`, so it's outside this rollout entirely today. monica and pfwiki's MariaDB pods run `mariadbd` as uid 999 via an entrypoint step-down. Forcing `runAsUser: 999` directly would skip the first-boot `chown` the entrypoint does on the data directory, so this needs a scratch-PVC test (fresh volume, confirm first-boot init still succeeds) before it can be changed.
- **`lib/valkey.ts`** already pins `runAsUser: 999` explicitly — no change needed, already hardened.

## Verification Method

Verdicts above came from live probes against running pods, not just reading Dockerfiles:

- `kubectl exec <pod> -- id` and `cat /proc/1/status` to see what PID 1 and the app process actually run as at runtime.
- `skopeo inspect --config <image>` to check the image's declared `USER` field without pulling the full image.

Probes were run 2026-07-05. Re-verify before changing an image's pinned tag/digest, since a new upstream release can change the entrypoint model out from under a verdict recorded here.
