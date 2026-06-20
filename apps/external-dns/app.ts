import { App, Chart, Size } from "cdk8s";
import {
  Cpu,
  Deployment,
  DeploymentStrategy,
  EnvValue,
  ServiceAccount,
} from "cdk8s-plus-33";
import { Construct } from "constructs";
import { KubeClusterRole, KubeClusterRoleBinding } from "../../imports/k8s";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, DEFAULT_SECURITY_CONTEXT } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { BitwardenSecret } from "../../lib/secrets";
import { basename } from "../../lib/util";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

const EXTERNAL_DNS_IMAGE = "registry.k8s.io/external-dns/external-dns:v0.20.0";
const UNIFI_WEBHOOK_IMAGE = "ghcr.io/home-operations/external-dns-unifi-webhook:latest";

const COMMON_ARGS = [
  "--source=service",
  "--source=ingress",
  "--source=traefik-proxy",
  "--interval=30s",
];

NewArgoApp(name, {
  namespace,
  sync_policy: {
    automated: { prune: true, selfHeal: true },
  },
  autoUpdate: {
    images: [
      {
        image: "registry.k8s.io/external-dns/external-dns",
        strategy: "semver",
      },
      {
        image: "ghcr.io/home-operations/external-dns-unifi-webhook",
        strategy: "semver",
      },
    ],
  },
});

class ExternalDnsRBAC extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new ServiceAccount(this, "sa", {
      metadata: { name: "external-dns", namespace },
    });

    new KubeClusterRole(this, "cluster-role", {
      metadata: { name: "external-dns" },
      rules: [
        {
          apiGroups: [""],
          resources: ["services", "endpoints", "pods", "nodes"],
          verbs: ["get", "watch", "list"],
        },
        {
          apiGroups: ["extensions", "networking.k8s.io"],
          resources: ["ingresses"],
          verbs: ["get", "watch", "list"],
        },
        {
          apiGroups: ["traefik.containo.us", "traefik.io"],
          resources: ["ingressroutes", "ingressroutetcps", "ingressrouteudps"],
          verbs: ["get", "watch", "list"],
        },
        {
          apiGroups: ["discovery.k8s.io"],
          resources: ["endpointslices"],
          verbs: ["get", "watch", "list"],
        },
      ],
    });

    new KubeClusterRoleBinding(this, "cluster-role-binding", {
      metadata: { name: "external-dns-viewer" },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "external-dns",
      },
      subjects: [{ kind: "ServiceAccount", name: "external-dns", namespace }],
    });
  }
}

new ExternalDnsRBAC(app, "rbac");

// pdns provider — manages cmdcentral.xyz records in PowerDNS
const pdnsSecret = new BitwardenSecret(app, "pdns-secret", {
  name: "external-dns-pdns",
  namespace,
  data: {
    "api-key": "REPLACE_WITH_BITWARDEN_UUID",
  },
});

new AppPlus(app, "pdns", {
  name: "external-dns-pdns",
  namespace,
  image: EXTERNAL_DNS_IMAGE,
  serviceAccountName: "external-dns",
  automountServiceAccount: true,
  disableIngress: true,
  disableService: true,
  disableProbes: true,
  deploymentStrategy: DeploymentStrategy.recreate(),
  resources: {
    cpu: { request: Cpu.millis(25), limit: Cpu.millis(100) },
    memory: { request: Size.mebibytes(64), limit: Size.mebibytes(256) },
  },
  args: [
    ...COMMON_ARGS,
    "--provider=pdns",
    "--pdns-server=http://10.0.10.100:8081",
    "--pdns-api-key=$(PDNS_API_KEY)",
    "--txt-owner-id=prod-k8s-external-dns",
  ],
  extraEnv: {
    PDNS_API_KEY: EnvValue.fromSecretValue({
      secret: pdnsSecret.secret,
      key: "api-key",
    }),
  },
});

// unifi webhook provider — manages local DNS entries in the Unifi controller
const unifiSecret = new BitwardenSecret(app, "unifi-secret", {
  name: "external-dns-unifi",
  namespace,
  data: {
    UNIFI_PASS: "REPLACE_WITH_BITWARDEN_UUID",
  },
});

class ExternalDnsUnifi extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const saRef = ServiceAccount.fromServiceAccountName(this, "sa", "external-dns");

    const deploy = new Deployment(this, "deployment", {
      metadata: { name: "external-dns-unifi", namespace },
      replicas: 1,
      strategy: DeploymentStrategy.recreate(),
      securityContext: DEFAULT_SECURITY_CONTEXT,
      serviceAccount: saRef,
      containers: [
        {
          name: "external-dns",
          image: EXTERNAL_DNS_IMAGE,
          securityContext: DEFAULT_SECURITY_CONTEXT,
          args: [
            ...COMMON_ARGS,
            "--provider=webhook",
            "--webhook-provider-url=http://localhost:8888",
            "--txt-owner-id=prod-k8s-unifi",
          ],
          resources: {
            cpu: { request: Cpu.millis(25), limit: Cpu.millis(100) },
            memory: { request: Size.mebibytes(64), limit: Size.mebibytes(256) },
          },
        },
      ],
    });

    deploy.addContainer({
      name: "unifi-webhook",
      image: UNIFI_WEBHOOK_IMAGE,
      securityContext: DEFAULT_SECURITY_CONTEXT,
      envVariables: {
        UNIFI_HOST: EnvValue.fromValue("https://10.0.10.1"),
        UNIFI_USER: EnvValue.fromValue("external-dns"),
        UNIFI_SKIP_TLS_VERIFY: EnvValue.fromValue("true"),
        ...unifiSecret.toEnvValues(),
      },
      resources: {
        cpu: { request: Cpu.millis(25), limit: Cpu.millis(100) },
        memory: { request: Size.mebibytes(32), limit: Size.mebibytes(64) },
      },
      ports: [{ number: 8888, name: "webhook" }],
    });
  }
}

new ExternalDnsUnifi(app, "unifi");

app.synth();
NewKustomize(app.outdir);
