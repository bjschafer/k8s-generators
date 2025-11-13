import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  IntOrString,
  KubeService,
  KubeStatefulSet,
  KubeSecret,
} from "../imports/k8s";
import { ISecret, Secret } from "cdk8s-plus-33";
import { Quantity, ResourceRequirements } from "cdk8s-plus-33/lib/imports/k8s";

export type ValkeyVersion = "7" | "7-alpine";

export interface ValkeyProps {
  name: string;
  namespace: string;
  version: ValkeyVersion;
  extraLabels?: { [key: string]: string };
  resources?: ResourceRequirements;
  storageSize?: Quantity;
  storageClass?: string;
  password?: string;
}

export class Valkey extends Chart {
  public readonly Service: KubeService;
  public readonly Secret: KubeSecret;
  public readonly secret: ISecret; // cdk8s-plus compatible secret reference

  constructor(scope: Construct, id: string, props: ValkeyProps) {
    super(scope, id);

    const labels = {
      "app.kubernetes.io/name": "valkey",
      "app.kubernetes.io/instance": props.name,
      "app.kubernetes.io/component": "master",
      ...props.extraLabels,
    };

    this.Secret = new KubeSecret(this, `${id}-secret`, {
      metadata: {
        name: `${props.name}-valkey`,
        namespace: props.namespace,
        labels: labels,
      },
      type: "Opaque",
      data: {
        "valkey-password": Buffer.from(props.password || "changeme").toString(
          "base64",
        ),
      },
    });

    // Create cdk8s-plus compatible secret reference for use with EnvValue APIs
    this.secret = Secret.fromSecretName(
      this,
      `${id}-isecret`,
      `${props.name}-valkey`,
    );

    const volumeConfig = props.storageSize
      ? {}
      : {
          volumes: [
            {
              name: "valkey-data",
              emptyDir: {},
            },
          ],
        };

    const volumeClaimTemplates = props.storageSize
      ? [
          {
            metadata: {
              name: "valkey-data",
              labels: labels,
            },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: {
                requests: {
                  storage: props.storageSize,
                },
              },
              storageClassName: props.storageClass,
            },
          },
        ]
      : [];

    new KubeStatefulSet(this, `${id}-sts`, {
      metadata: {
        name: `${props.name}-valkey-master`,
        namespace: props.namespace,
        labels: labels,
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: labels,
        },
        serviceName: `${props.name}-valkey-headless`,
        template: {
          metadata: {
            labels: labels,
          },
          spec: {
            containers: [
              {
                name: "valkey",
                image: `ghcr.io/valkey-io/valkey:${props.version}`,
                imagePullPolicy: "IfNotPresent",
                command: ["valkey-server"],
                args: [
                  "--requirepass",
                  "$(VALKEY_PASSWORD)",
                  "--appendonly",
                  "yes",
                  "--save",
                  "",
                ],
                env: [
                  {
                    name: "VALKEY_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: this.Secret.name,
                        key: "valkey-password",
                      },
                    },
                  },
                ],
                ports: [
                  {
                    name: "valkey",
                    containerPort: 6379,
                  },
                ],
                resources: props.resources && {
                  limits: props.resources.limits,
                  requests: props.resources.requests,
                },
                livenessProbe: {
                  exec: {
                    command: [
                      "valkey-cli",
                      "--no-auth-warning",
                      "-a",
                      "$(VALKEY_PASSWORD)",
                      "ping",
                    ],
                  },
                  initialDelaySeconds: 20,
                  periodSeconds: 5,
                  timeoutSeconds: 6,
                  failureThreshold: 5,
                  successThreshold: 1,
                },
                readinessProbe: {
                  exec: {
                    command: [
                      "valkey-cli",
                      "--no-auth-warning",
                      "-a",
                      "$(VALKEY_PASSWORD)",
                      "ping",
                    ],
                  },
                  initialDelaySeconds: 20,
                  periodSeconds: 5,
                  timeoutSeconds: 2,
                  failureThreshold: 5,
                  successThreshold: 1,
                },
                securityContext: {
                  runAsUser: 999,
                },
                volumeMounts: [
                  {
                    name: "valkey-data",
                    mountPath: "/data",
                  },
                ],
              },
            ],
            securityContext: {
              fsGroup: 999,
            },
            terminationGracePeriodSeconds: 30,
            affinity: {
              podAntiAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [
                  {
                    weight: 1,
                    podAffinityTerm: {
                      labelSelector: {
                        matchLabels: labels,
                      },
                      namespaces: [props.namespace],
                      topologyKey: "kubernetes.io/hostname",
                    },
                  },
                ],
              },
            },
            ...volumeConfig,
          },
        },
        ...(volumeClaimTemplates.length > 0 && { volumeClaimTemplates }),
        updateStrategy: {
          type: "RollingUpdate",
          rollingUpdate: {},
        },
      },
    });

    this.Service = new KubeService(this, `${id}-svc`, {
      metadata: {
        name: `${props.name}-valkey-master`,
        namespace: props.namespace,
        labels: labels,
      },
      spec: {
        type: "ClusterIP",
        selector: labels,
        ports: [
          {
            name: "tcp-valkey",
            port: 6379,
            targetPort: IntOrString.fromString("valkey"),
          },
        ],
      },
    });
  }
}
