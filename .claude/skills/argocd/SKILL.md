---
name: argocd
description: Use when you want to check ArgoCD application/sync status or force an immediate sync instead of waiting for ArgoCD's reconciliation loop to notice a commit. Use when asked to "sync now", "force a sync", "push this to the cluster", "is it deployed yet", or "check argocd status".
---

# ArgoCD

Interact with the homelab ArgoCD instance to check sync/health status and force
immediate reconciliation, instead of waiting out the default polling interval.

**Server:** `https://argo.cmdcentral.xyz` (web UI — for humans)
**App naming:** one Application per `apps/<name>` folder in this repo, named
and namespaced to match (see root `CLAUDE.md`). `kubectl -n argocd get app` is
the source of truth if unsure.

## Auth: none needed — drive the Application CRs with kubectl

Everything below uses the user's existing kubeconfig. There is **no API token,
nothing to expire, and no SSO login**. ArgoCD's `Application` CRs are the same
API the CLI writes to, so `kubectl` reaches the identical machinery.

### Do not reintroduce an `argocd` CLI API token

A previous version of this skill used a non-expiring token for the local
`bschafer` account. **It cannot work, and regenerating it will not help.**

ArgoCD stores the registry of valid token IDs in the `accounts.bschafer.tokens`
key of the `argocd-secret` Secret. That Secret is wholly owned
(`ownerReferences[].controller: true`) by a **SealedSecret**, defined in the
separate `k8s-prod` repo at `argocd/sealedsecret.argocd-secret.yaml`, which
seals that exact key to the literal value `null`. So every sealed-secrets
reconcile rewrites the token list to empty, silently revoking any token created
with `argocd account generate-token`. The symptom is:

```
rpc error: code = Unauthenticated desc = invalid session:
account bschafer does not have token with id <uuid>
```

which reads like a normal expiry but recurs every few days. Fixing it properly
means re-sealing `argocd-secret` without the `tokens` key and adding
`sealedsecrets.bitnami.com/patch: "true"` so the controller stops pruning keys
it doesn't own — a change in the *other* repo. Until someone does that, use
kubectl.

## Quick Reference

| Goal | Command |
|------|---------|
| List all apps + sync/health | `kubectl -n argocd get app` |
| Status of one app | `kubectl -n argocd get app <app> -o custom-columns=SYNC:.status.sync.status,HEALTH:.status.health.status,REV:.status.sync.revision` |
| Nudge a refresh (cheap) | `kubectl -n argocd annotate app <app> argocd.argoproj.io/refresh=hard --overwrite` |
| Force a sync now | `.operation` patch — see below |
| Which resources are out of sync | `kubectl -n argocd get app <app> -o jsonpath='{.status.resources}'` |
| Sync history | `kubectl -n argocd get app <app> -o jsonpath='{.status.history}'` |
| Why did the last sync fail | `kubectl -n argocd get app <app> -o jsonpath='{.status.operationState.message}'` |

All 53 apps run with `syncPolicy.automated.selfHeal: true`, which is why the
cheap refresh below is usually sufficient.

## Common Workflows

### Force a sync after pushing a commit

ArgoCD polls the repo on an interval (and this repo also has webhook-based
refresh), so most of the time a sync happens within seconds. Use this when you
don't want to wait.

**Option 1 — hard refresh (preferred, cheapest).** Re-pulls git and re-renders
manifests. Because every app has `automated.selfHeal`, any resulting drift
auto-syncs immediately. The controller consumes and removes the annotation.

```bash
kubectl -n argocd annotate app <app> argocd.argoproj.io/refresh=hard --overwrite
```

**Option 2 — explicit sync operation.** The exact thing `argocd app sync` does
under the hood: write `.operation` on the Application. Use when you want a real
sync operation recorded in history, or want to block on the result.

```bash
kubectl -n argocd patch app <app> --type merge \
  -p '{"operation":{"initiatedBy":{"username":"claude-code-skill"},"sync":{"syncStrategy":{"hook":{}}}}}'
```

Omitting `sync.revision` makes it sync the app's own `targetRevision`
(`HEAD` or `main` here), which is what you almost always want.

### Sync and block until it finishes

`.status.operationState` still holds the *previous* operation's result for a
moment after you patch, so polling `phase` alone races. Capture `startedAt`
first and wait for it to change:

```bash
app=<app>
prev=$(kubectl -n argocd get app "$app" -o jsonpath='{.status.operationState.startedAt}')
kubectl -n argocd patch app "$app" --type merge \
  -p '{"operation":{"initiatedBy":{"username":"claude-code-skill"},"sync":{"syncStrategy":{"hook":{}}}}}'

for i in $(seq 60); do
  sleep 5
  read -r started phase < <(kubectl -n argocd get app "$app" \
    -o jsonpath='{.status.operationState.startedAt}{" "}{.status.operationState.phase}')
  [ "$started" != "$prev" ] || continue          # still the old operation
  case "$phase" in Succeeded|Failed|Error) break ;; esac
done

kubectl -n argocd get app "$app" -o jsonpath='phase={.status.operationState.phase}{"\n"}msg={.status.operationState.message}{"\n"}'
```

### Wait for healthy + synced without triggering anything

```bash
kubectl -n argocd wait app/<app> --for=jsonpath='{.status.health.status}'=Healthy --timeout=300s
kubectl -n argocd wait app/<app> --for=jsonpath='{.status.sync.status}'=Synced --timeout=300s
```

### Check status across everything (e.g. after a broad change)

```bash
kubectl -n argocd get app
```

Or just the problems:

```bash
kubectl -n argocd get app -o json | jq -r '
  .items[]
  | select(.status.sync.status != "Synced" or .status.health.status != "Healthy")
  | "\(.metadata.name)\t\(.status.sync.status)\t\(.status.health.status)"'
```

### See what's drifted

There is no kubectl equivalent of `argocd app diff`'s rendered manifest diff,
but the per-resource verdict is on the CR:

```bash
kubectl -n argocd get app <app> -o json | jq -r '
  .status.resources[] | select(.status != "Synced")
  | "\(.kind)/\(.name)\t\(.status)"'
```

Empty output means live state matches desired state.

## Limitations — these still need the interactive CLI

Two things genuinely need an authenticated `argocd` client. Ask the user to run
`argocd login argo.cmdcentral.xyz --sso` in their own terminal (it needs a
browser and will hang in a non-interactive session), then run the command
themselves:

- **`argocd app diff <app>`** — rendered desired-vs-live manifest diff.
- **`argocd app rollback <app> <id>`** — and note rollback fights `selfHeal`:
  with automated sync on, the controller drags the app straight back to
  `targetRevision`. A real rollback means reverting the commit in git, not
  rolling back in ArgoCD.

## Notes

- Patching `.operation` and annotating for refresh are ArgoCD's own sanctioned
  control surface — they apply exactly what is committed to `main`. This is
  *not* the same as `kubectl apply` of a manifest, which the root `CLAUDE.md`
  prohibits.
- Only use kubectl against `Application` CRs in the `argocd` namespace for
  status and sync. Don't reach around ArgoCD to mutate managed workloads.
- If reported drift doesn't match your local `dist/`, run `mise run build`
  first — you may be looking at stale generated manifests.
