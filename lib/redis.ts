import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  ConfigMap,
  ContainerResources,
  EnvValue,
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
          args: ["-c", "/opt/bitnami/scripts/start-scripts/start-master.sh"],
          command: ["/bin/bash"],
          ports: [
            {
              name: "redis",
              number: 6379,
            },
          ],
          envVariables: {
            BITNAMI_DEBUG: EnvValue.fromValue("false"),
            REDIS_REPLICATION_MODE: EnvValue.fromValue("master"),
            ALLOW_EMPTY_PASSWORD: EnvValue.fromValue("yes"),
            REDIS_TLS_ENABLED: EnvValue.fromValue("no"),
            REDIS_PORT: EnvValue.fromValue("6379"),
          },
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

    const healthVol = Volume.fromConfigMap(this, `${id}-health-vol`, health, {
      defaultMode: 0o755,
    });
    const scriptsVol = Volume.fromConfigMap(
      this,
      `${id}-scripts-vol`,
      scripts,
      {
        defaultMode: 0o755,
      },
    );
    const configVol = Volume.fromConfigMap(this, `${id}-config-vol`, config);
    const redisTmpConf = Volume.fromEmptyDir(
      this,
      `${id}-tmp-conf`,
      "redis-tmp-conf",
    );
    const tmp = Volume.fromEmptyDir(this, `${id}-tmp`, "tmp");
    ss.addVolume(healthVol);
    ss.addVolume(scriptsVol);
    ss.addVolume(configVol);
    ss.addVolume(redisTmpConf);
    ss.addVolume(tmp);

    ss.containers[0].mount("/health", healthVol);
    ss.containers[0].mount("/opt/bitnami/scripts/start-scripts", scriptsVol);
    ss.containers[0].mount("/opt/bitnami/redis/mounted-etc", configVol);
    ss.containers[0].mount("/opt/bitnami/redis/etc/", redisTmpConf);
    ss.containers[0].mount("/tmp", tmp);

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
