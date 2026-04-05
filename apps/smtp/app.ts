import { App, Size } from "cdk8s";
import { Cpu, EnvValue } from "cdk8s-plus-33";
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

// TODO: replace with the Bitwarden secret UUID for the Cloudflare SMTP API token
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
  },
});

app.synth();
NewKustomize(app.outdir);
