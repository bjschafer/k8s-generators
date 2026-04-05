import { App, Chart, Size } from "cdk8s";
import { ConfigMap, Cpu, EnvValue } from "cdk8s-plus-33";
import { Construct } from "constructs";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { BitwardenSecret } from "../../lib/secrets";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 25;

NewArgoApp(name, {
  namespace,
  autoUpdate: {
    images: [
      {
        image: "boky/postfix",
        strategy: "semver",
      },
    ],
  },
});

// Strip incoming Message-ID headers so Postfix regenerates them with the correct FQDN.
// Without this, Django/Authentik sets Message-IDs with pod hostnames that Cloudflare rejects.
class SmtpConfig extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    new ConfigMap(this, `${name}-header-checks`, {
      metadata: { name: `${name}-header-checks`, namespace },
      data: {
        header_checks:
          [
            // Strip Received headers containing internal cluster hostnames/IPs.
            // Must use smtp_header_checks (outgoing stage) not header_checks (cleanup stage),
            // because Postfix adds its own Received header after cleanup runs.
            "/^Received:/ IGNORE",
            // Strip Message-ID so Cloudflare doesn't reject the pod hostname in it.
            "/^Message-ID:/ IGNORE",
          ].join("\n") + "\n",
      },
    });
  }
}
new SmtpConfig(app, "smtp-config");

const secrets = new BitwardenSecret(app, `${name}-secrets`, {
  name,
  namespace,
  data: {
    RELAYHOST_PASSWORD: "88c10a6c-268a-412a-b3d0-b4230026ba80",
  },
});

new AppPlus(app, `${name}-app`, {
  name,
  namespace,
  image: "boky/postfix:latest",
  disableIngress: true,
  ports: [port],
  configmapMounts: [
    {
      name: `${name}-header-checks`,
      mountPath: "/etc/postfix/header_checks",
      subPath: "header_checks",
    },
  ],
  resources: {
    cpu: {
      request: Cpu.millis(10),
      limit: Cpu.millis(200),
    },
    memory: {
      request: Size.mebibytes(64),
      limit: Size.mebibytes(256),
    },
  },
  extraEnv: {
    // Upstream Cloudflare SMTP relay
    RELAYHOST: EnvValue.fromValue("[smtp.mx.cloudflare.net]:465"),
    RELAYHOST_USERNAME: EnvValue.fromValue("api_token"),
    RELAYHOST_PASSWORD: EnvValue.fromSecretValue({
      secret: secrets.secret,
      key: "RELAYHOST_PASSWORD",
    }),
    // Port 465 uses implicit TLS (SMTPS/wrappermode) rather than STARTTLS
    POSTFIX_smtp_tls_security_level: EnvValue.fromValue("encrypt"),
    POSTFIX_smtp_tls_wrappermode: EnvValue.fromValue("yes"),
    // Allow any sender domain — internal clients won't always share a common domain
    ALLOW_EMPTY_SENDER_DOMAINS: EnvValue.fromValue("true"),
    // Use a valid FQDN so Message-ID headers aren't rejected by Cloudflare
    POSTFIX_myhostname: EnvValue.fromValue("smtp.cmdcentral.net"),
    // Strip Received and Message-ID headers at the outgoing SMTP stage (before Cloudflare sees them)
    POSTFIX_smtp_header_checks: EnvValue.fromValue(
      "regexp:/etc/postfix/header_checks",
    ),
  },
});

app.synth();
NewKustomize(app.outdir);
