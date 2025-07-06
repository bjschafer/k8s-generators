import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  ConfigMap,
  ContainerResources,
  Probe,
  Service,
  StatefulSet,
  Volume,
} from "cdk8s-plus-32";

export type RedisVersion = "7.4";

export interface RedisProps {
  name: string;
  namespace: string;
  version: RedisVersion;
  extraLabels?: { [key: string]: string };
  resources?: ContainerResources;
}

export class Redis extends Chart {
  public readonly Service: Service;

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

    const ss = new StatefulSet(this, `${id}-sts`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: labels,
      },
      replicas: 1,
      podMetadata: {
        labels: labels,
      },
      containers: [
        {
          image: `public.ecr.aws/bitnami/redis:${props.version}`,
          name: "redis",
          ports: [
            {
              name: "redis",
              number: 6379,
            },
          ],
          resources: props.resources,
          liveness: Probe.fromCommand([
            "sh",
            "-c",
            "/health/ping_liveness_local.sh",
            "5",
          ]),
          readiness: Probe.fromCommand([
            "sh",
            "-c",
            "/health/ping_readiness_local.sh",
            "5",
          ]),
        },
      ],
    });
    this.Service = ss.service;

    const healthVol = Volume.fromConfigMap(this, `${id}-health-vol`, health);
    ss.addVolume(healthVol);
    ss.containers[0].mount("/health", healthVol);

    // new KubeService(this, `${id}-svc`, {
    //   metadata: {
    //     name: props.name,
    //     namespace: props.namespace,
    //     labels: labels,
    //   },
    //   spec: {
    //     selector: labels,
    //     type: "ClusterIP",
    //     ports: [
    //       {
    //         name: "redis",
    //         port: 6379,
    //         targetPort: IntOrString.fromString("redis"),
    //       },
    //     ],
    //   },
    // });
  }
}
