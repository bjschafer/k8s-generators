import { basename, join } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { App, Chart, Helm, Include } from "cdk8s";
import { Construct } from "constructs";
import {
  VmPodScrape,
  VmServiceScrape,
} from "../../imports/operator.victoriametrics.com";
import {
  BackupStorageLocation,
  Schedule,
  ScheduleSpecTemplate,
  VolumeSnapshotLocation,
} from "../../imports/velero.io";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const chartVersion = "8.6.0";
const awsVersion = "1.11.1";

NewArgoApp(name, {
  namespace: namespace,
});

class Velero extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const crds = [
      "backuprepositories.velero.io",
      "backups.velero.io",
      "backupstoragelocations.velero.io",
      "datadownloads.velero.io",
      "datauploads.velero.io",
      "deletebackuprequests.velero.io",
      "downloadrequests.velero.io",
      "podvolumebackups.velero.io",
      "podvolumerestores.velero.io",
      "restores.velero.io",
      "schedules.velero.io",
      "serverstatusrequests.velero.io",
      "volumesnapshotlocations.velero.io",
    ];

    for (const crd of crds) {
      new Include(this, `crd-${crd}`, {
        url: join(__dirname, "crds", `${crd}.yaml`),
      });
    }

    new Helm(this, "chart", {
      repo: "https://vmware-tanzu.github.io/helm-charts/",
      chart: "velero",
      version: chartVersion,
      releaseName: name,
      namespace: namespace,
      values: {
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
        image: {
          repository: "gcr.io/velero-gcp/velero",
        },
        initContainers: [
          {
            name: "velero-plugin-for-aws",
            image: `gcr.io/velero-gcp/velero-plugin-for-aws:v${awsVersion}`,
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
            latestJobsCount: 1,
          },
          defaultVolumesToFsBackup: false, // only backup annotated stuffs
        },
        credentials: {
          useSecret: true,
          existingSecret: "cloud-credentials",
        },
        deployNodeAgent: true,
        nodeAgent: {
          resources: {
            requests: {
              cpu: "50m",
              memory: "128Mi",
            },
            limits: {
              cpu: "1250m",
              memory: "1Gi",
            },
          },
        },
        backupsEnabled: false, // we manage our own BackupLocation
        snapshotsEnabled: false, // we manage our own VolumeStorageLocation
        upgradeCRDs: false, // we manage them ourselves, above
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

    new BackupStorageLocation(this, "minio", {
      metadata: {
        name: "minio",
        namespace: namespace,
      },
      spec: {
        config: {
          region: "us-east-1",
          s3ForcePathStyle: "true",
          s3Url: "https://minio.cmdcentral.xyz",
        },
        default: true,
        objectStorage: {
          bucket: "velero",
        },
        provider: "aws",
      },
    });

    new BackupStorageLocation(this, "b2", {
      metadata: {
        name: "b2",
        namespace: namespace,
      },
      spec: {
        config: {
          region: "us-east-1",
          s3ForcePathStyle: "true",
          s3Url:
            "http://rclone-gateway-crypt-b2-cmdcentral-k8s-backups.rclone.svc.cluster.local:8042",
          publicUrl:
            "https://rclone-gateway-crypt-b2-cmdcentral-k8s-backups.cmdcentral.xyz",
        },
        objectStorage: {
          bucket: "velero",
        },
        provider: "aws",
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
      snapshotMoveData: true,
      storageLocation: "minio",
    };

    const offsiteNamespaces = [
      "argocd",
      "authentik",
      "immich",
      "mealie",
      "media",
      "monica",
      "netbox",
      "paperless",
      "rclone",
      "spoolman",
      "velero",
    ];

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
        schedule: "@every 24h",
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
          storageLocation: "b2",
        },
      },
    });
  }
}

new Velero(app, "velero");

app.synth();
