import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  Container,
  ContainerPort,
  DeploymentStrategy,
  EnvFromSource,
  EnvVar,
  IntOrString,
  KubeDeployment,
  LocalObjectReference,
  Quantity,
  ResourceRequirements,
  Volume,
  VolumeMount,
} from "../imports/k8s";
import { ImagePullPolicy } from "cdk8s-plus-31";
import {
  DEFAULT_CPU_LIMIT,
  DEFAULT_MEM_LIMIT,
  DNS_NAMESERVERS,
  DNS_SEARCH,
} from "./consts";
import {
  CustomVolume,
  CustomVolumeProps,
  PVCProps,
  StorageClass,
} from "./volume";

export interface BasicAppProps {
  readonly namespace: string;
  readonly image: string;
  readonly ports: number[];
  readonly useExternalDNS: boolean;
  readonly labels?: { [name: string]: string };
  readonly pvcProps?: PVCProps;
  readonly resourceOverrides?: {
    limits: {
      cpu?: Quantity;
      memory?: Quantity;
    };
    requests: {
      cpu?: Quantity;
      memory?: Quantity;
    };
  };
  readonly extraEnv?: EnvVar[];
}

export class BasicApp extends Chart {
  name: string;
  props: BasicAppProps;

  constructor(scope: Construct, name: string, props: BasicAppProps) {
    super(scope, name);
    this.name = name;
    this.props = props;

    new KubeDeployment(this, `${name}-deployment`, {
      metadata: {
        name: name,
        namespace: props.namespace,
        labels: this.getLabels(),
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: this.getLabels(),
        },
        strategy: this.getStrategy(),
        template: {
          metadata: {
            labels: this.getLabels(),
          },
          spec: {
            containers: [
              {
                name: name,
                image: props.image,
                imagePullPolicy: this.getImagePullPolicy(props.image),
                env: [
                  {
                    name: "TZ",
                    value: "America/Chicago",
                  },
                  ...(props.extraEnv ?? []),
                ],
                ports: this.getPorts(props.ports),
                // TODO probes
                resources: this.getResources(),
                volumeMounts: props.pvcProps
                  ? [
                      {
                        name: props.pvcProps?.name,
                        mountPath: props.pvcProps?.mountPath,
                      },
                    ]
                  : undefined,
              },
            ],
            dnsConfig: props.useExternalDNS
              ? {
                  nameservers: DNS_NAMESERVERS,
                  searches: DNS_SEARCH,
                }
              : undefined,
            volumes: props.pvcProps
              ? [
                  {
                    name: props.pvcProps.name,
                    persistentVolumeClaim: {
                      claimName: props.pvcProps.name,
                    },
                  },
                ]
              : undefined,
          },
        },
      },
    });
  }

  private getResources(): ResourceRequirements {
    if (this.props.resourceOverrides) {
      const limits = {
        cpu: this.props.resourceOverrides.limits.cpu ?? DEFAULT_CPU_LIMIT,
        memory: this.props.resourceOverrides.limits.memory ?? DEFAULT_MEM_LIMIT,
      };
      // TODO requests
      return {
        limits: limits,
      };
    }
    return {
      limits: {
        cpu: DEFAULT_CPU_LIMIT,
        memory: DEFAULT_MEM_LIMIT,
      },
    };
  }

  private getPorts(ports: number[]): ContainerPort[] {
    const ret: ContainerPort[] = [];
    for (const port of ports) {
      ret.push({
        name: `${this.name}-${port}`,
        containerPort: port,
        protocol: "TCP",
      });
    }
    return ret;
  }

  private getImagePullPolicy(image: string): ImagePullPolicy {
    const imgSplit = image.split(":");
    if (imgSplit.length < 2) {
      // implicit latest
      return ImagePullPolicy.ALWAYS;
    }
    const tag = imgSplit[1];

    if (tag in ["latest", "develop", "master", "main"]) {
      return ImagePullPolicy.ALWAYS;
    }

    return ImagePullPolicy.IF_NOT_PRESENT;
  }

  private getLabels(): { [key: string]: string } {
    return {
      "app.kubernetes.io/name": this.name,
      ...this.props.labels,
    };
  }

  private getStrategy(): DeploymentStrategy {
    if (
      this.props.pvcProps &&
      this.props.pvcProps.storageClass == StorageClass.CEPH_RBD
    ) {
      return {
        type: "Recreate",
      };
    } else {
      return {
        type: "RollingUpdate",
        rollingUpdate: {
          maxUnavailable: IntOrString.fromString("50%"),
          maxSurge: IntOrString.fromString("50%"),
        },
      };
    }
  }
}

export interface CustomAppProps {
  readonly name: string;
  readonly namespace: string;

  // meta
  readonly additionalLabels?: { [name: string]: string };
  readonly annotations?: { [name: string]: string };

  readonly replicas?: number;
  readonly strategy?: DeploymentStrategy;
  readonly useExternalDNS: boolean;

  readonly imagePullSecrets?: LocalObjectReference[];
  readonly nodeSelector?: { [name: string]: string };

  readonly volumes?: CustomVolumeProps[];
  readonly containers: CustomContainerProps[];
}

export interface CustomContainerProps {
  readonly name?: string;
  readonly image: string;
  readonly imagePullPolicy?: ImagePullPolicy;
  readonly envFrom?: EnvFromSource[];
  readonly env?: EnvVar[];
  readonly resources?: ResourceRequirements;
  readonly ports?: ContainerPort[];
}

export class CustomApp extends Chart {
  constructor(scope: Construct, props: CustomAppProps) {
    super(scope, props.name);

    const volumes: CustomVolume[] = [];
    for (const volumeProps of props.volumes ?? []) {
      const vol = new CustomVolume(volumeProps);
      vol.MakePVC(this);
      volumes.push(vol);
    }

    new KubeDeployment(this, `${props.name}-deployment`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: {
          "app.kubernetes.io/name": props.name,
          "app.kubernetes.io/instance": props.name,
          ...props.additionalLabels,
        },
        annotations: props.annotations,
      },
      spec: {
        replicas: props.replicas ?? 1,
        selector: {
          matchLabels: {
            "app.kubernetes.io/name": props.name,
            "app.kubernetes.io/instance": props.name,
            ...props.additionalLabels,
          },
        },
        strategy: props.strategy ?? { type: "Recreate" },
        template: {
          metadata: {
            labels: {
              "app.kubernetes.io/name": props.name,
              "app.kubernetes.io/instance": props.name,
              ...props.additionalLabels,
            },
            annotations: this.getBackupAnnotations(volumes),
          },
          spec: {
            // TODO nodeSelector / arch
            containers: props.containers.map(function (
              container: CustomContainerProps,
            ): Container {
              return {
                name: container.name ?? props.name,
                image: container.image,
                imagePullPolicy: container.imagePullPolicy,
                envFrom: container.envFrom,
                env: container.env,
                ports: container.ports,
                resources: container.resources,
                volumeMounts: volumes.map<VolumeMount>(function (
                  vol: CustomVolume,
                ): VolumeMount {
                  return vol.GetVolumeMount();
                }),
              };
            }),
            volumes: volumes.map<Volume>(function (vol: CustomVolume): Volume {
              return vol.GetVolume();
            }),
          },
        },
      },
    });
  }

  private getBackupAnnotations(volumes: CustomVolume[]): {
    [p: string]: string;
  } {
    const volsToBackup = [];

    for (const vol of volumes) {
      if (vol.props.backup) {
        volsToBackup.push(vol.props.name);
      }
    }

    if (volsToBackup.length > 0) {
      return {
        BACKUP_ANNOTATION: volsToBackup.join(","),
      };
    }
    return {};
  }
}
