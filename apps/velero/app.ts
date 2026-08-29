import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { basename, join } from "path";
import { KubeConfigMap } from "../../imports/k8s";
import { SchemaForVeleroHelmChart } from "../../imports/helm-values/velero-values.schema";
import { VmPodScrape, VmServiceScrape } from "../../imports/operator.victoriametrics.com";
import {
  Backup,
  BackupStorageLocation,
  Schedule,
  ScheduleSpecTemplate,
  VolumeSnapshotLocation,
} from "../../imports/velero.io";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { BitwardenSecret } from "../../lib/secrets";
import { AddCRDs } from "../../lib/util";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
// The chart version (12.x) tracks separately from the velero CLI/CRD version
// (1.18.x) that mise.toml and tools/sources.ts pin in lockstep. Both would
// otherwise land under depName `velero` and get swept into that group, so this
// one takes a distinct depName and looks the chart up via packageName.
// renovate: datasource=helm depName=velero-chart packageName=velero registryUrl=https://vmware-tanzu.github.io/helm-charts/
const chartVersion = "12.1.0";
// renovate: datasource=docker depName=velero/velero-plugin-for-aws
const awsVersion = "1.14.2";

NewArgoApp(name, {
  namespace: namespace,
  ignoreDifferences: [
    {
      kind: Backup.GVK.kind,
      group: "velero.io",
    },
  ],
});

class Velero extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    AddCRDs(this, join(__dirname, "crds"));

    new HelmApp<Partial<SchemaForVeleroHelmChart>>(this, "chart", {
      chart: "velero",
      repo: "https://vmware-tanzu.github.io/helm-charts/",
      version: chartVersion,
      releaseName: name,
      namespace: namespace,
      values: {
        dnsPolicy: "ClusterFirst",
        resources: {
          requests: {
            cpu: "25m",
            memory: "128Mi",
          },
          limits: {
            cpu: "500m",
            memory: "1Gi",
          },
        },
        initContainers: [
          {
            name: "velero-plugin-for-aws",
            image: `velero/velero-plugin-for-aws:v${awsVersion}`,
            volumeMounts: [
              {
                mountPath: "/target",
                name: "plugins",
              },
            ],
          },
        ],
        configuration: {
          features: "EnableCSI",
          repositoryMaintenanceJob: {
            repositoryConfigData: {
              global: {
                latestJobsCount: 1,
                keepLatestMaintenanceJobs: 1,
              },
            },
          },
          defaultVolumesToFsBackup: false, // only backup annotated stuffs
        },
        credentials: {
          useSecret: false,
        },
        deployNodeAgent: true,
        nodeAgent: {
          podVolumePath: "/var/lib/kubelet/pods",
          dnsPolicy: "ClusterFirst",
          // node-agent-config limits concurrent data uploads per node to avoid
          // overwhelming Garage's LMDB under concurrent write load, and to keep
          // backup read load off Ceph from starving etcd (see configmap below)
          extraArgs: ["--node-agent-configmap=node-agent-config"],
          resources: {
            requests: {
              cpu: "50m",
              memory: "256Mi",
            },
            limits: {
              cpu: "1250m",
              memory: "2Gi",
            },
          },
        } as unknown as SchemaForVeleroHelmChart["nodeAgent"],
        backupsEnabled: false, // we manage our own BackupLocation
        snapshotsEnabled: false, // we manage our own VolumeStorageLocation
        upgradeCRDs: false, // we manage them ourselves, above
      },
    });

    new KubeConfigMap(this, "node-agent-config", {
      metadata: {
        name: "node-agent-config",
        namespace: namespace,
      },
      data: {
        // The control plane VMs' RBD disks live on the same Ceph cluster that
        // data uploads read from, so backup concurrency directly degrades etcd
        // fsync latency. At 3 the weekly backup drove k8s-02/03 disk util to
        // ~99%, timing out etcd and flapping every leader-elected controller in
        // the cluster. Drop to 1 if that recurs.
        "load-concurrency": JSON.stringify({
          loadConcurrency: {
            globalConfig: 2,
          },
        }),
      },
    });

    new VmServiceScrape(this, "deployment-scrape", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        endpoints: [
          {
            port: "http-monitoring",
          },
        ],
        selector: {
          matchLabels: {
            "app.kubernetes.io/name": "velero",
            "app.kubernetes.io/instance": "velero",
          },
        },
      },
    });

    new VmPodScrape(this, "node-agent-scrape", {
      metadata: {
        name: "node-agent",
        namespace: namespace,
      },
      spec: {
        podMetricsEndpoints: [
          {
            port: "http-monitoring",
          },
        ],
        selector: {
          matchLabels: {
            "app.kubernetes.io/name": "velero",
            name: "node-agent",
          },
        },
      },
    });

    const creds = new BitwardenSecret(this, "s3-secret", {
      name: "s3-creds",
      namespace: namespace,
      data: {
        config: "4700b15e-20b5-4977-97f0-b3490125e477",
      },
    });

    // Kopia encrypts every repository with this password. Velero mints the
    // secret itself on first use when it is absent -- using the compiled-in
    // constant `static-passw0rd`, the same value in every Velero install in
    // the world -- but EnsureCommonRepositoryKey returns early once it exists,
    // so pre-creating it here is the whole of what makes these repos private.
    //
    // It comes from Bitwarden rather than lib's GeneratedSecret because a
    // password that exists only inside the cluster is worth nothing in the one
    // situation the offsite copy is for, where the cluster is gone. Changing
    // it strands every existing repo: Kopia cannot reopen one under a new
    // password, so a rotation means deleting the BackupRepositories and the
    // bucket contents both.
    new BitwardenSecret(this, "repo-credentials", {
      name: "velero-repo-credentials",
      namespace: namespace,
      data: {
        "repository-password": "51ab5da0-70c2-4611-b1fe-b4b5002e4500",
      },
    });

    // Straight to Wasabi, with no rclone crypt gateway in between. The gateway
    // existed because Velero writes the resources it collects to a plaintext
    // tarball; now that the schedules carry volume data only and Kopia holds a
    // real password, everything landing in this bucket is already encrypted
    // before it leaves the cluster, and the gateway bought nothing but a
    // single-replica hop in the middle of the offsite path.
    new BackupStorageLocation(this, "wasabi", {
      metadata: {
        name: "wasabi",
        namespace: namespace,
      },
      spec: {
        config: {
          region: "us-central-1",
          s3ForcePathStyle: "true",
          s3Url: "https://s3.us-central-1.wasabisys.com",
          profile: "wasabi",
        },
        objectStorage: {
          // The gateway presented crypt's contents as a bucket named `velero`;
          // direct, that is a prefix inside the real bucket. Pre-cutover data
          // sits beside it under crypt's obscured name for `velero`, and is
          // unreadable without the rclone config.
          bucket: "cmdcentral-k8s-backups",
          prefix: "velero",
        },
        provider: "aws",
        credential: {
          name: creds.secretName,
          key: "config",
        },
      },
    });

    new BackupStorageLocation(this, "versitygw", {
      metadata: {
        name: "versitygw",
        namespace: namespace,
      },
      spec: {
        config: {
          region: "us-east-1",
          s3ForcePathStyle: "true",
          s3Url: "https://s3.cmdcentral.xyz",
          profile: "versitygw",
        },
        default: true,
        objectStorage: {
          bucket: "velero",
        },
        provider: "aws",
        credential: {
          name: creds.secretName,
          key: "config",
        },
      },
    });

    new VolumeSnapshotLocation(this, "vsl", {
      metadata: {
        name: "default",
        namespace: namespace,
      },
      spec: {
        provider: "aws",
      },
    });

    const defaultScheduleSpec: Omit<ScheduleSpecTemplate, "ttl"> = {
      csiSnapshotTimeout: "0s",
      includedNamespaces: ["*"],
      itemOperationTimeout: "6h0m0s",
      snapshotMoveData: true,
      storageLocation: "versitygw",
      // Volume data only, no Kubernetes manifests. Every object Velero
      // collects lands in a *plaintext* gzipped tarball beside the Kopia repo,
      // so a full-resource backup writes every Secret in the cluster to the
      // bucket in the clear -- which is the only reason the offsite copy ever
      // needed an rclone crypt gateway in front of it. Manifests come from git
      // and Secrets from Bitwarden, so the tarball was never the part worth
      // keeping.
      //
      // Filtering this far still backs volumes up normally: data movement is
      // PVC-driven, not pod-driven -- the CSI plugin's BackupItemAction fires
      // on each PVC it finds and creates the VolumeSnapshot and DataUpload.
      // includeClusterResources is explicit because it otherwise defaults off
      // whenever includedNamespaces is anything but "*", which would silently
      // drop PVs from the offsite schedule alone.
      includedResources: ["persistentvolumeclaims", "persistentvolumes"],
      includeClusterResources: true,
    };

    // Only namespaces that actually own a PVC. A backup carries volume data
    // and nothing else now, so listing a namespace with no volumes produces an
    // empty backup that reads like offsite coverage and is not any.
    //
    // argocd, authentik and spoolman were here for exactly that reason: they
    // have no PVCs, and what is worth keeping lives in Postgres. That is
    // backed up by CNPG to barman ObjectStores, which currently point at
    // versitygw only -- so those three still have no offsite copy. Removing
    // them from this list does not create that gap, it stops hiding it.
    const offsiteNamespaces = ["immich", "mealie", "media", "netbox", "paperless"];

    new Schedule(this, "weekly-keep-3-months", {
      metadata: {
        name: "weekly-keep-3-months",
        namespace: namespace,
      },
      spec: {
        schedule: "33 0 * * 0",
        template: {
          ...defaultScheduleSpec,
          ttl: `${24 * 31 * 3}h0m0s`,
        },
        useOwnerReferencesInBackup: false,
      },
    });

    new Schedule(this, "daily-keep-1-week", {
      metadata: {
        name: "daily-keep-1-week",
        namespace: namespace,
      },
      spec: {
        // Pinned to 06:00 UTC to avoid CNPG backup window (01:00/01:30 UTC),
        // the Sunday primary weekly (00:33 UTC, ~4h runtime), and the offsite weekly (02:33 UTC).
        schedule: "0 6 * * *",
        template: {
          ...defaultScheduleSpec,
          ttl: `${24 * 7}h0m0s`,
        },
        useOwnerReferencesInBackup: false,
      },
    });

    new Schedule(this, "offsite-weekly-keep-3-months", {
      metadata: {
        name: "offsite-weekly-keep-3-months",
        namespace: namespace,
      },
      spec: {
        schedule: "33 2 * * 0",
        useOwnerReferencesInBackup: false,
        template: {
          ...defaultScheduleSpec,
          includedNamespaces: offsiteNamespaces,
          ttl: `${24 * 31 * 3}h0m0s`,
          storageLocation: "wasabi",
        },
      },
    });
  }
}

new Velero(app, "velero");

app.synth();
