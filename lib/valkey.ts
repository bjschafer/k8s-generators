import { Chart } from "cdk8s";
import { EnvValue } from "cdk8s-plus-34";
import { BACKUP_ANNOTATION_EXCLUDE } from "./consts";
import { GeneratedSecret } from "./secrets";
import { Quantity, ResourceRequirements } from "cdk8s-plus-34/lib/imports/k8s";
import { Construct } from "constructs";
import { IntOrString, KubeService, KubeStatefulSet } from "../imports/k8s";

// Template-literal rather than a hand-listed union: the union had to be edited
// for every new major, which is exactly the edit a Renovate bump makes -- so a
// bump would land red on a type error rather than on the review it wants.
export type ValkeyVersion = `${number}` | `${number}-alpine`;

// Every app that runs a Valkey pins the same major line, so it lives here once
// rather than in five app.ts files drifting apart. It feeds both the image tag
// and the argocd-image-updater versionConstraint, so the updater's ceiling can
// never disagree with what is actually deployed. The updater moves patches
// within the line; Renovate watches this const for the major it cannot reach.
// renovate: datasource=docker depName=ghcr.io/valkey-io/valkey
export const VALKEY_VERSION: ValkeyVersion = "8-alpine";

export interface ValkeyProps {
  name: string;
  namespace: string;
  version: ValkeyVersion;
  extraLabels?: { [key: string]: string };
  resources?: ResourceRequirements;
  storageSize?: Quantity;
  storageClass?: string;
}

export class Valkey extends Chart {
  public readonly Service: KubeService;
  public readonly passwordSecret: GeneratedSecret;
  // The password as an env var, for clients that take it on its own. Clients
  // that only take a URL need it spliced in with `$(VAR)` expansion, which only
  // sees variables defined earlier in the same container's env.
  public readonly passwordEnv: EnvValue;

  constructor(scope: Construct, id: string, props: ValkeyProps) {
    super(scope, id);

    const labels = {
      "app.kubernetes.io/name": "valkey",
      "app.kubernetes.io/instance": props.name,
      "app.kubernetes.io/component": "master",
      ...props.extraLabels,
    };

    this.passwordSecret = new GeneratedSecret(this, `${id}-auth`, {
      name: `${props.name}-valkey-auth`,
      namespace: props.namespace,
      data: { VALKEY_PASSWORD: {} },
    });
    this.passwordEnv = this.passwordSecret.toEnvValues().VALKEY_PASSWORD;
    const passwordRef = {
      valueFrom: {
        secretKeyRef: { name: this.passwordSecret.secretName, key: "VALKEY_PASSWORD" },
      },
    };

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
              labels: { ...labels, [BACKUP_ANNOTATION_EXCLUDE]: "true" },
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

    // Using raw KubeStatefulSet instead of cdk8s-plus StatefulSet because
    // cdk8s-plus does not support volumeClaimTemplates with the flexibility
    // needed here (conditional templates and inline resource specs).
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
            labels: { ...labels, [BACKUP_ANNOTATION_EXCLUDE]: "true" },
          },
          spec: {
            containers: [
              {
                name: "valkey",
                image: `ghcr.io/valkey-io/valkey:${props.version}`,
                imagePullPolicy: "IfNotPresent",
                command: ["valkey-server"],
                args: ["--requirepass", "$(VALKEY_PASSWORD)", "--appendonly", "yes", "--save", ""],
                env: [
                  { name: "VALKEY_PASSWORD", ...passwordRef },
                  // valkey-cli reads this, which keeps the password out of the
                  // probes' argv.
                  { name: "REDISCLI_AUTH", ...passwordRef },
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
                    command: ["valkey-cli", "ping"],
                  },
                  initialDelaySeconds: 20,
                  periodSeconds: 5,
                  timeoutSeconds: 6,
                  failureThreshold: 5,
                  successThreshold: 1,
                },
                readinessProbe: {
                  exec: {
                    command: ["valkey-cli", "ping"],
                  },
                  initialDelaySeconds: 20,
                  periodSeconds: 5,
                  timeoutSeconds: 2,
                  failureThreshold: 5,
                  successThreshold: 1,
                },
                securityContext: {
                  runAsUser: 999,
                  runAsGroup: 999,
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                  seccompProfile: { type: "RuntimeDefault" },
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
