/* eslint-disable */
/**
 * This file was automatically generated by json-schema-to-typescript.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,
 * and run json-schema-to-typescript to regenerate this file.
 */

export interface EsoValuesSchema {
  affinity?: {
    [k: string]: unknown;
  };
  "bitwarden-sdk-server"?: {
    enabled?: boolean;
    namespaceOverride?: string;
    [k: string]: unknown;
  };
  certController?: {
    affinity?: {
      [k: string]: unknown;
    };
    create?: boolean;
    deploymentAnnotations?: {
      [k: string]: unknown;
    };
    extraArgs?: {
      [k: string]: unknown;
    };
    extraEnv?: unknown[];
    extraVolumeMounts?: unknown[];
    extraVolumes?: unknown[];
    fullnameOverride?: string;
    hostNetwork?: boolean;
    image?: {
      flavour?: string;
      pullPolicy?: string;
      repository?: string;
      tag?: string;
      [k: string]: unknown;
    };
    imagePullSecrets?: unknown[];
    log?: {
      level?: string;
      timeEncoding?: string;
      [k: string]: unknown;
    };
    metrics?: {
      listen?: {
        port?: number;
        [k: string]: unknown;
      };
      service?: {
        annotations?: {
          [k: string]: unknown;
        };
        enabled?: boolean;
        port?: number;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    };
    nameOverride?: string;
    nodeSelector?: {
      [k: string]: unknown;
    };
    podAnnotations?: {
      [k: string]: unknown;
    };
    podDisruptionBudget?: {
      enabled?: boolean;
      minAvailable?: number | string;
      [k: string]: unknown;
    };
    podLabels?: {
      [k: string]: unknown;
    };
    podSecurityContext?: {
      enabled?: boolean;
      [k: string]: unknown;
    };
    priorityClassName?: string;
    rbac?: {
      create?: boolean;
      [k: string]: unknown;
    };
    readinessProbe?: {
      address?: string;
      port?: number;
      [k: string]: unknown;
    };
    replicaCount?: number;
    requeueInterval?: string;
    resources?: {
      [k: string]: unknown;
    };
    revisionHistoryLimit?: number;
    securityContext?: {
      allowPrivilegeEscalation?: boolean;
      capabilities?: {
        drop?: string[];
        [k: string]: unknown;
      };
      enabled?: boolean;
      readOnlyRootFilesystem?: boolean;
      runAsNonRoot?: boolean;
      runAsUser?: number;
      seccompProfile?: {
        type?: string;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    };
    serviceAccount?: {
      annotations?: {
        [k: string]: unknown;
      };
      automount?: boolean;
      create?: boolean;
      extraLabels?: {
        [k: string]: unknown;
      };
      name?: string;
      [k: string]: unknown;
    };
    tolerations?: unknown[];
    topologySpreadConstraints?: unknown[];
    [k: string]: unknown;
  };
  commonLabels?: {
    [k: string]: unknown;
  };
  concurrent?: number;
  controllerClass?: string;
  crds?: {
    annotations?: {
      [k: string]: unknown;
    };
    conversion?: {
      enabled?: boolean;
      [k: string]: unknown;
    };
    createClusterExternalSecret?: boolean;
    createClusterGenerator?: boolean;
    createClusterPushSecret?: boolean;
    createClusterSecretStore?: boolean;
    createPushSecret?: boolean;
    [k: string]: unknown;
  };
  createOperator?: boolean;
  deploymentAnnotations?: {
    [k: string]: unknown;
  };
  dnsConfig?: {
    [k: string]: unknown;
  };
  dnsPolicy?: string;
  extendedMetricLabels?: boolean;
  extraArgs?: {
    [k: string]: unknown;
  };
  extraContainers?: unknown[];
  extraEnv?: unknown[];
  extraObjects?: unknown[];
  extraVolumeMounts?: unknown[];
  extraVolumes?: unknown[];
  fullnameOverride?: string;
  global?: {
    affinity?: {
      [k: string]: unknown;
    };
    compatibility?: {
      openshift?: {
        adaptSecurityContext?: string;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    };
    nodeSelector?: {
      [k: string]: unknown;
    };
    tolerations?: unknown[];
    topologySpreadConstraints?: unknown[];
    [k: string]: unknown;
  };
  grafanaDashboard?: {
    annotations?: {
      [k: string]: unknown;
    };
    enabled?: boolean;
    sidecarLabel?: string;
    sidecarLabelValue?: string;
    [k: string]: unknown;
  };
  hostNetwork?: boolean;
  image?: {
    flavour?: string;
    pullPolicy?: string;
    repository?: string;
    tag?: string;
    [k: string]: unknown;
  };
  imagePullSecrets?: unknown[];
  installCRDs?: boolean;
  leaderElect?: boolean;
  log?: {
    level?: string;
    timeEncoding?: string;
    [k: string]: unknown;
  };
  metrics?: {
    listen?: {
      port?: number;
      [k: string]: unknown;
    };
    service?: {
      annotations?: {
        [k: string]: unknown;
      };
      enabled?: boolean;
      port?: number;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  nameOverride?: string;
  namespaceOverride?: string;
  nodeSelector?: {
    [k: string]: unknown;
  };
  openshiftFinalizers?: boolean;
  podAnnotations?: {
    [k: string]: unknown;
  };
  podDisruptionBudget?: {
    enabled?: boolean;
    minAvailable?: number | string;
    [k: string]: unknown;
  };
  podLabels?: {
    [k: string]: unknown;
  };
  podSecurityContext?: {
    enabled?: boolean;
    [k: string]: unknown;
  };
  podSpecExtra?: {
    [k: string]: unknown;
  };
  priorityClassName?: string;
  processClusterExternalSecret?: boolean;
  processClusterPushSecret?: boolean;
  processClusterStore?: boolean;
  processPushSecret?: boolean;
  rbac?: {
    aggregateToEdit?: boolean;
    aggregateToView?: boolean;
    create?: boolean;
    servicebindings?: {
      create?: boolean;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  replicaCount?: number;
  resources?: {
    [k: string]: unknown;
  };
  revisionHistoryLimit?: number;
  scopedNamespace?: string;
  scopedRBAC?: boolean;
  securityContext?: {
    allowPrivilegeEscalation?: boolean;
    capabilities?: {
      drop?: string[];
      [k: string]: unknown;
    };
    enabled?: boolean;
    readOnlyRootFilesystem?: boolean;
    runAsNonRoot?: boolean;
    runAsUser?: number;
    seccompProfile?: {
      type?: string;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  service?: {
    ipFamilies?: unknown[];
    ipFamilyPolicy?: string;
    [k: string]: unknown;
  };
  serviceAccount?: {
    annotations?: {
      [k: string]: unknown;
    };
    automount?: boolean;
    create?: boolean;
    extraLabels?: {
      [k: string]: unknown;
    };
    name?: string;
    [k: string]: unknown;
  };
  serviceMonitor?: {
    additionalLabels?: {
      [k: string]: unknown;
    };
    enabled?: boolean;
    honorLabels?: boolean;
    interval?: string;
    metricRelabelings?: unknown[];
    namespace?: string;
    relabelings?: unknown[];
    scrapeTimeout?: string;
    [k: string]: unknown;
  };
  tolerations?: unknown[];
  topologySpreadConstraints?: unknown[];
  webhook?: {
    affinity?: {
      [k: string]: unknown;
    };
    annotations?: {
      [k: string]: unknown;
    };
    certCheckInterval?: string;
    certDir?: string;
    certManager?: {
      addInjectorAnnotations?: boolean;
      cert?: {
        annotations?: {
          [k: string]: unknown;
        };
        create?: boolean;
        duration?: string;
        issuerRef?: {
          group?: string;
          kind?: string;
          name?: string;
          [k: string]: unknown;
        };
        renewBefore?: string;
        revisionHistoryLimit?: number;
        [k: string]: unknown;
      };
      enabled?: boolean;
      [k: string]: unknown;
    };
    create?: boolean;
    deploymentAnnotations?: {
      [k: string]: unknown;
    };
    extraArgs?: {
      [k: string]: unknown;
    };
    extraEnv?: unknown[];
    extraVolumeMounts?: unknown[];
    extraVolumes?: unknown[];
    failurePolicy?: string;
    fullnameOverride?: string;
    hostNetwork?: boolean;
    image?: {
      flavour?: string;
      pullPolicy?: string;
      repository?: string;
      tag?: string;
      [k: string]: unknown;
    };
    imagePullSecrets?: unknown[];
    log?: {
      level?: string;
      timeEncoding?: string;
      [k: string]: unknown;
    };
    lookaheadInterval?: string;
    metrics?: {
      listen?: {
        port?: number;
        [k: string]: unknown;
      };
      service?: {
        annotations?: {
          [k: string]: unknown;
        };
        enabled?: boolean;
        port?: number;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    };
    nameOverride?: string;
    nodeSelector?: {
      [k: string]: unknown;
    };
    podAnnotations?: {
      [k: string]: unknown;
    };
    podDisruptionBudget?: {
      enabled?: boolean;
      minAvailable?: number | string;
      [k: string]: unknown;
    };
    podLabels?: {
      [k: string]: unknown;
    };
    podSecurityContext?: {
      enabled?: boolean;
      [k: string]: unknown;
    };
    port?: number;
    priorityClassName?: string;
    rbac?: {
      create?: boolean;
      [k: string]: unknown;
    };
    readinessProbe?: {
      address?: string;
      port?: number;
      [k: string]: unknown;
    };
    replicaCount?: number;
    resources?: {
      [k: string]: unknown;
    };
    revisionHistoryLimit?: number;
    secretAnnotations?: {
      [k: string]: unknown;
    };
    securityContext?: {
      allowPrivilegeEscalation?: boolean;
      capabilities?: {
        drop?: string[];
        [k: string]: unknown;
      };
      enabled?: boolean;
      readOnlyRootFilesystem?: boolean;
      runAsNonRoot?: boolean;
      runAsUser?: number;
      seccompProfile?: {
        type?: string;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    };
    service?: {
      annotations?: {
        [k: string]: unknown;
      };
      enabled?: boolean;
      labels?: {
        [k: string]: unknown;
      };
      loadBalancerIP?: string;
      type?: string;
      [k: string]: unknown;
    };
    serviceAccount?: {
      annotations?: {
        [k: string]: unknown;
      };
      automount?: boolean;
      create?: boolean;
      extraLabels?: {
        [k: string]: unknown;
      };
      name?: string;
      [k: string]: unknown;
    };
    tolerations?: unknown[];
    topologySpreadConstraints?: unknown[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
