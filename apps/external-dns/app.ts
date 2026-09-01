import { App, Chart, Size } from "cdk8s";
import { Cpu, Deployment, DeploymentStrategy, EnvValue, ServiceAccount } from "cdk8s-plus-34";
import { Construct } from "constructs";
import { KubeClusterRole, KubeClusterRoleBinding } from "../../imports/k8s";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import {
  DEFAULT_APP_PROPS,
  DEFAULT_SECURITY_CONTEXT,
  NONROOT_SECURITY_CONTEXT,
} from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { BitwardenSecret } from "../../lib/secrets";
import { basename } from "../../lib/util";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));

// The single source of truth for the pin: the tag below and the updater's
// versionConstraint both derive from it, so the ceiling can never drift from
// what is deployed. Renovate watches it for the minor the updater is not
// allowed to take -- as a PR to read, never to automerge. A minor here has
// already cost five live records once; see --annotation-prefix below.
// renovate: datasource=docker depName=registry.k8s.io/external-dns/external-dns
const EXTERNAL_DNS_VERSION = "v0.22.0";
const EXTERNAL_DNS_IMAGE = `registry.k8s.io/external-dns/external-dns:${EXTERNAL_DNS_VERSION}`;
// `v0.22.0` -> `v0.22.x`
const EXTERNAL_DNS_LINE = `${EXTERNAL_DNS_VERSION.split(".").slice(0, 2).join(".")}.x`;
const UNIFI_WEBHOOK_IMAGE = "ghcr.io/home-operations/external-dns-unifi-webhook:latest";

const COMMON_ARGS = [
  "--source=service",
  "--source=ingress",
  "--source=traefik-proxy",
  "--interval=30s",
  "--policy=sync",
  // Named explicitly rather than left to the default. external-dns reads
  // exactly one prefix, and a resource missing the one being read looks like a
  // resource that wants no record, which --policy=sync then deletes -- so the
  // default moving underneath us is a record-deleting event. v0.22.0 did
  // exactly that (alpha -> GA), and it is the whole of what af63b1fc hit: the
  // two source regressions its message blamed do not exist, and the traefik
  // host extractor is byte-identical across the two tags. Pinning the prefix
  // here makes the next such flip a no-op.
  "--annotation-prefix=external-dns.kubernetes.io/",
];

NewArgoApp(name, {
  namespace,
  sync_policy: {
    automated: { prune: true, selfHeal: true },
  },
  autoUpdate: {
    images: [
      {
        // held to a minor line, not to a major one: v0.22.0 deleted five live
        // records the last time a minor landed unattended (the annotation
        // prefix flip, handled in COMMON_ARGS), so the next one gets read by a
        // human rather than taken by the updater on its 1h pass.
        image: "registry.k8s.io/external-dns/external-dns",
        strategy: "semver",
        versionConstraint: EXTERNAL_DNS_LINE,
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
    "api-key": "0b0d8193-640e-4b27-a093-b46f002363eb",
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
    UNIFI_API_KEY: "4011a6c5-0cd3-4a5f-9b96-b46f002528dc",
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
      automountServiceAccountToken: true,
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
      // audited safe: image ships USER=65532 (unlike the external-dns
      // container above, which is untested and stays on the permissive default)
      securityContext: NONROOT_SECURITY_CONTEXT,
      envVariables: {
        UNIFI_HOST: EnvValue.fromValue("https://10.0.10.1"),
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
