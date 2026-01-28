import { Chart } from "cdk8s";
import { ISecret, Secret } from "cdk8s-plus-32";
import { Construct } from "constructs";
import {
  ExternalSecret,
  ExternalSecretSpecDataFromSourceRefGeneratorRefKind,
  ExternalSecretSpecSecretStoreRefKind,
} from "../../imports/external-secrets.io";
import { Password } from "../../imports/generators.external-secrets.io";
import {
  ClusterSpecManagedRoles,
  ClusterSpecManagedRolesEnsure,
  Database as CnpgDatabase,
  DatabaseSpecEnsure,
} from "../../imports/postgresql.cnpg.io";
import { BitwardenSecret } from "../../lib/secrets";
import { DATABASES } from "./databases";

/**
 * Result from creating app database credentials.
 * Compatible with BitwardenSecret interface for backward compatibility.
 */
export interface AppDatabaseSecretResult {
  readonly secretName: string;
  readonly secret: ISecret;
}

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
      // All databases have password secrets (either from Bitwarden or auto-generated)
      passwordSecret: {
        name: `${db.name}-db-credentials`,
      },
    };

    addRoleCallback(role);
  }
}

/**
 * Creates secrets for database credentials in the postgres namespace.
 * Uses Bitwarden if bitwardenPasswordId is set, otherwise generates passwords.
 * These secrets are referenced by the managed roles.
 */
export function createPostgresSecrets(scope: Construct): void {
  const chart = new Chart(scope, "db-credentials");

  for (const db of DATABASES) {
    const secretName = `${db.name}-db-credentials`;

    if (db.bitwardenPasswordId) {
      // CNPG managed roles require both username and password keys in the secret.
      // Username must be a literal matching the role name, password from Bitwarden.
      new ExternalSecret(chart, `${db.name}-db-secret`, {
        metadata: {
          name: secretName,
          namespace: "postgres",
        },
        spec: {
          secretStoreRef: {
            kind: ExternalSecretSpecSecretStoreRefKind.CLUSTER_SECRET_STORE,
            name: "bitwarden",
          },
          data: [
            {
              secretKey: "password",
              remoteRef: {
                key: db.bitwardenPasswordId,
              },
            },
          ],
          target: {
            name: secretName,
            template: {
              type: "kubernetes.io/basic-auth",
              metadata: {
                labels: {
                  "cnpg.io/reload": "true",
                },
              },
              data: {
                username: db.name,
                password: "{{ .password }}",
              },
            },
          },
        },
      });
    } else {
      // Generate password using Password CRD
      const generatorName = `${db.name}-pg-password-generator`;
      const config = db.passwordGeneration ?? {};

      // Create the Password generator
      new Password(chart, `${db.name}-password-gen`, {
        metadata: {
          name: generatorName,
          namespace: "postgres",
        },
        spec: {
          length: config.length ?? 32,
          digits: config.digits ?? 6,
          symbols: config.symbols ?? 4,
          symbolCharacters: config.symbolCharacters ?? "-_$@",
          noUpper: false,
          allowRepeat: true,
        },
      });

      // Create ExternalSecret that uses the generator
      new ExternalSecret(chart, `${db.name}-db-secret`, {
        metadata: {
          name: secretName,
          namespace: "postgres",
        },
        spec: {
          // refreshInterval: "0" means generate once, never rotate
          refreshInterval: "0",
          dataFrom: [
            {
              sourceRef: {
                generatorRef: {
                  apiVersion: "generators.external-secrets.io/v1alpha1",
                  kind: ExternalSecretSpecDataFromSourceRefGeneratorRefKind.PASSWORD,
                  name: generatorName,
                },
              },
            },
          ],
          target: {
            name: secretName,
            template: {
              type: "kubernetes.io/basic-auth",
              metadata: {
                labels: {
                  "cnpg.io/reload": "true",
                },
              },
              data: {
                username: db.name,
                password: "{{ .password }}",
              },
            },
          },
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
 * For Bitwarden-backed passwords: Creates an ExternalSecret fetching from Bitwarden.
 * For generated passwords: Creates an ExternalSecret that copies from postgres namespace.
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
): AppDatabaseSecretResult {
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

  const secretName = `${databaseName}-db-credentials`;

  if (db.bitwardenPasswordId) {
    // Use Bitwarden to fetch password directly
    const bwSecret = new BitwardenSecret(scope, "db-credentials", {
      name: secretName,
      namespace: db.appNamespace,
      data: {
        password: db.bitwardenPasswordId,
      },
    });
    return {
      secretName: bwSecret.secretName,
      secret: bwSecret.secret,
    };
  } else {
    // Copy from postgres namespace using kubernetes ClusterSecretStore
    const chart = new Chart(scope, "db-credentials");

    new ExternalSecret(chart, "external-secret", {
      metadata: {
        name: secretName,
        namespace: db.appNamespace,
      },
      spec: {
        // Sync periodically from source secret
        refreshInterval: "1h",
        secretStoreRef: {
          kind: ExternalSecretSpecSecretStoreRefKind.CLUSTER_SECRET_STORE,
          name: "kubernetes",
        },
        data: [
          {
            secretKey: "password",
            remoteRef: {
              key: secretName,
              property: "password",
            },
          },
        ],
        target: {
          name: secretName,
        },
      },
    });

    return {
      secretName: secretName,
      secret: Secret.fromSecretName(scope, "db-secret-ref", secretName),
    };
  }
}
