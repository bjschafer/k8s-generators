import { App, Duration, Size } from "cdk8s";
import { Cpu, EnvValue, Probe } from "cdk8s-plus-34";
import { Middleware } from "../../imports/traefik.io";
import { AppPlus } from "../../lib/app-plus";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, NONROOT_SECURITY_CONTEXT, TZ } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { WellKnownLabels } from "../../lib/labels";
import { OpenBaoSecret } from "../../lib/secrets";
import { basename } from "../../lib/util";
import { createAppDatabaseSecret } from "../postgres/database-provisioning";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "vaultwarden/server";
// Tracked by Renovate rather than the Argo image updater, so every version
// that reaches the password vault is a commit in git.
// renovate: datasource=docker depName=vaultwarden/server
const version = "1.37.5";
// Unprivileged: the image defaults to 80, which a non-root process cannot bind.
const port = 8080;
// The canonical URL. Vaultwarden takes exactly one DOMAIN, and builds the SSO
// redirect URI, email links, attachment URLs and the WebAuthn relying party
// from it -- so 2FA security keys registered here only work on this host, and
// clients should be pointed at it rather than at vaultwarden.cmdcentral.xyz.
const domain = "passwords.cmdcentral.xyz";
// UID/GID the container runs as. Upstream supports any non-root uid as long as
// /data is writable, which fsGroup takes care of on the RBD volume.
const uid = 1000;

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.GENERATORS,
  recurse: true,
});

const dbCreds = createAppDatabaseSecret(app, name);

// Both entries have to exist before the first sync.
//   kv/kubernetes/vaultwarden/vaultwarden:
//     ADMIN_TOKEN            argon2 PHC string from `vaultwarden hash`, never plaintext
//     PUSH_INSTALLATION_ID   from https://bitwarden.com/host/ (US region)
//     PUSH_INSTALLATION_KEY  ditto
//   kv/kubernetes/vaultwarden/authentik:
//     client_id, client_secret  from the Authentik provider (tf-authentik)
const secrets = new OpenBaoSecret(app, "secrets", {
  name: name,
  namespace: namespace,
  keys: ["ADMIN_TOKEN", "PUSH_INSTALLATION_ID", "PUSH_INSTALLATION_KEY"],
  refs: {
    SSO_CLIENT_ID: { path: `${namespace}/authentik`, property: "client_id" },
    SSO_CLIENT_SECRET: { path: `${namespace}/authentik`, property: "client_secret" },
  },
});

const vaultwarden = new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: `${image}:${version}`,
  labels: {
    [WellKnownLabels.Name]: name,
  },
  resources: {
    cpu: {
      request: Cpu.millis(20),
    },
    memory: {
      request: Size.mebibytes(64),
      limit: Size.mebibytes(512),
    },
  },
  ports: [port],
  // audited safe: upstream documents running as an arbitrary non-root uid with
  // ROCKET_PORT > 1024. The image's own USER is root, so the uid has to be
  // spelled out for the kubelet's runAsNonRoot check to pass.
  securityContext: { ...NONROOT_SECURITY_CONTEXT, user: uid, group: uid, fsGroup: uid },
  containerSecurityContext: { ...NONROOT_SECURITY_CONTEXT, user: uid, group: uid },
  volumes: [
    {
      name: `${name}-data`,
      // Attachments, Sends, the RSA key that signs login tokens, and the icon
      // cache. Vault items themselves live in Postgres.
      mountPath: "/data",
      props: {
        storage: Size.gibibytes(5),
      },
    },
  ],
  livenessProbe: Probe.fromHttpGet("/alive", {
    port: port,
    periodSeconds: Duration.seconds(30),
  }),
  readinessProbe: Probe.fromHttpGet("/alive", {
    port: port,
    periodSeconds: Duration.seconds(10),
  }),
  // Runs database migrations on boot.
  startupProbe: Probe.fromHttpGet("/alive", {
    port: port,
    failureThreshold: 30,
    periodSeconds: Duration.seconds(5),
  }),
  ingressHosts: [{ host: domain }, { host: `${name}.cmdcentral.xyz` }],
  ingressLabels: {
    "cmdcentral.xyz/external": "true",
  },
  extraEnv: {
    TZ: EnvValue.fromValue(TZ),
    DOMAIN: EnvValue.fromValue(`https://${domain}`),
    ROCKET_PORT: EnvValue.fromValue(`${port}`),
    // Declaration order matters: Kubernetes expands a $(VAR) reference only
    // against env vars declared *earlier* in the same container, so the
    // password has to precede the URL that interpolates it.
    DB_PASSWORD: EnvValue.fromSecretValue({ secret: dbCreds.secret, key: "password" }),
    DATABASE_URL: EnvValue.fromValue(
      `postgresql://${name}:$(DB_PASSWORD)@prod-pg17-pooler-rw.postgres.svc.cluster.local:5432/${name}`,
    ),
    // Accounts are created by invitation from the admin panel only.
    SIGNUPS_ALLOWED: EnvValue.fromValue("false"),
    INVITATIONS_ALLOWED: EnvValue.fromValue("true"),
    INVITATION_ORG_NAME: EnvValue.fromValue("Cmdcentral Passwords"),
    // Traffic from the tunnel arrives via cloudflared -> traefik, so X-Real-IP
    // is a pod address. Cloudflare overwrites this header on every request it
    // proxies; LAN traffic doesn't carry it and Vaultwarden falls back to the
    // socket address. Matters for the login rate limiter and the admin log.
    IP_HEADER: EnvValue.fromValue("CF-Connecting-IP"),

    // Authentik OIDC. SSO only replaces the login step -- the master password
    // still decrypts the vault -- and SSO_ONLY stays off so that email +
    // master password keeps working when Authentik (which runs in this same
    // cluster) is down. Provider lives in tf-authentik.
    SSO_ENABLED: EnvValue.fromValue("true"),
    SSO_ONLY: EnvValue.fromValue("false"),
    // Trailing slash is required by Authentik's issuer.
    SSO_AUTHORITY: EnvValue.fromValue("https://login.cmdcentral.xyz/application/o/vaultwarden/"),
    // offline_access gets a refresh token; without one the session ends with
    // the access token.
    SSO_SCOPES: EnvValue.fromValue("email profile offline_access"),
    // Lets the invited accounts link to their Authentik identity on first SSO
    // login. Safe because the provider only ever asserts verified emails.
    SSO_SIGNUPS_MATCH_EMAIL: EnvValue.fromValue("true"),

    SMTP_HOST: EnvValue.fromValue("smtp.smtp.svc.cluster.local"),
    SMTP_PORT: EnvValue.fromValue("25"),
    SMTP_SECURITY: EnvValue.fromValue("off"),
    SMTP_FROM: EnvValue.fromValue("passwords@cmdcentral.net"),
    SMTP_FROM_NAME: EnvValue.fromValue("Vaultwarden"),

    // Relays sync notifications to the mobile apps through Bitwarden's push
    // service; without it phones only pick up changes on a manual sync.
    PUSH_ENABLED: EnvValue.fromValue("true"),
    ...secrets.toEnvValues(),
  },
});

// Vaultwarden sends no HSTS header itself and leaves it to the proxy. Set here
// rather than in Cloudflare so it also covers LAN clients, which resolve these
// hosts straight to traefik. No includeSubDomains: other *.cmdcentral.xyz
// hosts aren't all HTTPS-only.
// Base cdk8s: Middleware is a traefik CRD with no cdk8s-plus equivalent.
const hsts = new Middleware(vaultwarden, `${name}-hsts`, {
  metadata: {
    name: `${name}-hsts`,
    namespace: namespace,
  },
  spec: {
    headers: {
      stsSeconds: 31536000,
    },
  },
});
vaultwarden.Ingress?.metadata.addAnnotation(
  "traefik.ingress.kubernetes.io/router.middlewares",
  `${namespace}-${hsts.name}@kubernetescrd`,
);

app.synth();
NewKustomize(app.outdir);
