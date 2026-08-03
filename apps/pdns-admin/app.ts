import { basename } from "../../lib/util";
import { DEFAULT_APP_PROPS, DEFAULT_SECURITY_CONTEXT } from "../../lib/consts";
import { App, Size } from "cdk8s";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { StorageClass } from "../../lib/volume";
import { EnvValue, PersistentVolume, PersistentVolumeAccessMode, Probe } from "cdk8s-plus-34";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "powerdnsadmin/pda-legacy";

NewArgoApp(name, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "digest",
      },
    ],
  },
});

new AppPlus(app, `${name}-app`, {
  name: name,
  namespace: namespace,
  image: `${image}:latest`,
  resources: {
    memory: {
      request: Size.mebibytes(192),
      limit: Size.mebibytes(512),
    },
  },
  ports: [80],
  extraEnv: {
    // Works around an upstream regression in v0.5.1 (the first pda-legacy
    // release since v0.4.2, Jan 2024). Flask 3 removed before_app_first_request,
    // so register_modules() moved to before_app_request -- but Flask sets
    // _got_first_request before running those hooks, so oidc_oauth()'s
    // `@current_app.route('/oidc/authorized')` now raises AssertionError on
    // every request, 500ing / and failing the liveness probe. The run-once
    // guard is set *after* the raising call, so it never latches.
    //
    // Config beats the DB in Setting().get(), so this env var forces
    // oidc_oauth() to return early regardless of what's stored in /data.
    // SSO is dead while this is set -- log in with a local account.
    // Remove once upstream registers the OIDC route at app-init time.
    OIDC_OAUTH_ENABLED: EnvValue.fromValue("False"),
  },
  // v0.5.1 rebuilt pda-legacy off docker/common/Dockerfile.app, which dropped
  // the `pda` user entirely -- there is no uid 100 in the image anymore, and
  // /app ships root-owned (the webassets cache is mode 0600), with an
  // entrypoint that never drops privileges. Pinning uid 100/101 here got us
  // PermissionError on .webassets-cache and /.gunicorn. Reverts the
  // 8c2e7014 hardening for this one app until upstream restores a non-root USER.
  securityContext: DEFAULT_SECURITY_CONTEXT,
  containerSecurityContext: DEFAULT_SECURITY_CONTEXT,
  volumes: [
    {
      props: {
        storageClassName: StorageClass.CEPH_RBD,
        storage: Size.gibibytes(5),
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
        // Pinned to the volume this app has used since it was hand-applied from
        // the prod repo. Without this the claim is satisfied by dynamic
        // provisioning and pdns-admin comes back with an empty database.
        // A longhorn migration was written here once (37eef77a) but never
        // deployed -- doing it for real needs a data copy, not a manifest edit.
        volume: PersistentVolume.fromPersistentVolumeName(
          app,
          "pdns-admin-config-pv",
          "pvc-21ad7eba-9add-477e-a3c4-e1147528c57d",
        ),
      },
      mountPath: "/data",
      name: "app-config",
    },
  ],
  livenessProbe: Probe.fromHttpGet("", { port: 80 }),
  readinessProbe: Probe.fromHttpGet("", { port: 80 }),
  extraIngressHosts: ["dnsadmin.cmdcentral.xyz"],
  limitToAMD64: true,
});

app.synth();

NewKustomize(app.outdir);
