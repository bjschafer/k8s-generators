import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { basename } from "path";
import { Quantity } from "../../imports/k8s";
import {
  Cluster,
  ClusterSpec,
  ClusterSpecBackupBarmanObjectStoreWalCompression,
  ClusterSpecBootstrapInitdbImportType,
  ImageCatalog,
  Pooler,
  PoolerSpecPgbouncerPoolMode,
  PoolerSpecType,
  ScheduledBackup,
} from "../../imports/postgresql.cnpg.io";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import {
  DEFAULT_APP_PROPS,
  EXTERNAL_DNS_ANNOTATION_KEY,
} from "../../lib/consts";
import { StorageClass } from "../../lib/volume";
import { VmPodScrape } from "../../imports/operator.victoriametrics.com";
import { IntOrString, KubeService } from "cdk8s-plus-32/lib/imports/k8s";

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

class ProdPostgres extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const name = "prod-pg17";

    new Cluster(this, "cluster-17", {
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
            cpu: Quantity.fromString("750m"),
            memory: Quantity.fromString("1Gi"),
          },
          limits: {
            cpu: Quantity.fromString("750m"),
            memory: Quantity.fromString("1Gi"),
          },
        },
        storage: {
          size: "15Gi",
          storageClass: StorageClass.CEPH_RBD,
        },
        enableSuperuserAccess: true,
        postgresql: {
          pgHba: [
            "host pdns pdns 10.0.10.0/24 scram-sha-256",
            "hostssl pdns pdns 10.0.10.0/24 scram-sha-256",
          ],
          parameters: {
            max_slot_wal_keep_size: "1GB",
            max_connections: "200",
          },
        },

        backup: {
          barmanObjectStore: {
            endpointUrl: "https://minio.cmdcentral.xyz",
            destinationPath: "s3://postgres/k8s/prod-pg17",
            s3Credentials: {
              accessKeyId: {
                name: "backups",
                key: "ACCESS_KEY_ID",
              },
              secretAccessKey: {
                name: "backups",
                key: "SECRET_ACCESS_KEY",
              },
            },
            wal: {
              compression:
                ClusterSpecBackupBarmanObjectStoreWalCompression.GZIP,
            },
          },
        },
        // import stuff
        externalClusters: [
          {
            name: "prod-pg16",
            connectionParameters: {
              host: "prod-r.postgres.svc.cluster.local",
              user: "postgres",
              sslmode: "require",
            },
            password: {
              name: "prod-superuser",
              key: "password",
            },
          },
        ],
        bootstrap: {
          initdb: {
            import: {
              type: ClusterSpecBootstrapInitdbImportType.MONOLITH,
              databases: [
                "atuin",
                "authentik",
                "gitea",
                "grafana",
                "hass",
                "linkwarden",
                "mealie",
                "miniflux",
                "netbox",
                "paperless",
                "pathfinder",
                "pathfinder_manual",
                "pdns",
                "spoolman",
              ],
              roles: [
                "atuin",
                "authentik",
                "gitea",
                "grafana",
                "grafanareader",
                "hass",
                "linkwarden",
                "mealie",
                "miniflux",
                "netbox",
                "paperless",
                "pathfinder",
                "pdns",
                "spoolman",
              ],
              source: {
                externalCluster: "prod-pg16",
              },
            },
          },
        },
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

    const oldCatalog = new ImageCatalog(this, "oldcatalog", {
      metadata: {
        namespace: namespace,
        name: "pgvector",
      },
      spec: {
        images: [
          {
            // https://immich.app/docs/administration/postgres-standalone#prerequisites 0.3.0 is the latest supported pgvecto.rs
            //image: "ghcr.io/tensorchord/cloudnative-pgvecto.rs:16.5-v0.3.0",
            image:
              "registry.cmdcentral.xyz/docker/misc/cnpg-pgvector-16.9-1-bookworm-v0.3.0:latest",
            major: 16,
          },
        ],
      },
    });

    const imageBase = "ghcr.io/tensorchord/cloudnative-vectorchord";
    const catalog = new ImageCatalog(this, "catalog", {
      metadata: {
        namespace: namespace,
        name: "vectorchord",
      },
      spec: {
        images: [
          {
            image: `${imageBase}:16.9-0.3.0`,
            major: 16,
          },
          {
            image: `${imageBase}:17.5-0.3.0`,
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
          major: 16,
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
          size: "5Gi",
          storageClass: StorageClass.CEPH_RBD,
        },
        enableSuperuserAccess: true,

        backup: {
          barmanObjectStore: {
            endpointUrl: "https://minio.cmdcentral.xyz",
            destinationPath: `s3://postgres/k8s/${name}`,
            s3Credentials: {
              accessKeyId: {
                name: "backups",
                key: "ACCESS_KEY_ID",
              },
              secretAccessKey: {
                name: "backups",
                key: "SECRET_ACCESS_KEY",
              },
            },
            wal: {
              compression:
                ClusterSpecBackupBarmanObjectStoreWalCompression.GZIP,
            },
          },
        },

        postgresql: {
          sharedPreloadLibraries: ["vchord.so"],
          parameters: {
            max_slot_wal_keep_size: "1GB",
          },
        },
        ...importConfig,
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

new ProdPostgres(app, "prod");
new VectorPostgres(app, "immich-pg16", "immich-pg16", {
  sourceClusterName: "immich",
  sourceClusterNamespace: "postgres",
  databases: ["immich"],
  roles: ["immich"],
});
app.synth();
