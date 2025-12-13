import { App, Chart } from "cdk8s";
import { IntOrString, KubeService } from "cdk8s-plus-33/lib/imports/k8s";
import { Construct } from "constructs";
import { basename } from "path";
import {
  ObjectStore,
  ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests,
} from "../../imports/barmancloud.cnpg.io";
import { Quantity } from "../../imports/k8s";
import { VmPodScrape } from "../../imports/operator.victoriametrics.com";
import {
  Cluster,
  ClusterSpec,
  ClusterSpecBootstrapInitdbImportType,
  ClusterSpecManagedRoles,
  ImageCatalog,
  Pooler,
  PoolerSpecPgbouncerPoolMode,
  PoolerSpecType,
  ScheduledBackup,
  ScheduledBackupSpecBackupOwnerReference,
  ScheduledBackupSpecMethod,
} from "../../imports/postgresql.cnpg.io";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import {
  DEFAULT_APP_PROPS,
  EXTERNAL_DNS_ANNOTATION_KEY,
} from "../../lib/consts";
import { BitwardenSecret } from "../../lib/secrets";
import { StorageClass } from "../../lib/volume";

const namespace = basename(__dirname);

const app = new App(DEFAULT_APP_PROPS(namespace));

NewArgoApp(namespace, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.GENERATORS,
  recurse: true,
});

const s3Creds = new BitwardenSecret(app, "s3-creds", {
  name: "s3-creds",
  namespace: namespace,
  data: {
    ACCESS_KEY_ID: "a7b27d51-1545-477a-bc21-b34700071d0c",
    SECRET_ACCESS_KEY: "8210d5a6-1ab4-4c89-a58b-b34700071d12",
  },
});

const barmanPluginName = "barman-cloud.cloudnative-pg.io";

class ProdPostgres extends Chart {
  readonly Cluster: Cluster;
  private managedRoles: ClusterSpecManagedRoles[] = [];

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const name = "prod-pg17";

    this.Cluster = new Cluster(this, "cluster-17", {
      metadata: {
        namespace: namespace,
        name: name,
      },
      spec: {
        instances: 3,
        imageCatalogRef: {
          apiGroup: "postgresql.cnpg.io",
          kind: "ClusterImageCatalog",
          major: 17,
          name: "postgresql",
        },
        monitoring: {
          enablePodMonitor: false,
        },
        // prefer to schedule on non-pis
        affinity: {
          nodeAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: [
              {
                weight: 1,
                preference: {
                  matchExpressions: [
                    {
                      key: "kubernetes.io/arch",
                      operator: "NotIn",
                      values: ["arm64"],
                    },
                  ],
                },
              },
            ],
          },
        },
        resources: {
          requests: {
            cpu: Quantity.fromNumber(1),
            memory: Quantity.fromString("1Gi"),
          },
          limits: {
            cpu: Quantity.fromNumber(1),
            memory: Quantity.fromString("1Gi"),
          },
        },
        storage: {
          size: "15Gi",
          storageClass: StorageClass.CEPH_RBD,
        },
        enableSuperuserAccess: true,
        managed: {
          roles: this.managedRoles,
        },
        postgresql: {
          pgHba: [
            // Workaround for CNPG bug: pooler uses server cert (server auth EKU) instead of
            // pooler client cert (client auth EKU) when connecting to postgres.
            // This allows password auth for pooler before the fixed cert-only rule.
            // See: https://github.com/cloudnative-pg/cloudnative-pg/issues/8672
            "hostssl all cnpg_pooler_pgbouncer all scram-sha-256",
            "host pdns pdns 10.0.10.0/24 scram-sha-256",
            "hostssl pdns pdns 10.0.10.0/24 scram-sha-256",
          ],
          parameters: {
            max_slot_wal_keep_size: "1GB",
            max_connections: "200",
          },
        },
        plugins: [
          {
            name: barmanPluginName,
            isWalArchiver: true,
            parameters: {
              barmanObjectName: "prod",
            },
          },
        ],
      },
    });

    new Pooler(this, "pooler", {
      metadata: {
        name: `${name}-pooler-rw`, // cannot be same as cluster
        namespace: namespace,
      },
      spec: {
        cluster: {
          name: name,
        },

        instances: 3,
        type: PoolerSpecType.RW,
        pgbouncer: {
          poolMode: PoolerSpecPgbouncerPoolMode.SESSION,
          parameters: {
            max_client_conn: "1000",
            default_pool_size: "20",
            ignore_startup_parameters: "search_path",
          },
        },
      },
    });

    new KubeService(this, "lb-svc", {
      metadata: {
        name: "prod",
        namespace: namespace,
        annotations: {
          [EXTERNAL_DNS_ANNOTATION_KEY]: "pg-prod.cmdcentral.xyz",
        },
      },
      spec: {
        type: "LoadBalancer",
        ports: [
          {
            name: "pgbouncer",
            port: 5432,
            protocol: "TCP",
            targetPort: IntOrString.fromString("pgbouncer"),
          },
        ],
        selector: {
          "cnpg.io/poolerName": `${name}-pooler-rw`,
        },
      },
    });

    new ObjectStore(this, "object-store", {
      metadata: {
        name: "prod",
        namespace: namespace,
      },
      spec: {
        configuration: {
          endpointUrl: "https://garage.cmdcentral.xyz",
          destinationPath: "s3://postgres/k8s/prod-pg17",
          s3Credentials: {
            accessKeyId: {
              name: s3Creds.secretName,
              key: "ACCESS_KEY_ID",
            },
            secretAccessKey: {
              name: s3Creds.secretName,
              key: "SECRET_ACCESS_KEY",
            },
          },
        },
        instanceSidecarConfiguration: {
          resources: {
            requests: {
              memory:
                ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString(
                  "512Mi",
                ),
              cpu: ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString(
                "250m",
              ),
            },
            limits: {
              memory:
                ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString(
                  "512Mi",
                ),
              cpu: ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString(
                "250m",
              ),
            },
          },
        },
      },
    });

    new ScheduledBackup(this, "nightly", {
      metadata: {
        name: "nightly",
        namespace: namespace,
      },
      spec: {
        cluster: {
          name: name,
        },
        schedule: "0 33 3 * * *",
        backupOwnerReference: ScheduledBackupSpecBackupOwnerReference.SELF,
        method: ScheduledBackupSpecMethod.PLUGIN,
        pluginConfiguration: {
          name: barmanPluginName,
        },
      },
    });

    new VmPodScrape(this, "podscrape", {
      metadata: {
        name: "prod",
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            "cnpg.io/cluster": name,
          },
        },
        podMetricsEndpoints: [
          {
            port: "metrics",
          },
        ],
      },
    });
  }

  /**
   * Register a managed role with this cluster.
   * Must be called before app.synth().
   */
  public addManagedRole(role: ClusterSpecManagedRoles): void {
    this.managedRoles.push(role);
  }

  /**
   * Get the cluster name for connection strings.
   */
  public get clusterName(): string {
    return this.Cluster.name;
  }
}

export interface ImportProps {
  sourceClusterName: string;
  sourceClusterNamespace: string;
  databases: string[];
  roles: string[];
}

class VectorPostgres extends Chart {
  constructor(
    scope: Construct,
    id: string,
    name: string,
    importProps?: ImportProps,
  ) {
    super(scope, id);

    const imageBase = "ghcr.io/tensorchord/cloudnative-vectorchord";
    const catalog = new ImageCatalog(this, "catalog", {
      metadata: {
        namespace: namespace,
        name: "vectorchord",
      },
      spec: {
        images: [
          {
            image: `${imageBase}:16.9-0.4.3`,
            major: 16,
          },
          {
            image: `${imageBase}:17.5-0.4.3`,
            major: 17,
          },
        ],
      },
    });

    const importConfig:
      | Pick<ClusterSpec, "externalClusters" | "bootstrap">
      | undefined = importProps
      ? {
          externalClusters: [
            {
              name: importProps.sourceClusterName,
              connectionParameters: {
                host: `${importProps.sourceClusterName}-r.${importProps.sourceClusterNamespace}.svc.cluster.local`,
                user: "postgres",
                sslmode: "require",
              },
              password: {
                name: `${importProps.sourceClusterName}-superuser`,
                key: "password",
              },
            },
          ],
          bootstrap: {
            initdb: {
              import: {
                type: ClusterSpecBootstrapInitdbImportType.MONOLITH,
                databases: importProps.databases,
                roles: importProps.roles,
                source: {
                  externalCluster: importProps.sourceClusterName,
                },
              },
              postInitSql: ["CREATE EXTENSION IF NOT EXISTS vchord CASCADE;"],
            },
          },
        }
      : {
          bootstrap: {
            initdb: {
              postInitSql: ["CREATE EXTENSION IF NOT EXISTS vchord CASCADE;"],
            },
          },
        };

    new Cluster(this, name, {
      metadata: {
        namespace: namespace,
        name: name,
      },
      spec: {
        instances: 3,
        imageCatalogRef: {
          apiGroup: catalog.apiGroup,
          kind: catalog.kind,
          major: 17,
          name: catalog.name,
        },
        monitoring: {
          enablePodMonitor: false,
        },
        resources: {
          requests: {
            cpu: Quantity.fromString("600m"),
            memory: Quantity.fromString("768Mi"),
          },
          limits: {
            cpu: Quantity.fromString("600m"),
            memory: Quantity.fromString("768Mi"),
          },
        },
        storage: {
          size: "15Gi",
          storageClass: StorageClass.CEPH_RBD,
        },
        enableSuperuserAccess: true,

        postgresql: {
          sharedPreloadLibraries: ["vchord.so"],
          parameters: {
            max_slot_wal_keep_size: "1GB",
          },
        },
        plugins: [
          {
            name: barmanPluginName,
            isWalArchiver: true,
            parameters: {
              barmanObjectName: "prod",
            },
          },
        ],
        ...importConfig,
      },
    });

    new ObjectStore(this, "object-store", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        configuration: {
          endpointUrl: "https://garage.cmdcentral.xyz",
          destinationPath: `s3://postgres/k8s/${name}`,
          s3Credentials: {
            accessKeyId: {
              name: s3Creds.secretName,
              key: "ACCESS_KEY_ID",
            },
            secretAccessKey: {
              name: s3Creds.secretName,
              key: "SECRET_ACCESS_KEY",
            },
          },
        },
        instanceSidecarConfiguration: {
          resources: {
            requests: {
              memory:
                ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString(
                  "512Mi",
                ),
              cpu: ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString(
                "250m",
              ),
            },
            limits: {
              memory:
                ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString(
                  "512Mi",
                ),
              cpu: ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString(
                "250m",
              ),
            },
          },
        },
      },
    });

    new ScheduledBackup(this, "nightly", {
      metadata: {
        name: `${name}-nightly`,
        namespace: namespace,
      },
      spec: {
        cluster: {
          name: name,
        },
        schedule: "0 33 4 * * *",
        backupOwnerReference: ScheduledBackupSpecBackupOwnerReference.SELF,
        method: ScheduledBackupSpecMethod.PLUGIN,
        pluginConfiguration: {
          name: barmanPluginName,
        },
      },
    });

    new VmPodScrape(this, "podscrape", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            "cnpg.io/cluster": name,
          },
        },
        podMetricsEndpoints: [
          {
            port: "metrics",
          },
        ],
      },
    });
  }
}

const prod_pg_17 = new ProdPostgres(app, "prod");
// Export the ProdPostgres instance so other apps can register databases
export const PROD_CLUSTER = prod_pg_17;

// Import database provisioning functions
import {
  createManagedRoles,
  createPostgresSecrets,
  createDatabases,
} from "./database-provisioning";

// Create secrets for all database credentials in postgres namespace
createPostgresSecrets(app);

// Register all managed roles with the cluster
createManagedRoles(prod_pg_17.addManagedRole.bind(prod_pg_17));

// Create all Database CRDs
createDatabases(app, prod_pg_17.clusterName);

new VectorPostgres(app, "immich-pg16", "immich-pg16");
app.synth();
