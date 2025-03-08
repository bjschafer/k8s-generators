import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  IntOrString,
  KubeService,
  KubeStatefulSet,
  ResourceRequirements,
} from "../imports/k8s";

export type RedisVersion = "7.4";

export interface RedisProps {
  name: string;
  namespace: string;
  version: RedisVersion;
  extraLabels?: { [key: string]: string };
  resources?: ResourceRequirements;
}

export class Redis extends Chart {
  constructor(scope: Construct, id: string, props: RedisProps) {
    super(scope, id);

    const labels = {
      "app.kubernetes.io/name": props.name,
      ...props.extraLabels,
    };

    new KubeStatefulSet(this, `${id}-sts`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: labels,
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: labels,
        },
        serviceName: props.name,

        template: {
          metadata: {
            labels: labels,
          },
          spec: {
            containers: [
              {
                image: `public.ecr.aws/bitnami/redis:${props.version}`,
                name: "redis",
                ports: [
                  {
                    name: "redis",
                    containerPort: 6379,
                  },
                ],
                resources: props.resources,
                livenessProbe: {
                  exec: {
                    command: [
                      "sh",
                      "-c",
                      "/health/ping_liveness_local.sh",
                      "5",
                    ],
                  },
                },
                readinessProbe: {
                  exec: {
                    command: [
                      "sh",
                      "-c",
                      "/health/ping_readiness_local.sh",
                      "1",
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    });

    new KubeService(this, `${id}-svc`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: labels,
      },
      spec: {
        selector: labels,
        type: "ClusterIP",
        ports: [
          {
            name: "redis",
            port: 6379,
            targetPort: IntOrString.fromString("redis"),
          },
        ],
      },
    });
  }
}
