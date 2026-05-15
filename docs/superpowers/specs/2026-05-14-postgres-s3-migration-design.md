# Postgres WAL Archiving Migration: Garage → VersityGW

**Date:** 2026-05-14  
**Status:** Approved

## Background

The homelab S3 backend is being migrated from Garage (`garage.cmdcentral.xyz`) to VersityGW (`s3.cmdcentral.xyz`). Data is being rclone-synced between the two backends. This spec covers migrating the CloudNative-PG WAL archiving and base backup configuration to use VersityGW.

A previous migration caused operational impact due to WAL archiving failing silently after a config change. This design includes explicit verification steps to catch that failure mode.

## Scope

### Code changes

- `apps/postgres/app.ts`: update `endpointUrl` on both `ObjectStore` resources
  - `prod` (used by `prod-pg17` cluster): `https://garage.cmdcentral.xyz` → `https://s3.cmdcentral.xyz`
  - `immich-pg16` (used by `immich-pg16` VectorChord cluster): same change

### Out of scope

- `destinationPath` on both ObjectStores — unchanged (`s3://postgres/k8s/prod-pg17`, `s3://postgres/k8s/immich-pg16`)
- Bitwarden item IDs — unchanged; only the credential *values* inside Bitwarden are updated by the operator
- Cluster plugin config (`barmanObjectName` references)
- Velero — already migrated to VersityGW

## Decision: fresh recovery baseline

Rather than relying on PITR continuity through the rclone-synced WAL chain (which cannot be easily verified for gaps), the migration takes a fresh base backup on VersityGW immediately after cutover. PITR is valid from that backup's timestamp onward.

## Cutover procedure

Steps must be followed in order. Do not proceed to the next step until the current one is confirmed.

1. **Confirm rclone sync is current** — verify the sync has run recently so VersityGW has an up-to-date copy of existing data.

2. **Update Bitwarden values** — update the credential values for the `s3-creds` items (ACCESS_KEY_ID: `a7b27d51-1545-477a-bc21-b34700071d0c`, SECRET_ACCESS_KEY: `8210d5a6-1ab4-4c89-a58b-b34700071d12`) to the VersityGW credentials.

3. **Force External Secrets refresh:**
   ```bash
   kubectl annotate externalsecret s3-creds -n postgres \
     force-sync=$(date +%s) --overwrite
   ```

4. **Verify the k8s secret has the new values** — confirm the secret contains VersityGW credentials before changing the endpoint. This prevents the endpoint and credentials from being mismatched.

5. **Push the endpoint change** — commit and push the `endpointUrl` update for both ObjectStores. Wait for ArgoCD to sync and confirm both ObjectStore resources are updated in-cluster.

   > Brief WAL archiving failures will occur during the ArgoCD apply window. This is safe: the barman plugin retries, and `max_slot_wal_keep_size: 1GB` on both clusters ensures no WAL segments are dropped before archiving succeeds.

## Post-cutover verification

Complete all three checks before considering the migration done.

### 1. Check ContinuousArchiving condition

```bash
kubectl get cluster prod-pg17 -n postgres \
  -o jsonpath='{.status.conditions}' | jq
kubectl get cluster immich-pg16 -n postgres \
  -o jsonpath='{.status.conditions}' | jq
```

`ContinuousArchiving` condition must be `status: True` on both clusters.

### 2. Trigger manual base backups

Apply for both clusters:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: post-migration-baseline
  namespace: postgres
spec:
  cluster:
    name: prod-pg17   # repeat with immich-pg16
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
```

```bash
kubectl get backup -n postgres
```

Both backups must reach `Completed` phase. A `Failed` or stalled `Running` phase means the endpoint or credentials are wrong — roll back immediately.

### 3. Spot-check VersityGW

List the backup objects directly to confirm they landed:

```bash
# using aws CLI or rclone with VersityGW creds
aws s3 ls s3://postgres/k8s/ --endpoint-url https://s3.cmdcentral.xyz --recursive
```

## Rollback

If any verification step fails:

1. Revert the endpoint commit and push — ArgoCD restores both ObjectStores to `garage.cmdcentral.xyz`
2. Re-update Bitwarden values to the Garage credentials
3. Force External Secrets refresh (same annotation command)
4. Verify `ContinuousArchiving` condition returns to `True` on both clusters

Garage remains live throughout. No WAL data is lost due to the 1GB WAL keep buffer.
