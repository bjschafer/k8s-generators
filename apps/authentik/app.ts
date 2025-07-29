import { App, Size, Chart } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { NewArgoApp } from "../../lib/argo";
import { Valkey } from "../../lib/valkey";
import { Quantity } from "../../imports/k8s";
import { AppPlus } from "../../lib/app-plus";
import { Cpu, EnvValue, Probe, Secret, ServiceAccount } from "cdk8s-plus-32";
import {
  KubeService,
  KubeClusterRole,
  KubeClusterRoleBinding,
} from "../../imports/k8s";
import { BitwardenSecret } from "../../lib/secrets";
import { CmdcentralServiceMonitor } from "../../lib/monitoring/victoriametrics";
import { WellKnownLabels } from "../../lib/labels";
import {
  VmServiceScrape,
  VmServiceScrapeSpecEndpointsScheme,
  VmRule,
} from "../../imports/operator.victoriametrics.com";
import { Duration } from "cdk8s";
import { Construct } from "constructs";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

NewArgoApp(namespace, {
  namespace: namespace,
});

class AuthentikRBAC extends Chart {
  public readonly serviceAccount: ServiceAccount;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Service Account
    this.serviceAccount = new ServiceAccount(this, "authentik-sa", {
      metadata: {
        name: "authentik",
        namespace: namespace,
      },
    });

    // Cluster Role
    const clusterRole = new KubeClusterRole(this, "authentik-cluster-role", {
      metadata: {
        name: "authentik",
      },
      rules: [
        {
          apiGroups: [""],
          resources: ["secrets", "services", "configmaps"],
          verbs: ["get", "create", "update", "list"],
        },
        {
          apiGroups: ["extensions", "networking.k8s.io"],
          resources: ["ingresses"],
          verbs: ["get", "create", "update", "list"],
        },
        {
          apiGroups: ["traefik.containo.us", "traefik.io"],
          resources: ["middlewares"],
          verbs: ["get", "create", "update", "list"],
        },
        {
          apiGroups: ["apiextensions.k8s.io"],
          resources: ["customresourcedefinitions"],
          verbs: ["list"],
        },
      ],
    });

    // Cluster Role Binding
    new KubeClusterRoleBinding(this, "authentik-cluster-role-binding", {
      metadata: {
        name: "authentik",
      },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: clusterRole.name,
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: this.serviceAccount.name,
          namespace: namespace,
        },
      ],
    });
  }
}

const rbac = new AuthentikRBAC(app, "authentik-rbac");

// Secrets
const creds = new BitwardenSecret(app, "creds", {
  name: "creds",
  namespace: namespace,
  data: {
    AUTHENTIK_SECRET_KEY: "8f697c41-0a3a-44e9-904e-b329003066c0",
    AUTHENTIK_POSTGRESQL__PASSWORD: "63b39599-c406-4fa1-b6e3-b32900304db5",
    AUTHENTIK_EMAIL__PASSWORD: "78228577-9953-4482-be25-b32900303578",
  },
});

// Valkey (Redis replacement)
const valkey = new Valkey(app, "valkey", {
  name: "authentik",
  namespace: namespace,
  version: "7-alpine",
  resources: {
    requests: {
      cpu: Quantity.fromString("50m"),
      memory: Quantity.fromString("64Mi"),
    },
    limits: {
      memory: Quantity.fromString("128Mi"),
    },
  },
});

// Common environment variables
const commonEnv: Record<string, EnvValue> = {
  AUTHENTIK_AVATARS: EnvValue.fromValue("gravatar"),
  AUTHENTIK_EMAIL__FROM: EnvValue.fromValue("login@cmdcentral.xyz"),
  AUTHENTIK_EMAIL__HOST: EnvValue.fromValue("smtp.fastmail.com"),
  AUTHENTIK_EMAIL__PORT: EnvValue.fromValue("465"),
  AUTHENTIK_EMAIL__TIMEOUT: EnvValue.fromValue("30"),
  AUTHENTIK_EMAIL__USE_SSL: EnvValue.fromValue("true"),
  AUTHENTIK_EMAIL__USE_TLS: EnvValue.fromValue("false"),
  AUTHENTIK_EMAIL__USERNAME: EnvValue.fromValue("braxton@cmdcentral.xyz"),
  AUTHENTIK_ERROR_REPORTING__ENABLED: EnvValue.fromValue("false"),
  AUTHENTIK_ERROR_REPORTING__ENVIRONMENT: EnvValue.fromValue("k8s"),
  AUTHENTIK_ERROR_REPORTING__SEND_PII: EnvValue.fromValue("false"),
  AUTHENTIK_EVENTS__CONTEXT_PROCESSORS__GEOIP: EnvValue.fromValue(
    "/geoip/GeoLite2-City.mmdb",
  ),
  AUTHENTIK_LOG_LEVEL: EnvValue.fromValue("info"),
  AUTHENTIK_OUTPOSTS__CONTAINER_IMAGE_BASE: EnvValue.fromValue(
    "ghcr.io/goauthentik/%(type)s:%(version)s",
  ),
  AUTHENTIK_POSTGRESQL__HOST: EnvValue.fromValue(
    "prod.postgres.svc.cluster.local",
  ),
  AUTHENTIK_POSTGRESQL__NAME: EnvValue.fromValue("authentik"),
  AUTHENTIK_POSTGRESQL__PORT: EnvValue.fromValue("5432"),
  AUTHENTIK_POSTGRESQL__USER: EnvValue.fromValue("authentik"),
  AUTHENTIK_REDIS__HOST: EnvValue.fromValue(valkey.Service.name),
  AUTHENTIK_REDIS__PASSWORD: EnvValue.fromSecretValue({
    secret: Secret.fromSecretName(app, "valkey-secret", "authentik-valkey"),
    key: "valkey-password",
  }),
};

// Authentik Server
const server = new AppPlus(app, "authentik-server", {
  name: "authentik-server",
  namespace: namespace,
  image: "ghcr.io/goauthentik/server:2025.6.3",
  resources: {
    cpu: {
      request: Cpu.millis(50),
      limit: Cpu.millis(1200),
    },
    memory: {
      request: Size.mebibytes(512),
      limit: Size.gibibytes(1),
    },
  },
  replicas: 2,
  ports: [9000, 9443],
  args: ["server"],
  serviceAccountName: rbac.serviceAccount.name,
  automountServiceAccount: true,
  limitToAMD64: true, // https://github.com/goauthentik/authentik/issues/2078
  livenessProbe: Probe.fromHttpGet("/-/health/live/", {
    port: 9000,
    initialDelaySeconds: Duration.seconds(30),
    periodSeconds: Duration.seconds(10),
  }),
  readinessProbe: Probe.fromHttpGet("/-/health/ready/", {
    port: 9000,
    initialDelaySeconds: Duration.seconds(30),
    periodSeconds: Duration.seconds(10),
  }),
  monitoringConfig: {
    port: 9300,
  },
  extraEnv: {
    ...commonEnv,
    ...creds.toEnvValues(),
  },
  extraIngressHosts: ["login.cmdcentral.xyz"],
  labels: {
    [WellKnownLabels.Name]: "authentik",
    [WellKnownLabels.Component]: "server",
  },
});

// Update service ports to match the original configuration
server.Service.metadata.addAnnotation(
  "service.beta.kubernetes.io/do-loadbalancer-enable-proxy-protocol",
  "true",
);

// Authentik Worker
new AppPlus(app, "authentik-worker", {
  name: "authentik-worker",
  namespace: namespace,
  image: "ghcr.io/goauthentik/server:2025.6.3",
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.mebibytes(512),
      limit: Size.mebibytes(768),
    },
  },
  replicas: 2,
  ports: [8000], // Worker port
  args: ["worker"],
  serviceAccountName: rbac.serviceAccount.name,
  automountServiceAccount: true,
  disableIngress: true,
  disableProbes: true, // Workers don't need health checks
  extraEnv: {
    ...commonEnv,
    ...creds.toEnvValues(),
  },
  labels: {
    [WellKnownLabels.Name]: "authentik",
    [WellKnownLabels.Component]: "worker",
  },
});

class AuthentikMonitoring extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // LDAP Service (LoadBalancer)
    new KubeService(this, "ldap-service", {
      metadata: {
        name: "ldap",
        namespace: namespace,
        annotations: {
          "cmdcentral.xyz/hostname": "ldap.cmdcentral.xyz",
          "external-dns.alpha.kubernetes.io/hostname": "ldap.cmdcentral.xyz",
          "metallb.io/loadBalancerIPs": "10.0.10.82",
        },
        labels: {
          app: "authentik",
          "app.kubernetes.io/instance": "authentik",
          "app.kubernetes.io/name": "authentik",
          implementation: "kube-vip",
        },
      },
      spec: {
        type: "LoadBalancer",
        selector: {
          "app.kubernetes.io/managed-by": "goauthentik.io",
          "app.kubernetes.io/name": "authentik-outpost-ldap",
          "goauthentik.io/outpost-name": "ldap",
          "goauthentik.io/outpost-type": "ldap",
          "goauthentik.io/outpost-uuid": "031cac9c33df4b5db1f95795c07b6d6d",
        },
        ports: [
          {
            name: "ldap",
            port: 389,
            targetPort: 3389,
            protocol: "TCP",
          },
          {
            name: "ldaps",
            port: 636,
            targetPort: 6636,
            protocol: "TCP",
          },
        ],
      },
    });

    // Monitoring
    new CmdcentralServiceMonitor(this, "server-monitoring", {
      name: "authentik-server",
      namespace: namespace,
      matchLabels: {
        [WellKnownLabels.Name]: "authentik",
        [WellKnownLabels.Component]: "server",
      },
    });

    // VictoriaMetrics Service Scrape
    new VmServiceScrape(this, "vm-service-scrape", {
      metadata: {
        name: "authentik",
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            [WellKnownLabels.Name]: "authentik",
            [WellKnownLabels.Component]: "server",
          },
        },
        endpoints: [
          {
            port: "metrics",
            interval: "30s",
            path: "/metrics",
            scheme: VmServiceScrapeSpecEndpointsScheme.HTTP,
          },
        ],
      },
    });

    // VictoriaMetrics Rules
    new VmRule(this, "vm-rule", {
      metadata: {
        name: "authentik",
        namespace: namespace,
      },
      spec: {
        groups: [
          {
            name: "authentik",
            rules: [
              {
                alert: "AuthentikOutpostDown",
                expr: 'up{job="authentik-outpost"} == 0',
                for: "5m",
                labels: {
                  severity: "warning",
                },
                annotations: {
                  summary: "Authentik outpost is down",
                  description:
                    "Authentik outpost {{ $labels.instance }} has been down for more than 5 minutes.",
                },
              },
            ],
          },
        ],
      },
    });
  }
}

new AuthentikMonitoring(app, "authentik-monitoring");

app.synth();
NewKustomize(app.outdir);

