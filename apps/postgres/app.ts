import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { basename } from "path";
import { Quantity } from "../../imports/k8s";
import {
  Cluster,
  ClusterSpecBackupBarmanObjectStoreWalCompression,
  ImageCatalog,
  ScheduledBackup,
} from "../../imports/postgresql.cnpg.io";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
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

class ProdPostgres extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Cluster(this, "cluster", {
      metadata: {
        namespace: namespace,
        name: "prod",
      },
      spec: {
        instances: 3,
        imageCatalogRef: {
          apiGroup: "postgresql.cnpg.io",
          kind: "ClusterImageCatalog",
          major: 16, // this is how we'd do an upgrade
          name: "postgresql",
        },
        monitoring: {
          enablePodMonitor: true,
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
          size: "5Gi",
          storageClass: StorageClass.CEPH_RBD,
        },
        enableSuperuserAccess: true,
        postgresql: {
          pgHba: [
            "host pdns pdns 10.0.10.0/24 scram-sha-256",
            "hostssl pdns pdns 10.0.10.0/24 scram-sha-256",
          ],
        },

        managed: {
          services: {
            additional: [
              {
                selectorType: "rw",
                serviceTemplate: {
                  metadata: {
                    name: "prod",
                    annotations: {
                      "external-dns.alpha.kubernetes.io/hostname":
                        "pg-prod.cmdcentral.xyz",
                    },
                  },
                  spec: {
                    type: "LoadBalancer",
                  },
                },
              },
            ],
          },
        },

        backup: {
          barmanObjectStore: {
            endpointUrl: "https://ceph.cmdcentral.xyz",
            destinationPath: "s3://postgres/k8s/prod",
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
      },
    });

    new ScheduledBackup(this, "nightly", {
      metadata: {
        name: "nightly",
        namespace: namespace,
      },
      spec: {
        cluster: {
          name: "prod",
        },
        schedule: "0 33 3 * * *",
      },
    });
  }
}

class VectorPostgres extends Chart {
  constructor(scope: Construct, id: string, name: string) {
    super(scope, id);

    const catalog = new ImageCatalog(this, "catalog", {
      metadata: {
        namespace: namespace,
        name: "pgvector",
      },
      spec: {
        images: [
          {
            // https://immich.app/docs/administration/postgres-standalone#prerequisites 0.3.0 is the latest supported pgvecto.rs
            image: "ghcr.io/tensorchord/cloudnative-pgvecto.rs:16.5-v0.3.0",
            major: 16,
          },
        ],
      },
    });

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
          major: 16, // this is how we'd do an upgrade
          name: catalog.name,
        },
        monitoring: {
          enablePodMonitor: true,
        },
        resources: {
          requests: {
            cpu: Quantity.fromString("250m"),
            memory: Quantity.fromString("768Mi"),
          },
          limits: {
            cpu: Quantity.fromString("250m"),
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
            endpointUrl: "https://ceph.cmdcentral.xyz",
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
        bootstrap: {
          pgBasebackup: {
            source: "source",
            database: "immich",
            owner: "immich",
          },
        },
        externalClusters: [
          {
            name: "source",
            connectionParameters: {
              host: "postgres.cmdcentral.xyz",
              username: "postgres",
              dbname: "immich",
              port: "5433",
            },
            password: {
              name: "old-immich-pw",
              key: "pw",
            },
          },
        ],

        postgresql: {
          sharedPreloadLibraries: ["vectors.so"],
        },
      },
    });
  }
}

new ProdPostgres(app, "prod");
new VectorPostgres(app, "immich", "immich");
app.synth();
