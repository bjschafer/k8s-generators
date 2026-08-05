import { App, Chart } from "cdk8s";
import { IntOrString, KubeService } from "cdk8s-plus-34/lib/imports/k8s";
import { Construct } from "constructs";
import { basename } from "path";
import {
  ObjectStore,
  ObjectStoreSpecConfigurationDataCompression,
  ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests,
} from "../../imports/barmancloud.cnpg.io";
import { Quantity } from "../../imports/k8s";
import { VmPodScrape } from "../../imports/operator.victoriametrics.com";
import {
  Cluster,
  ClusterSpec,
  ClusterSpecBootstrapInitdbImportType,
  Database,
  DatabaseSpecDatabaseReclaimPolicy,
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
  BACKUP_ANNOTATION_EXCLUDE,
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
          name: "postgresql-minimal-trixie",
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
            cpu: Quantity.fromString("1"),
            memory: Quantity.fromString("2Gi"),
          },
          limits: {
            cpu: Quantity.fromString("1"),
            memory: Quantity.fromString("2Gi"),
          },
        },
        inheritedMetadata: {
          labels: { [BACKUP_ANNOTATION_EXCLUDE]: "true" },
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
            // minimal-trixie image has no locales installed; must use C
            lc_messages: "C",
            lc_monetary: "C",
            lc_numeric: "C",
            lc_time: "C",
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
            server_idle_timeout: "600",
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
        retentionPolicy: "30d",
        configuration: {
          endpointUrl: "https://s3.cmdcentral.xyz",
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
          data: {
            compression: ObjectStoreSpecConfigurationDataCompression.GZIP,
          },
        },
        instanceSidecarConfiguration: {
          resources: {
            requests: {
              memory:
                ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("512Mi"),
              cpu: ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("1"),
            },
            limits: {
              memory:
                ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("512Mi"),
              cpu: ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("1"),
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
        schedule: "0 0 1 * * *",
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
   * Get the cluster name for connection strings.
   */
  public get clusterName(): string {
    return this.Cluster.name;
  }
}

/**
 * The vectorchord image catalog is a namespace singleton -- every
 * VectorPostgres cluster resolves its image through this one object, so it
 * lives in its own chart rather than inside the per-cluster class. Two
 * clusters instantiating their own copy would emit the same
 * `ImageCatalog/vectorchord` twice.
 */
class VectorImageCatalog extends Chart {
  readonly Catalog: ImageCatalog;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const imageBase = "ghcr.io/tensorchord/cloudnative-vectorchord";
    // Tags are `<pgMajor>.<pgMinor>-<vectorchordVersion>`, and the repository
    // publishes every Postgres major side by side -- 18.3-1.1.0 sits right
    // next to 17.10-1.1.1. So each entry is pinned to its own const with a
    // depName scoped to one major line, and renovate.json caps each with
    // `allowedVersions`. Without that ceiling Renovate would read these as
    // ordinary versions and happily offer 18.x here, which is not an image
    // bump but an in-place Postgres major upgrade of a live database.
    // Those rules also switch automerge off: everything else in this repo
    // automerges minor/patch on green, and a Postgres image is not something
    // to let through unread.
    //
    // The vectorchord version is also bounded by immich, which checks it at
    // startup and refuses to boot outside `>=0.3.0 <2.0.0`; the bundled
    // pgvector must stay `>=0.7 <0.9`.
    // renovate: datasource=docker depName=vectorchord-pg17 packageName=ghcr.io/tensorchord/cloudnative-vectorchord versioning=loose
    const vectorchordPg17 = "17.10-1.1.1";

    this.Catalog = new ImageCatalog(this, "catalog", {
      metadata: {
        namespace: namespace,
        name: "vectorchord",
      },
      spec: {
        // Only major 17. A major-16 entry sat here unselected for the life of
        // the catalog -- `immich-pg16` was the only candidate and it resolved
        // 17 -- and went with that cluster. Add a major back only when a
        // cluster actually asks for it, so every entry stays exercised.
        images: [
          {
            image: `${imageBase}:${vectorchordPg17}`,
            major: 17,
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

/**
 * Bootstrap by physically restoring another cluster's barman ObjectStore.
 *
 * Preferred over {@link ImportProps} when the source is a CNPG cluster on the
 * same Postgres major: a base-backup restore carries the extension catalog and
 * the prebuilt vchord indexes across byte for byte. A logical import would
 * instead re-run `CREATE EXTENSION` against whatever the target image ships
 * and rebuild every vector index from the dump -- the one operation in this
 * stack where a version skew between source and target actually bites.
 */
export interface RecoveryProps {
  /** ObjectStore holding the source cluster's base backups and WAL. */
  objectStoreName: string;
  /**
   * Barman server name within that store. Defaults to the source cluster's
   * name, since that is what CNPG writes under unless told otherwise.
   */
  serverName: string;
}

export interface VectorPostgresProps {
  /**
   * Names the Cluster, and by derivation its ObjectStore, scheduled backup,
   * Database CR and scrape config.
   */
  name: string;
  catalog: ImageCatalog;
  /** Logical (pg_dump) import from a live cluster. Mutually exclusive with `recovery`. */
  import?: ImportProps;
  /** Physical restore from an object store. Mutually exclusive with `import`. */
  recovery?: RecoveryProps;
}

/**
 * The barman ObjectStore backing a vectorchord cluster.
 *
 * Split out of {@link VectorPostgres} because a store's lifetime is not its
 * cluster's. When a cluster is retired its store has to stay behind: it still
 * holds that lineage's base backups until the 30d retention expires, and it is
 * the `externalClusters` target named in whatever successor bootstrapped from
 * it. Deleting the two together would throw away the only copy of the data the
 * successor was seeded from.
 *
 * Note that a store is single-use in the other direction too -- barman refuses
 * to archive into a non-empty destination, so a rebuilt cluster needs its
 * prefix purged before it will come up.
 */
class VectorObjectStore extends Chart {
  constructor(scope: Construct, id: string, name: string) {
    super(scope, id);

    new ObjectStore(this, "object-store", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        retentionPolicy: "30d",
        configuration: {
          endpointUrl: "https://s3.cmdcentral.xyz",
          destinationPath: `s3://postgres/k8s/${name}`,
          data: {
            compression: ObjectStoreSpecConfigurationDataCompression.GZIP,
          },
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
                ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("512Mi"),
              cpu: ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("1"),
            },
            limits: {
              memory:
                ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("512Mi"),
              cpu: ObjectStoreSpecInstanceSidecarConfigurationResourcesRequests.fromString("1"),
            },
          },
        },
      },
    });
  }
}

class VectorPostgres extends Chart {
  constructor(scope: Construct, id: string, props: VectorPostgresProps) {
    super(scope, id);

    const { name, catalog, import: importProps, recovery } = props;

    if (importProps && recovery) {
      throw new Error(`${name}: cannot bootstrap from both an import and a recovery`);
    }

    type BootstrapConfig = Pick<ClusterSpec, "externalClusters" | "bootstrap">;

    const recoveryConfig: BootstrapConfig | undefined = recovery
      ? {
          bootstrap: {
            recovery: {
              source: recovery.serverName,
            },
          },
          externalClusters: [
            {
              name: recovery.serverName,
              plugin: {
                name: barmanPluginName,
                // Read-only pointer at the *source* cluster's store. The
                // cluster's own WAL archiving is the `plugins` stanza below,
                // which targets its own ObjectStore -- these are deliberately
                // different objects, so the restore never writes back into the
                // lineage it was seeded from.
                parameters: {
                  barmanObjectName: recovery.objectStoreName,
                  serverName: recovery.serverName,
                },
              },
            },
          ],
        }
      : undefined;

    const importConfig: BootstrapConfig | undefined = importProps
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
            },
          },
        }
      : undefined;

    new Cluster(this, name, {
      metadata: {
        namespace: namespace,
        name: name,
      },
      spec: {
        instances: 2,
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
        inheritedMetadata: {
          labels: { [BACKUP_ANNOTATION_EXCLUDE]: "true" },
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
              // Must track the ObjectStore created below, which is named off
              // `name`. These were separately hardcoded before, and agreed
              // only by coincidence.
              barmanObjectName: name,
            },
          },
        ],
        ...importConfig,
        ...recoveryConfig,
      },
    });

    // Declaratively manages the vchord extension version inside the immich
    // database, since immich's own role doesn't own it (vchord requires
    // superuser to install/alter, so ownership can't be handed to immich) and
    // the operator reconciles this continuously - unlike postInitSql, which
    // only ever runs once against the `postgres` maintenance database.
    new Database(this, "immich-database", {
      metadata: {
        namespace: namespace,
        // Derived, not fixed: two VectorPostgres clusters coexist during a
        // cutover and would otherwise collide on a single `Database/immich`.
        name: `${name}-db`,
      },
      spec: {
        name: "immich",
        owner: "immich",
        cluster: { name },
        extensions: [{ name: "vector" }, { name: "vchord" }],
        // Already the CRD default, but stated explicitly: this CR gets
        // renamed and recreated across a cutover, and `delete` would take the
        // database with it. Deliberately no `version` pin on the extensions --
        // CNPG would then run ALTER EXTENSION UPDATE, and pgvector 0.9 is
        // outside immich's supported range.
        databaseReclaimPolicy: DatabaseSpecDatabaseReclaimPolicy.RETAIN,
      },
    });

    // Sibling chart, not a child: an ObjectStore outlives the Cluster that
    // filled it. See VectorObjectStore.
    new VectorObjectStore(scope, `${id}-object-store`, name);

    new ScheduledBackup(this, "nightly", {
      metadata: {
        name: `${name}-nightly`,
        namespace: namespace,
      },
      spec: {
        cluster: {
          name: name,
        },
        schedule: "0 30 1 * * *",
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
  createDatabaseRoles,
  createDatabases,
  createPostgresSecrets,
} from "./database-provisioning";

// Create secrets for all database credentials in postgres namespace
createPostgresSecrets(app);

// Create a DatabaseRole CR for each configured database owner role
createDatabaseRoles(app, prod_pg_17.clusterName);

// Create all Database CRDs
createDatabases(app, prod_pg_17.clusterName);

const vectorCatalog = new VectorImageCatalog(app, "vectorchord-catalog");

// Tombstone of the retired `immich-pg16` cluster, whose name lied twice: it
// ran Postgres 17, and it used VectorChord, not pgvecto.rs. The cluster itself
// was deleted 2026-08-04, nine days after `immich` below took over serving.
//
// Only the store remains, and only because the lineage it holds is not dead
// yet. It stays read-only -- nothing archives into it anymore -- and it is
// still the `externalClusters` target of the bootstrap stanza on `immich`.
// Delete this after 2026-08-25, when the 30d retention on the last backup of
// the old lineage (`immich-pg16-cutover-final`, 2026-07-26) has expired and
// `immich` has 30d of its own base backups to fall back on.
new VectorObjectStore(app, "immich-pg16-object-store", "immich-pg16");

// Physical restore of immich-pg16 under an honest name. Same image, same
// major, same extensions -- the only thing changing is the string. Bootstrapped
// once from the old cluster's object store and then archives to its own,
// deliberately starting a fresh PITR lineage rather than splicing into the
// old WAL timeline.
new VectorPostgres(app, "immich", {
  name: "immich",
  catalog: vectorCatalog.Catalog,
  recovery: {
    objectStoreName: "immich-pg16",
    serverName: "immich-pg16",
  },
});

app.synth();
