import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { basename, join } from "path";
import { SchemaForVeleroHelmChart } from "../../imports/helm-values/velero-values.schema";
import {
  VmPodScrape,
  VmServiceScrape,
} from "../../imports/operator.victoriametrics.com";
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
const chartVersion = "11.3.2";
const awsVersion = "1.13.1";

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
          useSecret: true,
          existingSecret: "cloud-credentials",
        },
        deployNodeAgent: true,
        nodeAgent: {
          podVolumePath: "/var/lib/kubelet/pods",
          dnsPolicy: "ClusterFirst",
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

    const creds = new BitwardenSecret(this, "s3-secret", {
      name: "s3-creds",
      namespace: namespace,
      data: {
        config: "4700b15e-20b5-4977-97f0-b3490125e477",
      },
    });

    new BackupStorageLocation(this, "garage", {
      metadata: {
        name: "garage",
        namespace: namespace,
      },
      spec: {
        config: {
          region: "us-east-1",
          s3ForcePathStyle: "true",
          s3Url: "https://garage.cmdcentral.xyz",
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

    new BackupStorageLocation(this, "wasabi", {
      metadata: {
        name: "wasabi",
        namespace: namespace,
      },
      spec: {
        config: {
          region: "us-east-1",
          s3ForcePathStyle: "true",
          s3Url:
            "http://rclone-gateway-crypt-wasabi-cmdcentral-k8s-backups.rclone.svc.cluster.local:8042",
          publicUrl:
            "https://rclone-gateway-crypt-wasabi-cmdcentral-k8s-backups.cmdcentral.xyz",
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
      storageLocation: "garage",
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
          storageLocation: "wasabi",
        },
      },
    });
  }
}

new Velero(app, "velero");

app.synth();
