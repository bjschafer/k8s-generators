import {
  IntOrString,
  KubeDeployment,
  KubePersistentVolumeClaim,
  Probe,
  Quantity,
  ResourceRequirements,
  Volume,
  VolumeMount,
} from "../imports/k8s";
import { Construct } from "constructs";
import { Chart } from "cdk8s";
import {
  ImagePullPolicy,
  PersistentVolumeAccessMode,
  PersistentVolumeMode,
} from "cdk8s-plus-25";
import { StorageClass, UnifiedVolumeMount } from "./volume";
import {
  BACKUP_ANNOTATION_NAME,
  DNS_NAMESERVERS,
  DNS_SEARCH,
  LSIO_ENV,
} from "./consts";

export interface MediaAppProps {
  readonly name: string;
  readonly namespace: string;
  readonly port: number;
  readonly useExternalDNS: boolean;
  readonly enableProbes: boolean;
  readonly image: string;
  readonly resources: ResourceRequirements;
  // readonly nfsMounts: { mountPath: string; vol: NfsVolumes }[];
  readonly nfsMounts: UnifiedVolumeMount[];
  readonly configMountPath?: string;
  readonly configVolumeSize?: Quantity;
  readonly configEnableBackups: boolean;
}

export class MediaApp extends Chart {
  private readonly configPVCName: string;
  private readonly hasConfigPVC: boolean;

  constructor(scope: Construct, props: MediaAppProps) {
    super(scope, props.name);

    this.configPVCName = `${props.name}-config`;
    this.hasConfigPVC =
      props.configMountPath !== undefined ||
      props.configVolumeSize !== undefined;

    if (this.hasConfigPVC) {
      new KubePersistentVolumeClaim(this, this.configPVCName, {
        metadata: {
          labels: {
            "app.kubernetes.io/name": props.name,
          },
          name: this.configPVCName,
          namespace: props.namespace,
        },
        spec: {
          accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
          resources: {
            requests: {
              storage: props.configVolumeSize ?? Quantity.fromString("5Gi"),
            },
          },
          storageClassName: StorageClass.CEPH_RBD,
          volumeMode: PersistentVolumeMode.FILE_SYSTEM,
        },
      });
    }

    new KubeDeployment(this, `${props.name}-deployment`, {
      metadata: {
        labels: this.getCommonLabels(props.name),
        name: props.name,
        namespace: props.namespace,
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: this.getCommonLabels(props.name),
        },
        strategy: {
          type: "Recreate",
        },
        template: {
          metadata: {
            labels: this.getCommonLabels(props.name),
            annotations: props.configEnableBackups
              ? { [BACKUP_ANNOTATION_NAME]: `${props.name}-config` }
              : {},
          },
          spec: {
            containers: [
              {
                name: props.name,
                env: LSIO_ENV,
                image: props.image,
                imagePullPolicy: ImagePullPolicy.ALWAYS,
                ports: [
                  {
                    name: "http",
                    protocol: "TCP",
                    containerPort: props.port,
                  },
                ],
                resources: props.resources,
                volumeMounts: [
                  ...this.getConfigVolumeMount(
                    props.configMountPath ?? "/config"
                  ),
                  ...props.nfsMounts.map<VolumeMount>(function (
                    vol
                  ): VolumeMount {
                    return vol.volumeMount;
                  }),
                ],

                livenessProbe: props.enableProbes
                  ? this.getProbe(props.port)
                  : undefined,
                readinessProbe: props.enableProbes
                  ? this.getProbe(props.port)
                  : undefined,
                startupProbe: props.enableProbes
                  ? this.getProbe(props.port)
                  : undefined,
              },
            ],
            dnsConfig: props.useExternalDNS
              ? {
                  nameservers: DNS_NAMESERVERS,
                  searches: DNS_SEARCH,
                }
              : undefined,
            volumes: [
              ...this.getConfigVolume(),
              ...props.nfsMounts.map<Volume>(function (vol): Volume {
                return vol.volume;
              }),
            ],
          },
        },
      },
    });
  }

  private getCommonLabels(name: string): { [name: string]: string } {
    return {
      "app.kubernetes.io/name": name,
      "app.kubernetes.io/instance": name,
    };
  }

  private getProbe(port: number): Probe {
    return {
      failureThreshold: 3,
      initialDelaySeconds: 30,
      periodSeconds: 10,
      tcpSocket: {
        port: IntOrString.fromNumber(port),
      },
      timeoutSeconds: 1,
    };
  }

  private getConfigVolumeMount(mountPath: string): VolumeMount[] {
    if (this.hasConfigPVC) {
      return [
        {
          name: "config",
          mountPath: mountPath,
        },
      ];
    }
    return [];
  }

  private getConfigVolume(): Volume[] {
    if (this.hasConfigPVC) {
      return [
        {
          name: "config",
          persistentVolumeClaim: {
            claimName: this.configPVCName,
          },
        },
      ];
    }
    return [];
  }
}
