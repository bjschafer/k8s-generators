import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  ClusterSpecManagedRoles,
  ClusterSpecManagedRolesEnsure,
  Database as CnpgDatabase,
  DatabaseSpecEnsure,
} from "../../imports/postgresql.cnpg.io";
import { BitwardenSecret } from "../../lib/secrets";
import { DATABASES } from "./databases";

/**
 * Creates managed roles for all configured databases.
 * Call this to register roles with the cluster.
 */
export function createManagedRoles(
  addRoleCallback: (role: ClusterSpecManagedRoles) => void,
): void {
  for (const db of DATABASES) {
    const role: ClusterSpecManagedRoles = {
      name: db.name,
      ensure: ClusterSpecManagedRolesEnsure.PRESENT,
      login: true,
      comment: db.comment,
      ...db.roleConfig,
      // Only add password secret if one is configured
      ...(db.bitwardenPasswordId && {
        passwordSecret: {
          name: `${db.name}-db-credentials`,
        },
      }),
    };

    addRoleCallback(role);
  }
}

/**
 * Creates Bitwarden secrets for database credentials in the postgres namespace.
 * These secrets are referenced by the managed roles.
 */
export function createPostgresSecrets(scope: Construct): void {
  for (const db of DATABASES) {
    if (db.bitwardenPasswordId) {
      new BitwardenSecret(scope, `${db.name}-db-secret`, {
        name: `${db.name}-db-credentials`,
        namespace: "postgres",
        data: {
          password: db.bitwardenPasswordId,
        },
      });
    }
  }
}

/**
 * Creates Database CRDs for all configured databases.
 * Call this in the postgres app to create all databases at once.
 * Returns a Chart containing all the databases.
 */
export function createDatabases(scope: Construct, clusterName: string): Chart {
  const chart = new Chart(scope, "databases");

  for (const db of DATABASES) {
    new CnpgDatabase(chart, `db-${db.name}`, {
      metadata: {
        name: db.name,
        namespace: "postgres",
      },
      spec: {
        name: db.name,
        owner: db.name,
        cluster: { name: clusterName },
        ensure: DatabaseSpecEnsure.PRESENT,
      },
    });
  }

  return chart;
}

/**
 * Helper function to create a copy of database credentials in an app's namespace.
 * Call this from your app if it needs local access to the credentials.
 *
 * @param scope The scope to create the secret in (typically your app)
 * @param databaseName The name of the database from DATABASES
 *
 * @example
 * // In apps/romm/app.ts
 * const dbCreds = createAppDatabaseSecret(app, "romm");
 * // Use dbCreds.secretName in your deployment
 */
export function createAppDatabaseSecret(
  scope: Construct,
  databaseName: string,
): BitwardenSecret {
  const db = DATABASES.find((d) => d.name === databaseName);
  if (!db) {
    throw new Error(
      `Database '${databaseName}' not found in DATABASES configuration`,
    );
  }
  if (!db.appNamespace) {
    throw new Error(
      `Database '${databaseName}' does not have appNamespace configured`,
    );
  }
  if (!db.bitwardenPasswordId) {
    throw new Error(
      `Database '${databaseName}' does not have a password configured`,
    );
  }

  return new BitwardenSecret(scope, "db-credentials", {
    name: `${databaseName}-db-credentials`,
    namespace: db.appNamespace,
    data: {
      password: db.bitwardenPasswordId,
    },
  });
}
