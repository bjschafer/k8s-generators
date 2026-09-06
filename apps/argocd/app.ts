import { App, Chart } from "cdk8s";
import { Construct } from "constructs";
import { basename } from "path";
import { ENABLE_SERVERSIDE_APPLY, NewArgoApp } from "../../lib/argo";
import { CLUSTER_ISSUER, DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { NewKustomize } from "../../lib/kustomize";
import { Certificate } from "../../imports/cert-manager.io";
import {
  IngressRoute,
  IngressRouteSpecRoutesKind,
  IngressRouteSpecRoutesServicesKind,
  IngressRouteSpecRoutesServicesPort,
  // NOT lib/traefik.ts's `traefik.containo.us` import -- that API group does not
  // exist in this cluster (only `ingressroutes.traefik.io` is installed), so
  // anything rendered from it fails to apply with "no matches for kind".
} from "../../imports/traefik.io";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
// renovate: datasource=helm depName=argo-cd registryUrl=https://argoproj.github.io/argo-helm
const version = "10.8.0";

const hostname = "argo.cmdcentral.xyz";
const tlsSecretName = "argocd-server";

/**
 * ArgoCD itself, self-managed.
 *
 * Deliberately NOT on `automated` sync: this is the one app whose controller is
 * also the thing being reconciled, so a bad render would otherwise roll itself
 * out before anyone could look at it. Sync this one by hand and read the diff.
 *
 * If ArgoCD is ever broken badly enough that it can't sync itself, `dist/argocd`
 * is plain YAML -- recover with `kubectl apply -f dist/argocd/ --server-side`
 * from a checkout. That path replaces the old `prod/argocd/upgrade.sh`.
 *
 * ServerSideApply is not optional: the three argoproj.io CRDs the chart ships
 * are far past the 256KB ceiling on the last-applied-configuration annotation a
 * client-side apply would try to write (same reasoning as apps/cnpg).
 */
NewArgoApp(name, {
  namespace: namespace,
  sync_policy: {
    ...ENABLE_SERVERSIDE_APPLY.sync_policy,
    // Explicitly clears NewArgoApp's automated{prune,selfHeal} default.
    automated: undefined,
  },
});

new HelmApp(app, "helm", {
  chart: "argo-cd",
  repo: "https://argoproj.github.io/argo-helm",
  version: version,
  releaseName: name,
  namespace: namespace,
  // The bundled redis-ha subchart renders two `helm.sh/hook: test-success` Pods
  // that only exist for `helm test`. They have no meaning in a directory-type
  // Argo app and would just sit in dist/ as untracked cruft.
  helmFlags: ["--skip-tests"],
  values: {
    // Matches the deployed topology, which came from manifests/ha/install.yaml.
    "redis-ha": {
      enabled: true,
    },
    controller: {
      replicas: 1,
      metrics: { enabled: true },
    },
    server: {
      replicas: 2,
      metrics: { enabled: true },
    },
    repoServer: {
      replicas: 2,
      metrics: { enabled: true },
    },
    applicationSet: {
      replicas: 1,
      metrics: { enabled: true },
    },
    notifications: {
      enabled: true,
      metrics: { enabled: true },
    },
    dex: {
      enabled: true,
      metrics: { enabled: true },
      // The entire reason this app exists in git.
      //
      // `argocd-dex rundex` runs `dex serve` as a *child* process. Dex treats a
      // failure to open any connector at startup as fatal and exits -- and if
      // DNS for login.cmdcentral.xyz is briefly unresolvable while the cluster
      // is coming back up, that is exactly what happens. The wrapper survives,
      // so without probes the container stays Running, the pod stays Ready, the
      // Service keeps its endpoint, and every login gets `connection refused` on
      // 5556 until someone restarts the Deployment by hand. Observed 4x in 90
      // days of log retention.
      //
      // These hit /healthz/{live,ready} on the metrics port, which the same dex
      // process serves -- so they go away exactly when dex does. The chart
      // defaults them all to `enabled: false`, which is why upstream's raw
      // install.yaml ships a Deployment with no probes at all.
      livenessProbe: { enabled: true },
      readinessProbe: { enabled: true },
      startupProbe: { enabled: true },
    },
    configs: {
      // The live argocd-secret is a SealedSecret that stays in the k8s-prod
      // repo -- it holds admin.password, accounts.bschafer.password,
      // dex.authentik.clientSecret and a tls.crt. This repo is public, so it
      // must not move here, and the chart must not render a replacement over
      // the top of it.
      secret: {
        createSecret: false,
      },
      params: {
        // Traefik terminates TLS in front of argocd-server; see the IngressRoute
        // below. redis.server is deliberately absent -- the chart wires the
        // components to the redis-ha haproxy on its own.
        "server.insecure": true,
      },
      cm: {
        url: `https://${hostname}`,
        "admin.enabled": false,
        "accounts.bschafer": "apiKey, login",
        "oidc.tls.insecure.skip.verify": true,
        "dex.config": `connectors:
- config:
    issuer: https://login.cmdcentral.xyz/application/o/argocd/
    clientID: f9aec50d48a55db087348937082ae9d5fa69d846
    clientSecret: $dex.authentik.clientSecret
    insecureEnableGroups: true
    scopes:
      - openid
      - profile
      - email
      - groups
  name: authentik
  type: oidc
  id: authentik
`,
        // Both are written by controllers on a schedule and would otherwise
        // show every app that owns one as permanently OutOfSync.
        "resource.exclusions": `- apiGroups:
  - "snapshot.storage.k8s.io"
  kinds:
  - VolumeSnapshot
  clusters:
  - "*"
- apiGroups:
  - "velero.io"
  kinds:
  - Backup
  clusters:
  - "*"
`,
      },
      rbac: {
        "policy.default": "role:readonly",
        "policy.csv": `g, bschafer, role:admin
g, wheel, role:admin
`,
      },
    },
  },
});

/**
 * Ingress for the ArgoCD UI and the gRPC API the `argocd` CLI speaks.
 *
 * Not `lib/traefik.ts`'s AuthentikIngressRoute: that attaches the authentik
 * forward-auth middleware, and ArgoCD authenticates through dex/OIDC itself.
 * It also has no way to express the second, higher-priority h2c route, without
 * which `argocd login`/`argocd app list` fail -- Traefik would otherwise proxy
 * gRPC as HTTP/1.1.
 */
class ArgoCdIngress extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id, { namespace: namespace });

    new Certificate(this, "certificate", {
      metadata: {
        name: "argocd-server",
        namespace: namespace,
      },
      spec: {
        dnsNames: [hostname, "argocd.cmdcentral.xyz"],
        issuerRef: CLUSTER_ISSUER,
        secretName: tlsSecretName,
      },
    });

    new IngressRoute(this, "ingressroute", {
      metadata: {
        name: "argocd-server",
        namespace: namespace,
      },
      spec: {
        entryPoints: ["websecure"],
        routes: [
          {
            kind: IngressRouteSpecRoutesKind.RULE,
            match: `Host(\`${hostname}\`)`,
            priority: 10,
            services: [
              {
                kind: IngressRouteSpecRoutesServicesKind.SERVICE,
                name: "argocd-server",
                port: IngressRouteSpecRoutesServicesPort.fromNumber(80),
              },
            ],
          },
          {
            kind: IngressRouteSpecRoutesKind.RULE,
            match: `Host(\`${hostname}\`) && Header(\`Content-Type\`, \`application/grpc\`)`,
            priority: 11,
            services: [
              {
                kind: IngressRouteSpecRoutesServicesKind.SERVICE,
                name: "argocd-server",
                port: IngressRouteSpecRoutesServicesPort.fromNumber(80),
                scheme: "h2c",
              },
            ],
          },
        ],
        tls: {
          secretName: tlsSecretName,
        },
      },
    });
  }
}

new ArgoCdIngress(app, "ingress");

app.synth();
NewKustomize(app.outdir);
