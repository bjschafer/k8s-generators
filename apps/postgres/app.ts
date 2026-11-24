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
  ClusterSpecPlugins,
  ClusterSpecBootstrapInitdbImportType,
  Database,
  DatabaseSpecDatabaseReclaimPolicy,
  ImageCatalog,
  Pooler,
  PoolerSpecPgbouncerPoolMode,
  PoolerSpecTemplateSpecContainersLivenessProbeTcpSocketPort,
  PoolerSpecType,
  ScheduledBackup,
  ScheduledBackupSpecBackupOwnerReference,
  ScheduledBackupSpecMethod,
} from "../../imports/postgresql.cnpg.io";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import {
  BACKUP_ANNOTATION_EXCLUDE,
  DEFAULT_APP_PROPS,
  externalDnsHostname,
  HOMELAB_CRITICAL_PRIORITY_CLASS,
} from "../../lib/consts";
import { OpenBaoSecret } from "../../lib/secrets";
import { StorageClass } from "../../lib/volume";
import { PgDump } from "./pg-dump";

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

const s3Creds = new OpenBaoSecret(app, "s3-creds", {
  name: "s3-creds",
  namespace: namespace,
  keys: ["ACCESS_KEY_ID", "SECRET_ACCESS_KEY"],
});

const barmanPluginName = "barman-cloud.cloudnative-pg.io";

/**
 * Spec shared by `prod-pg17` and its successor `prod` while both exist, so the
 * successor comes up as an exact twin and promotion changes nothing but the
 * name.
 */
const PROD_CLUSTER_SPEC: ClusterSpec = {
  instances: 3,
  priorityClassName: HOMELAB_CRITICAL_PRIORITY_CLASS,
  // Bumping this major is an offline in-place `pg_upgrade`, not an image
  // swap: the operator shuts every instance down, runs pg_upgrade
  // --link, then destroys and re-clones both replica PVCs. Only ever
  // move it one major at a time, and only between images of the same OS
  // family -- CNPG refuses to upgrade across distributions, and this
  // catalog is trixie top to bottom.
  imageCatalogRef: {
    apiGroup: "postgresql.cnpg.io",
    kind: "ClusterImageCatalog",
    major: 18,
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
      memory: Quantity.fromString("4Gi"),
    },
    limits: {
      cpu: Quantity.fromString("1"),
      memory: Quantity.fromString("4Gi"),
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
    parameters: {
      max_slot_wal_keep_size: "1GB",
      // Steady state is ~140. Headroom for bursts on top of the per-role
      // caps in databases.ts (DEFAULT_CONNECTION_LIMIT); idle backends
      // cost a few MB each against the 4Gi limit. Changing this restarts
      // the primary in place (primaryUpdateMethod: restart).
      max_connections: "300",
      // minimal-trixie image has no locales installed; must use C
      lc_messages: "C",
      lc_monetary: "C",
      lc_numeric: "C",
      lc_time: "C",
    },
  },
};

// Barman server name for the prod lineage. Pinned rather than defaulted to the
// cluster name, because it has to move with every major upgrade. pg_upgrade
// assigns a new system identifier and resets the timeline to 1, so an upgraded
// cluster archiving under its old server name would write timeline files that
// collide with the previous major's and leave one prefix holding two
// incompatible lineages. PITR does not cross a major boundary either way, so
// there is nothing to gain by keeping them together.
//
// Bump this in the same commit as `imageCatalogRef.major`, never separately:
// changing it early strands the current lineage's WAL, and changing it late is
// the collision above. The old prefix stays in the same ObjectStore and ages
// out on its own 30d retention, recoverable only by the previous major's image.
const PROD_SERVER_NAME = "prod-pg18";

function prodWalArchiver(objectStoreName: string): ClusterSpecPlugins {
  return {
    name: barmanPluginName,
    isWalArchiver: true,
    parameters: {
      barmanObjectName: objectStoreName,
      serverName: PROD_SERVER_NAME,
    },
  };
}

/**
 * `prod-pg17`, retired by the 2026-11-24 rename to `prod`.
 *
 * Hibernated rather than deleted: its PVCs are the rollback path until `prod`
 * has proven itself, and its `-replication`/`-ca` secrets back the inert
 * `externalClusters` entry on `prod`.
 *
 * Its archive moved to an ObjectStore of its own name so `prod` could take the
 * `prod` name for a fresh one. Same S3 path as before, so nothing moved in the
 * bucket. Retention is enforced by a running cluster's sidecar, and this one
 * has no pods, so the prefix never ages out on its own: purge
 * `s3://postgres/k8s/prod-pg17/` by hand when this chart goes.
 */
class RetiredProdPg17 extends Chart {
  static readonly NAME = "prod-pg17";

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const name = RetiredProdPg17.NAME;

    new PostgresObjectStore(scope, `${id}-object-store`, name);

    new Cluster(this, "cluster", {
      metadata: {
        namespace: namespace,
        name: name,
        annotations: { "cnpg.io/hibernation": "on" },
      },
      spec: {
        ...PROD_CLUSTER_SPEC,
        plugins: [prodWalArchiver(name)],
      },
    });

    // Suspended rather than repointed or deleted: `spec.cluster` is immutable,
    // and with `backupOwnerReference: self` deleting it garbage-collects every
    // Backup it ever made. Goes with the cluster.
    new ScheduledBackup(this, "nightly", {
      metadata: {
        name: "nightly",
        namespace: namespace,
      },
      spec: {
        cluster: {
          name: name,
        },
        suspend: true,
        schedule: "0 0 1 * * *",
        backupOwnerReference: ScheduledBackupSpecBackupOwnerReference.SELF,
        method: ScheduledBackupSpecMethod.PLUGIN,
        pluginConfiguration: {
          name: barmanPluginName,
        },
      },
    });
  }
}

class ProdPostgres extends Chart {
  readonly Cluster: Cluster;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const name = "prod";
    const retired = RetiredProdPg17.NAME;

    // Sibling chart, not a child: an ObjectStore outlives the Cluster that
    // filled it. See PostgresObjectStore.
    new PostgresObjectStore(scope, `${id}-object-store`, name);

    this.Cluster = new Cluster(this, "cluster", {
      metadata: {
        namespace: namespace,
        name: name,
      },
      spec: {
        ...PROD_CLUSTER_SPEC,
        // Promoted 2026-11-24 from a standalone replica of prod-pg17: seeded
        // from its last base backup, kept current by streaming from its
        // primary, and promoted once prod-pg17 was hibernated and the stream
        // had delivered its shutdown checkpoint. `bootstrap`, `replica` and
        // `externalClusters` now only record that lineage and are inert; they
        // go when prod-pg17 does.
        bootstrap: {
          recovery: {
            source: retired,
          },
        },
        replica: {
          enabled: false,
          source: retired,
        },
        externalClusters: [
          {
            name: retired,
            plugin: {
              name: barmanPluginName,
              parameters: {
                barmanObjectName: retired,
                serverName: PROD_SERVER_NAME,
              },
            },
            connectionParameters: {
              host: `${retired}-rw.${namespace}.svc`,
              user: "streaming_replica",
              sslmode: "verify-full",
              dbname: "postgres",
            },
            sslKey: { name: `${retired}-replication`, key: "tls.key" },
            sslCert: { name: `${retired}-replication`, key: "tls.crt" },
            sslRootCert: { name: `${retired}-ca`, key: "ca.crt" },
          },
        ],
        // A fresh lineage in its own store, starting at the promotion
        // timeline. barman requires the destination to be empty, which is why
        // nothing was archived before promotion.
        plugins: [prodWalArchiver(name)],
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
        // CNPG sets a readiness probe on pgbouncer but no liveness probe; the
        // operator merges this container by name into the generated pod.
        template: {
          spec: {
            priorityClassName: HOMELAB_CRITICAL_PRIORITY_CLASS,
            containers: [
              {
                name: "pgbouncer",
                resources: {
                  requests: {
                    cpu: Quantity.fromString("20m"),
                    memory: Quantity.fromString("96Mi"),
                  },
                  limits: { memory: Quantity.fromString("256Mi") },
                },
                livenessProbe: {
                  tcpSocket: {
                    port: PoolerSpecTemplateSpecContainersLivenessProbeTcpSocketPort.fromNumber(
                      5432,
                    ),
                  },
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
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

    // KubeService because the target is CNPG's *named* pgbouncer port, and
    // cdk8s-plus ServicePort only takes a number.
    new KubeService(this, "lb-svc", {
      metadata: {
        name: "prod",
        namespace: namespace,
        annotations: {
          ...externalDnsHostname("pg-prod.cmdcentral.xyz"),
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
        name: `${name}-nightly`,
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
    const vectorchordPg17 = "17.11-1.1.1";

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

export interface VectorPostgresProps {
  /**
   * Names the Cluster, and by derivation its ObjectStore, scheduled backup,
   * Database CR and scrape config.
   */
  name: string;
  catalog: ImageCatalog;
  /** Logical (pg_dump) import from a live cluster. */
  import?: ImportProps;
}

/**
 * A barman ObjectStore at `s3://postgres/k8s/<name>`.
 *
 * Its own chart because a store's lifetime is not its cluster's. When a
 * cluster is retired its store has to stay behind: it still holds that
 * lineage's base backups until the 30d retention expires, and it is the
 * `externalClusters` target named in whatever successor bootstrapped from it.
 * Deleting the two together would throw away the only copy of the data the
 * successor was seeded from.
 *
 * Note that a store is single-use in the other direction too -- barman refuses
 * to archive into a non-empty destination, so a rebuilt cluster needs its
 * prefix purged before it will come up.
 */
class PostgresObjectStore extends Chart {
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

    const { name, catalog, import: importProps } = props;

    type BootstrapConfig = Pick<ClusterSpec, "externalClusters" | "bootstrap">;

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
        priorityClassName: HOMELAB_CRITICAL_PRIORITY_CLASS,
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
    // filled it. See PostgresObjectStore.
    new PostgresObjectStore(scope, `${id}-object-store`, name);

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

const prod = new ProdPostgres(app, "prod");
// Export the ProdPostgres instance so other apps can register databases
export const PROD_CLUSTER = prod;

new RetiredProdPg17(app, "prod-pg17");

// Import database provisioning functions
import {
  createDatabaseRoles,
  createDatabases,
  createPostgresSecrets,
} from "./database-provisioning";

// Create secrets for all database credentials in postgres namespace
createPostgresSecrets(app);

// Create a DatabaseRole CR for each configured database owner role
createDatabaseRoles(app, prod.clusterName);

// Create all Database CRDs
createDatabases(app, prod.clusterName);

const vectorCatalog = new VectorImageCatalog(app, "vectorchord-catalog");

// Originally a physical restore of the retired `immich-pg16` cluster, whose
// name lied twice: it ran Postgres 17, and it used VectorChord, not
// pgvecto.rs. Cut over 2026-07-26. That cluster's object store has since been
// dropped, and the bootstrap stanza pointing at it with it, so this now
// declares the default initdb bootstrap -- the same as prod. A from-scratch
// rebuild has to be pointed at the `immich` store by hand.
new VectorPostgres(app, "immich", {
  name: "immich",
  catalog: vectorCatalog.Catalog,
});

// Nightly logical dumps onto a Velero-backed PVC. barman-cloud offers only
// server-side encryption, so the object stores above are readable by whoever
// holds the bucket; this is how the databases get an offsite copy that is not.
// It supplements barman rather than replacing it -- barman is still the only
// PITR here.
new PgDump(app, "pg-dump", {
  namespace: namespace,
  clusters: [prod.clusterName, "immich"],
});

app.synth();
