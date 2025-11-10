# Centralized Database Management

This document explains how to add and manage PostgreSQL databases for the production cluster.

## Overview

Database configuration is centralized in two files:
- **`apps/postgres/databases.ts`** - Configuration only (edit this to add databases)
- **`apps/postgres/database-provisioning.ts`** - Implementation (don't edit)

This ensures:
- Declarative role management via CNPG
- Automatic Database CRD creation
- Consistent credential management across namespaces

## Adding a New Database

**Edit `apps/postgres/databases.ts`** and add to the `DATABASES` array:

```typescript
export const DATABASES: DatabaseConfig[] = [
  {
    name: "romm",
    comment: "ROMM database owner",
    bitwardenPasswordId: "your-bitwarden-id-here",
    appNamespace: "romm",
  },
  {
    name: "myapp",  // Add your new database here
    comment: "MyApp database owner",
    bitwardenPasswordId: "your-bitwarden-item-id",
    appNamespace: "myapp",
  },
];
```

That's it! When you run `make`, it will automatically:
1. Create the role in the Cluster's `.spec.managed.roles`
2. Create a Database CRD in the postgres namespace
3. Create credentials in the postgres namespace (for CNPG)
4. Create credentials in your app namespace (if `appNamespace` is set)

## Using Credentials in Your App

In your app's `app.ts`:

```typescript
import { createAppDatabaseSecret } from "../postgres/database-provisioning";

// This creates a copy of credentials in your namespace
const dbCreds = createAppDatabaseSecret(app, "myapp");

// Use dbCreds.secretName in your deployment
// The secret has 'username' and 'password' keys
```

## How It Works: Cross-Namespace Credentials

### The Challenge
- CNPG needs credentials in the **postgres** namespace (where the cluster lives)
- Your app needs credentials in **its own** namespace

### The Solution
Both namespaces get an `ExternalSecret` that references the **same Bitwarden item**:

**In postgres namespace:**
```yaml
# dist/postgres/ExternalSecret.myapp-db-credentials.yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: myapp-db-credentials
  namespace: postgres  # ← For CNPG to use
spec:
  data:
    - remoteRef:
        key: myapp-bitwarden-id  # ← Same Bitwarden item
      secretKey: password
```

**In app namespace:**
```yaml
# dist/myapp/ExternalSecret.myapp-db-credentials.yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: myapp-db-credentials
  namespace: myapp  # ← For your app to use
spec:
  data:
    - remoteRef:
        key: myapp-bitwarden-id  # ← Same Bitwarden item
      secretKey: password
```

Both secrets sync from the same Bitwarden item, so updating the password in Bitwarden updates both namespaces automatically.

## Generated Resources

For each database in `DATABASES`, the following are created:

### In postgres namespace:
1. **Managed Role** - Added to `Cluster.prod-pg17.yaml`:
   ```yaml
   managed:
     roles:
       - name: myapp
         login: true
         comment: "MyApp database owner"
         passwordSecret:
           name: myapp-db-credentials
   ```

2. **Database CRD** - `Database.myapp.yaml`:
   ```yaml
   apiVersion: postgresql.cnpg.io/v1
   kind: Database
   metadata:
     name: myapp
     namespace: postgres
   spec:
     cluster:
       name: prod-pg17
     name: myapp
     owner: myapp
   ```

3. **Credentials** - `ExternalSecret.myapp-db-credentials.yaml` in postgres namespace

### In app namespace (if appNamespace is set):
4. **Credentials** - `ExternalSecret.myapp-db-credentials.yaml` in app namespace

## Connection Information

Your app can connect using:

```bash
# Direct to cluster (not recommended in production)
Host: prod-pg17-rw.postgres.svc.cluster.local
Port: 5432

# Via PgBouncer pooler (recommended)
Host: prod-pg17-pooler-rw.postgres.svc.cluster.local
Port: 5432

# Database name: your database name (e.g., "myapp")
# Username: your database name (same as database)
# Password: from the secret in your namespace
```

Example connection string:
```
postgresql://myapp:${PASSWORD}@prod-pg17-pooler-rw.postgres.svc.cluster.local:5432/myapp
```

## Advanced Configuration

### Databases Without Passwords

For trust-based authentication, omit `bitwardenPasswordId`:

```typescript
{
  name: "trustdb",
  comment: "Trust-based database",
  // No bitwardenPasswordId
  appNamespace: "trustapp",
}
```

### Additional Role Options

Add custom role configuration via `roleConfig`:

```typescript
{
  name: "myapp",
  comment: "MyApp database owner",
  bitwardenPasswordId: "bitwarden-id",
  appNamespace: "myapp",
  roleConfig: {
    connectionLimit: 50,
    inRoles: ["pg_monitor"],  // Grant additional role memberships
  },
}
```

## Removing a Database

To remove a database and its role, simply remove it from the `DATABASES` array in `apps/postgres/databases.ts` and run `make`. The resources will be deleted on the next ArgoCD sync.

Note: You may want to backup the database before removing it!

## File Structure

- **`databases.ts`** - Pure configuration file. Only edit this to add/remove databases.
- **`database-provisioning.ts`** - Implementation. Contains all the logic for creating resources.
- **`app.ts`** - Main postgres app. Imports and calls functions from `database-provisioning.ts`.

## Troubleshooting

### Role not created
- Check `dist/postgres/Cluster.prod-pg17.yaml` for the role in `.spec.managed.roles`
- Ensure you've run `make` after updating `apps/postgres/databases.ts`

### Database not created
- Check `dist/postgres/Database.myapp.yaml` exists
- Verify the database name matches the role name

### Credentials not syncing
- Check that the Bitwarden item ID is correct
- Verify the ExternalSecret exists in both namespaces (if needed)
- Check External Secrets Operator logs

### Can't connect to database
- Verify the database and role were created: `kubectl get database -n postgres`
- Check CNPG operator logs for errors
- Ensure your app is using the correct service hostname
