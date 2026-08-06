---
name: argocd
description: Use when you want to check ArgoCD application/sync status or force an immediate sync instead of waiting for ArgoCD's reconciliation loop to notice a commit. Use when asked to "sync now", "force a sync", "push this to the cluster", "is it deployed yet", or "check argocd status".
---

# ArgoCD

Interact with the homelab ArgoCD instance to check sync/health status and force
immediate reconciliation, instead of waiting out the default polling interval.

**Server:** `https://argo.cmdcentral.xyz`
**App naming:** one Application per `apps/<name>` folder in this repo, named
and namespaced to match (see root `CLAUDE.md`). `argo app list` is the source
of truth if unsure.

## Auth (already set up — no browser SSO needed)

Interactive `argocd login --sso` requires a browser and will hang in a
non-interactive session. Instead this skill uses a pre-generated, non-expiring
API token for the local `bschafer` account (mapped to `role:admin` in
`argocd-rbac-cm` — same privilege as your SSO login).

The token is stored as the atuin dotfiles var `ARGOCD_GENERATORS_TOKEN` (synced
via the user's own atuin server, same pattern as `NETBOX_TOKEN`/`PVE_TOKEN_*`).
It is deliberately **not** named `ARGOCD_AUTH_TOKEN` — that name is what the
`argocd` CLI reads natively, and exporting it globally would silently replace
the user's SSO identity with this admin API token for *all* their everyday
interactive `argocd` usage on every machine. A local fallback copy also lives
at `~/.config/argocd/generators-skill.token` (chmod 600) for sessions where
the atuin var hasn't propagated yet. **Never** print either value, copy it
into a file inside this repo, or put it in a commit — this repo is public
([[project_generators_repo_is_public]]).

Every command in this skill must be run through this wrapper so it uses the
token instead of the SSO session context:

```bash
argo() {
  local token="${ARGOCD_GENERATORS_TOKEN:-$(cat ~/.config/argocd/generators-skill.token 2>/dev/null)}"
  ARGOCD_AUTH_TOKEN="$token" command argocd --server argo.cmdcentral.xyz "$@"
}
```

Define that shell function once per session, then use `argo` in place of
`argocd` for every example below.

### If the token stops working

The token has no expiry, so this should only happen if it was revoked. Regenerate it
(requires an interactive `argocd login --sso` from the user first — ask them to run it):

```bash
argocd login argo.cmdcentral.xyz --sso
NEW_TOKEN=$(argocd account generate-token --account bschafer)
atuin dotfiles var set ARGOCD_GENERATORS_TOKEN "$NEW_TOKEN"
echo "$NEW_TOKEN" > ~/.config/argocd/generators-skill.token
chmod 600 ~/.config/argocd/generators-skill.token
```

## Quick Reference

| Goal | Command |
|------|---------|
| List all apps + sync/health status | `argo app list` |
| Status of one app | `argo app get <app>` |
| Diff live vs. desired manifests | `argo app diff <app>` |
| Force sync now | `argo app sync <app>` |
| Sync and block until done | `argo app sync <app> --timeout 300` |
| Wait for healthy+synced (no sync trigger) | `argo app wait <app> --health` |
| Sync history | `argo app history <app>` |
| Rollback to a previous revision | `argo app rollback <app> <history-id>` |
| Tail live resource tree | `argo app resources <app>` |

## Common Workflows

### Force a sync after pushing a commit

ArgoCD polls the repo on an interval (and this repo also has webhook-based
refresh), so most of the time a sync happens within seconds. Use this when you
don't want to wait, or need to confirm a change actually landed:

```bash
argo app get <app>              # check current sync/health status first
argo app sync <app> --timeout 300
```

`app sync` triggers a hard refresh + sync in one step — no need to call
`app get --hard-refresh` separately first.

### Confirm what will change before syncing

```bash
argo app diff <app>
```

Empty output means live state already matches desired state.

### Check status across everything (e.g. after a broad change)

```bash
argo app list
```

Look for `OutOfSync` or non-`Healthy` in the output; investigate those with
`argo app get <app>` before syncing individually.

## Notes

- This is a **full-admin** credential. Only use it for read/status checks and
  syncing — don't use it to poke around unrelated cluster config.
- Syncing via ArgoCD is the GitOps-sanctioned path — it applies exactly what's
  committed to `main`. This is different from `kubectl apply`, which the root
  `CLAUDE.md` prohibits.
- If `argo app sync` reports drift that doesn't match your local `dist/`, run
  `mise run build` first — you may be looking at stale generated manifests.
