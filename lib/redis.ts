import { Chart } from "cdk8s";
import { Construct } from "constructs";
import { ConfigMap } from "cdk8s-plus-32";
import { IntOrString, KubeService, KubeStatefulSet } from "../imports/k8s";
import { Quantity, ResourceRequirements } from "cdk8s-plus-32/lib/imports/k8s";

export type RedisVersion = "7.4";

export interface RedisProps {
  name: string;
  namespace: string;
  version: RedisVersion;
  extraLabels?: { [key: string]: string };
  resources?: ResourceRequirements;
  storageSize?: Quantity;
  storageClass?: string;
}

export class Redis extends Chart {
  public readonly Service: KubeService;

  constructor(scope: Construct, id: string, props: RedisProps) {
    super(scope, id);

    const labels = {
      "app.kubernetes.io/name": props.name,
      ...props.extraLabels,
    };
    const health = new ConfigMap(this, `${id}-health`, {
      metadata: {
        name: `${props.name}-health`,
        namespace: props.namespace,
        labels: labels,
      },
      data: {
        "ping_liveness_local.sh":
          '#!/bin/bash\n\n[[ -f $REDIS_PASSWORD_FILE ]] && export REDIS_PASSWORD="$(< "${REDIS_PASSWORD_FILE}")"\n[[ -n "$REDIS_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_PASSWORD"\nresponse=$(\n  timeout -s 3 $1 \\\n  redis-cli \\\n    -h localhost \\\n    -p $REDIS_PORT \\\n    ping\n)\nif [ "$response" != "PONG" ] && [ "$response" != "LOADING Redis is loading the dataset in memory" ]; then\n  echo "$response"\n  exit 1\nfi',
        "ping_liveness_local_and_master.sh":
          'script_dir="$(dirname "$0")"\nexit_status=0\n"$script_dir/ping_liveness_local.sh" $1 || exit_status=$?\n"$script_dir/ping_liveness_master.sh" $1 || exit_status=$?\nexit $exit_status',
        "ping_liveness_master.sh":
          '#!/bin/bash\n\n[[ -f $REDIS_MASTER_PASSWORD_FILE ]] && export REDIS_MASTER_PASSWORD="$(< "${REDIS_MASTER_PASSWORD_FILE}")"\n[[ -n "$REDIS_MASTER_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_MASTER_PASSWORD"\nresponse=$(\n  timeout -s 3 $1 \\\n  redis-cli \\\n    -h $REDIS_MASTER_HOST \\\n    -p $REDIS_MASTER_PORT_NUMBER \\\n    ping\n)\nif [ "$response" != "PONG" ] && [ "$response" != "LOADING Redis is loading the dataset in memory" ]; then\n  echo "$response"\n  exit 1\nfi',
        "ping_readiness_local.sh":
          '#!/bin/bash\n\n[[ -f $REDIS_PASSWORD_FILE ]] && export REDIS_PASSWORD="$(< "${REDIS_PASSWORD_FILE}")"\n[[ -n "$REDIS_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_PASSWORD"\nresponse=$(\n  timeout -s 3 $1 \\\n  redis-cli \\\n    -h localhost \\\n    -p $REDIS_PORT \\\n    ping\n)\nif [ "$response" != "PONG" ]; then\n  echo "$response"\n  exit 1\nfi',
        "ping_readiness_local_and_master.sh":
          'script_dir="$(dirname "$0")"\nexit_status=0\n"$script_dir/ping_readiness_local.sh" $1 || exit_status=$?\n"$script_dir/ping_readiness_master.sh" $1 || exit_status=$?\nexit $exit_status',
        "ping_readiness_master.sh":
          '#!/bin/bash\n\n[[ -f $REDIS_MASTER_PASSWORD_FILE ]] && export REDIS_MASTER_PASSWORD="$(< "${REDIS_MASTER_PASSWORD_FILE}")"\n[[ -n "$REDIS_MASTER_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_MASTER_PASSWORD"\nresponse=$(\n  timeout -s 3 $1 \\\n  redis-cli \\\n    -h $REDIS_MASTER_HOST \\\n    -p $REDIS_MASTER_PORT_NUMBER \\\n    ping\n)\nif [ "$response" != "PONG" ]; then\n  echo "$response"\n  exit 1\nfi',
      },
    });

    const config = new ConfigMap(this, `${id}-config`, {
      metadata: {
        name: `${props.name}-config`,
        namespace: props.namespace,
        labels: labels,
      },
      data: {
        "master.conf":
          'dir /data\n# User-supplied master configuration:\nrename-command FLUSHDB ""\nrename-command FLUSHALL ""\n# End of master configuration',
        "redis.conf":
          '# User-supplied common configuration:\n# Enable AOF https://redis.io/topics/persistence#append-only-file\nappendonly yes\n# Disable RDB persistence, AOF persistence already enabled.\nsave ""\n# End of common configuration',
        "replica.conf":
          'dir /data\nslave-read-only yes\n# User-supplied replica configuration:\nrename-command FLUSHDB ""\nrename-command FLUSHALL ""\n# End of replica configuration',
      },
    });

    const scripts = new ConfigMap(this, `${id}-scripts`, {
      metadata: {
        name: `${props.name}-scripts`,
        namespace: props.namespace,
        labels: labels,
      },
      data: {
        "start-master.sh":
          '#!/bin/bash\n\n[[ -f $REDIS_PASSWORD_FILE ]] && export REDIS_PASSWORD="$(< "${REDIS_PASSWORD_FILE}")"\nif [[ ! -f /opt/bitnami/redis/etc/master.conf ]];then\n    cp /opt/bitnami/redis/mounted-etc/master.conf /opt/bitnami/redis/etc/master.conf\nfi\nif [[ ! -f /opt/bitnami/redis/etc/redis.conf ]];then\n    cp /opt/bitnami/redis/mounted-etc/redis.conf /opt/bitnami/redis/etc/redis.conf\nfi\nARGS=("--port" "${REDIS_PORT}")\nARGS+=("--protected-mode" "no")\nARGS+=("--include" "/opt/bitnami/redis/etc/redis.conf")\nARGS+=("--include" "/opt/bitnami/redis/etc/master.conf")\nexec redis-server "${ARGS[@]}"\n',
      },
    });

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
                args: [
                  "-c",
                  "/opt/bitnami/scripts/start-scripts/start-master.sh",
                ],
                command: ["/bin/bash"],
                ports: [
                  {
                    name: "redis",
                    containerPort: 6379,
                  },
                ],
                env: [
                  {
                    name: "BITNAMI_DEBUG",
                    value: "false",
                  },
                  {
                    name: "REDIS_REPLICATION_MODE",
                    value: "master",
                  },
                  {
                    name: "ALLOW_EMPTY_PASSWORD",
                    value: "yes",
                  },
                  {
                    name: "REDIS_TLS_ENABLED",
                    value: "no",
                  },
                  {
                    name: "REDIS_PORT",
                    value: "6379",
                  },
                ],
                resources: props.resources && {
                  limits: props.resources.limits,
                  requests: props.resources.requests,
                },
                livenessProbe: {
                  exec: {
                    command: [
                      "sh",
                      "-c",
                      "/health/ping_liveness_local.sh 5",
                    ],
                  },
                },
                readinessProbe: {
                  exec: {
                    command: [
                      "sh",
                      "-c",
                      "/health/ping_readiness_local.sh 5",
                    ],
                  },
                },
                securityContext: {
                  runAsUser: 1001,
                },
                volumeMounts: [
                  {
                    name: "health",
                    mountPath: "/health",
                  },
                  {
                    name: "scripts",
                    mountPath: "/opt/bitnami/scripts/start-scripts",
                  },
                  {
                    name: "config",
                    mountPath: "/opt/bitnami/redis/mounted-etc",
                  },
                  {
                    name: "redis-tmp-conf",
                    mountPath: "/opt/bitnami/redis/etc/",
                  },
                  {
                    name: "tmp",
                    mountPath: "/tmp",
                  },
                  {
                    name: "redis-data",
                    mountPath: "/data",
                  },
                ],
              },
            ],
            securityContext: {
              fsGroup: 1001,
            },
            volumes: [
              {
                name: "health",
                configMap: {
                  name: health.name,
                  defaultMode: 0o755,
                },
              },
              {
                name: "scripts",
                configMap: {
                  name: scripts.name,
                  defaultMode: 0o755,
                },
              },
              {
                name: "config",
                configMap: {
                  name: config.name,
                },
              },
              {
                name: "redis-tmp-conf",
                emptyDir: {},
              },
              {
                name: "tmp",
                emptyDir: {},
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: {
              name: "redis-data",
              labels: labels,
            },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: {
                requests: {
                  storage: props.storageSize || Quantity.fromString("1Gi"),
                },
              },
              storageClassName: props.storageClass,
            },
          },
        ],
      },
    });

    this.Service = new KubeService(this, `${id}-svc`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: labels,
      },
      spec: {
        selector: labels,
        ports: [
          {
            name: "redis",
            port: 6379,
            targetPort: IntOrString.fromNumber(6379),
          },
        ],
      },
    });
  }
}
