import { App, Chart, Duration, Size } from "cdk8s";
import {
  Cpu,
  EnvValue,
  Probe,
  Protocol,
  Service,
  ServiceAccount,
  ServiceType,
} from "cdk8s-plus-34";
import { Construct } from "constructs";
import { basename } from "path";
import { KubeClusterRole, KubeClusterRoleBinding } from "../../imports/k8s";
import {
  VmServiceScrape,
  VmServiceScrapeSpecEndpointsScheme,
} from "../../imports/operator.victoriametrics.com";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, externalDnsHostname, NONROOT_SECURITY_CONTEXT } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { WellKnownLabels } from "../../lib/labels";
import { CmdcentralServiceMonitor, MonitoringRule } from "../../lib/monitoring/victoriametrics";
import { OpenBaoSecret } from "../../lib/secrets";

const namespace = basename(__dirname);
const app = new App(DEFAULT_APP_PROPS(namespace));

// authentik ships a new calendar minor roughly monthly and the updater is
// capped at this one (the constraint below derives from it), so nothing here
// would ever mention 2026.9 on its own. Renovate does -- as a PR to read, since
// an authentik minor runs migrations.
// renovate: datasource=docker depName=ghcr.io/goauthentik/server
const version = "2026.8.0";

NewArgoApp(namespace, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: `ghcr.io/goauthentik/server`,
        strategy: "semver",
        versionConstraint: `${version.slice(0, version.lastIndexOf("."))}.x`,
      },
    ],
  },
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

    // Cluster Role. Raw rules rather than cdk8s-plus ClusterRole, which wants a
    // typed resource object per entry -- most of these are CRDs it has no type for.
    const clusterRole = new KubeClusterRole(this, "authentik-cluster-role", {
      metadata: {
        name: "authentik",
      },
      rules: [
        {
          apiGroups: [""],
          resources: ["secrets", "services", "configmaps"],
          verbs: ["get", "create", "update", "list", "patch"],
        },
        {
          apiGroups: ["apps"],
          resources: ["deployments"],
          verbs: ["get", "create", "update", "list", "patch"],
        },
        {
          apiGroups: ["gateway.networking.k8s.io"],
          resources: ["httproutes"],
          verbs: ["get", "create", "update", "list", "patch"],
        },
        {
          apiGroups: ["extensions", "networking.k8s.io"],
          resources: ["ingresses"],
          verbs: ["get", "create", "update", "list", "patch"],
        },
        {
          apiGroups: ["traefik.containo.us", "traefik.io"],
          resources: ["middlewares"],
          verbs: ["get", "create", "update", "list", "patch"],
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
const creds = new OpenBaoSecret(app, "creds", {
  name: "creds",
  namespace: namespace,
  keys: ["AUTHENTIK_SECRET_KEY", "AUTHENTIK_POSTGRESQL__PASSWORD"],
});

// Common environment variables
const commonEnv: Record<string, EnvValue> = {
  AUTHENTIK_AVATARS: EnvValue.fromValue("gravatar"),
  AUTHENTIK_EMAIL__FROM: EnvValue.fromValue("login@cmdcentral.net"),
  AUTHENTIK_EMAIL__HOST: EnvValue.fromValue("smtp.smtp.svc.cluster.local"),
  AUTHENTIK_EMAIL__PORT: EnvValue.fromValue("25"),
  AUTHENTIK_EMAIL__TIMEOUT: EnvValue.fromValue("30"),
  AUTHENTIK_EMAIL__USE_SSL: EnvValue.fromValue("false"),
  AUTHENTIK_EMAIL__USE_TLS: EnvValue.fromValue("false"),
  AUTHENTIK_ERROR_REPORTING__ENABLED: EnvValue.fromValue("false"),
  AUTHENTIK_ERROR_REPORTING__ENVIRONMENT: EnvValue.fromValue("k8s"),
  AUTHENTIK_ERROR_REPORTING__SEND_PII: EnvValue.fromValue("false"),
  AUTHENTIK_EVENTS__CONTEXT_PROCESSORS__GEOIP: EnvValue.fromValue("/geoip/GeoLite2-City.mmdb"),
  AUTHENTIK_LOG_LEVEL: EnvValue.fromValue("info"),
  AUTHENTIK_OUTPOSTS__CONTAINER_IMAGE_BASE: EnvValue.fromValue(
    "ghcr.io/goauthentik/%(type)s:%(version)s",
  ),
  AUTHENTIK_POSTGRESQL__HOST: EnvValue.fromValue("prod.postgres.svc.cluster.local"),
  AUTHENTIK_POSTGRESQL__NAME: EnvValue.fromValue("authentik"),
  AUTHENTIK_POSTGRESQL__PORT: EnvValue.fromValue("5432"),
  AUTHENTIK_POSTGRESQL__USER: EnvValue.fromValue("authentik"),
};

// Authentik Server
const server = new AppPlus(app, "authentik-server", {
  name: "authentik-server",
  namespace: namespace,
  image: `ghcr.io/goauthentik/server:${version}`,
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
  // audited safe: image ships USER=1000
  securityContext: NONROOT_SECURITY_CONTEXT,
  containerSecurityContext: NONROOT_SECURITY_CONTEXT,
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
server.Service!.metadata.addAnnotation(
  "service.beta.kubernetes.io/do-loadbalancer-enable-proxy-protocol",
  "true",
);

// Authentik Worker
new AppPlus(app, "authentik-worker", {
  name: "authentik-worker",
  namespace: namespace,
  image: `ghcr.io/goauthentik/server:${version}`,
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.mebibytes(1024),
      limit: Size.mebibytes(2048),
    },
  },
  replicas: 2,
  ports: [9000],
  // audited safe: image ships USER=1000
  securityContext: NONROOT_SECURITY_CONTEXT,
  containerSecurityContext: NONROOT_SECURITY_CONTEXT,
  monitoringConfig: {
    port: 9300,
  },
  // The worker serves no health route on 9000, so use the image's own check.
  startupProbe: Probe.fromCommand(["ak", "healthcheck"], {
    periodSeconds: Duration.seconds(5),
    failureThreshold: 30,
    timeoutSeconds: Duration.seconds(10),
  }),
  livenessProbe: Probe.fromCommand(["ak", "healthcheck"], {
    periodSeconds: Duration.seconds(30),
    timeoutSeconds: Duration.seconds(10),
    failureThreshold: 3,
  }),
  readinessProbe: Probe.fromCommand(["ak", "healthcheck"], {
    periodSeconds: Duration.seconds(30),
    timeoutSeconds: Duration.seconds(10),
  }),
  args: ["worker"],
  serviceAccountName: rbac.serviceAccount.name,
  automountServiceAccount: true,
  disableIngress: true,
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
    const ldap = new Service(this, "ldap-service", {
      metadata: {
        name: "ldap",
        namespace: namespace,
        annotations: {
          "cmdcentral.xyz/hostname": "ldap.cmdcentral.xyz",
          ...externalDnsHostname("ldap.cmdcentral.xyz"),
          "metallb.io/loadBalancerIPs": "10.0.10.82",
        },
        labels: {
          app: "authentik",
          "app.kubernetes.io/instance": "authentik",
          "app.kubernetes.io/name": "authentik",
          implementation: "kube-vip",
        },
      },
      type: ServiceType.LOAD_BALANCER,
      ports: [
        { name: "ldap", port: 389, targetPort: 3389, protocol: Protocol.TCP },
        { name: "ldaps", port: 636, targetPort: 6636, protocol: Protocol.TCP },
      ],
    });
    // The outpost Deployment is created by authentik itself, not this repo.
    for (const [key, value] of Object.entries({
      "app.kubernetes.io/managed-by": "goauthentik.io",
      "app.kubernetes.io/name": "authentik-outpost-ldap",
      "goauthentik.io/outpost-name": "ldap",
      "goauthentik.io/outpost-type": "ldap",
      "goauthentik.io/outpost-uuid": "e081b496b3354364bb3198f42a8875d0",
    })) {
      ldap.selectLabel(key, value);
    }

    // Monitoring
    new CmdcentralServiceMonitor(this, "server-monitoring", {
      name: "authentik-server",
      namespace: namespace,
      matchLabels: {
        [WellKnownLabels.Name]: "authentik",
        [WellKnownLabels.Component]: "server",
      },
    });
    new CmdcentralServiceMonitor(this, "worker-monitoring", {
      name: "authentik-worker",
      namespace: namespace,
      matchLabels: {
        [WellKnownLabels.Name]: "authentik",
        [WellKnownLabels.Component]: "worker",
      },
      portName: "metrics",
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

    // VictoriaMetrics Rules -- MonitoringRule places the VMRule in the metrics
    // namespace and labels it so the VMAlert instance there selects it.
    new MonitoringRule(this, "vm-rule", {
      name: "authentik",
      ruleGroups: [
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
    });
  }
}

new AuthentikMonitoring(app, "authentik-monitoring");

app.synth();
NewKustomize(app.outdir);
