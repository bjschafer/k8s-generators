# PostgreSQL Database Management

This module provides declarative role and database management for CloudNativePG clusters.

## Overview

The `Database` construct allows you to:
1. Declare a database and its owner role
2. Automatically register the role with the cluster using CNPG's declarative role management
3. Create the database using the CNPG Database CRD

## Usage

### From the postgres app itself

```typescript
import { Database } from "../../lib/postgres/database";

const prod_pg_17 = new ProdPostgres(app, "prod");

// Create a database with its owner role
new Database(app, "my-app-db", {
  name: "myapp",
  owner: "myapp_user",
  namespace: "postgres",
  cluster: { name: prod_pg_17.clusterName },
  registerRole: prod_pg_17.addManagedRole.bind(prod_pg_17),
  passwordSecret: {
    name: "myapp-db-credentials", // Optional
  },
});
```

### From another app

First, export the cluster instance from `apps/postgres/app.ts`:

```typescript
// In apps/postgres/app.ts
const prod_pg_17 = new ProdPostgres(app, "prod");
export const PROD_CLUSTER = prod_pg_17; // Export the class instance, not just the Cluster
```

Then from another app (e.g., `apps/myapp/app.ts`):

```typescript
import { App } from "cdk8s";
import { PROD_CLUSTER } from "../postgres/app";
import { Database } from "../../lib/postgres/database";

const namespace = "myapp";
const app = new App();

// Create database before calling app.synth()
new Database(app, "myapp-db", {
  name: "myapp",
  owner: "myapp_user",
  namespace: "postgres", // Database resource lives in postgres namespace
  cluster: { name: PROD_CLUSTER.clusterName },
  registerRole: PROD_CLUSTER.addManagedRole.bind(PROD_CLUSTER),
  passwordSecret: {
    name: "myapp-db-credentials",
  },
  roleConfig: {
    // Optional: additional role configuration
    inRoles: ["pg_monitor"], // Grant additional role memberships
    comment: "MyApp database owner",
  },
});

// Create your app resources
// ...

app.synth();
```

## Password Management

### Option 1: With Password Secret

Create a secret for the database credentials:

```typescript
import { BitwardenSecret } from "../../lib/secrets";

const dbCreds = new BitwardenSecret(app, "myapp-db-creds", {
  name: "myapp-db-credentials",
  namespace: "postgres",
  data: {
    username: "your-bitwarden-item-id-for-username",
    password: "your-bitwarden-item-id-for-password",
  },
});

new Database(app, "myapp-db", {
  name: "myapp",
  owner: "myapp_user",
  namespace: "postgres",
  cluster: { name: PROD_CLUSTER.clusterName },
  registerRole: PROD_CLUSTER.addManagedRole.bind(PROD_CLUSTER),
  passwordSecret: {
    name: dbCreds.secretName,
  },
});
```

The secret must be of type `kubernetes.io/basic-auth` with `username` and `password` keys.

### Option 2: Without Password

If you omit `passwordSecret`, the role will be created without a password (trust-based authentication):

```typescript
new Database(app, "myapp-db", {
  name: "myapp",
  owner: "myapp_user",
  namespace: "postgres",
  cluster: { name: PROD_CLUSTER.clusterName },
  registerRole: PROD_CLUSTER.addManagedRole.bind(PROD_CLUSTER),
  // No passwordSecret = no password
});
```

## Advanced Configuration

### Additional Role Options

You can pass additional role configuration via `roleConfig`:

```typescript
new Database(app, "myapp-db", {
  name: "myapp",
  owner: "myapp_user",
  namespace: "postgres",
  cluster: { name: PROD_CLUSTER.clusterName },
  registerRole: PROD_CLUSTER.addManagedRole.bind(PROD_CLUSTER),
  roleConfig: {
    comment: "Application database owner",
    inRoles: ["pg_monitor", "pg_signal_backend"],
    connectionLimit: 50,
    inherit: true,
    superuser: false,
    createDb: false,
    createRole: false,
    replication: false,
    bypassRls: false,
  },
});
```

### Removing a Database

To remove a database and its owner role, set `ensure` to `ABSENT`:

```typescript
import { DatabaseSpecEnsure } from "../../imports/postgresql.cnpg.io";

new Database(app, "myapp-db", {
  name: "myapp",
  owner: "myapp_user",
  namespace: "postgres",
  cluster: { name: PROD_CLUSTER.clusterName },
  registerRole: PROD_CLUSTER.addManagedRole.bind(PROD_CLUSTER),
  ensure: DatabaseSpecEnsure.ABSENT,
});
```

## Important Notes

1. **Registration before synthesis**: The `Database` construct must be instantiated before `app.synth()` is called, as it needs to register the role with the cluster before the cluster manifest is generated.

2. **Namespace**: The Database CRD resource is created in the specified `namespace` (typically `postgres`), but the actual database exists within the PostgreSQL cluster.

3. **Role lifecycle**: CNPG manages the role lifecycle. If you modify role attributes directly in PostgreSQL, the operator will revert those changes during reconciliation.

4. **Role ownership**: The database owner role is automatically created with the `login` privilege. The role owns the database and can manage it.

## Connection Information

After the database is created, you can connect to it using:

- **Host**: `<cluster-name>-rw.<namespace>.svc.cluster.local` (read-write service)
- **Port**: `5432`
- **Database**: The name you specified
- **Username**: The owner you specified
- **Password**: From the secret you specified (if using password authentication)

For the production cluster with a pooler:

- **Host**: `<cluster-name>-pooler-rw.<namespace>.svc.cluster.local`
- **Port**: `5432`
