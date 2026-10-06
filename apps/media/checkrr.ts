import { Chart, Size } from "cdk8s";
import { Cpu, EnvValue, Probe, Volume } from "cdk8s-plus-34";
import { readFileSync } from "fs";
import { join } from "path";
import { Construct } from "constructs";
import { ExternalSecretSpecTargetTemplateEngineVersion } from "../../imports/external-secrets.io";
import { AppPlus } from "../../lib/app-plus";
import {
  MEDIA_GID,
  MEDIA_UID,
  NONROOT_SECURITY_CONTEXT_UID,
  RELOADER_ENABLED,
  TZ,
} from "../../lib/consts";
import { NFSConcreteVolume } from "../../lib/nfs";
import { BitwardenSecret } from "../../lib/secrets";
import { mediaLabel, namespace } from "./app";

const name = "checkrr";
const port = 8585;

// Exported for the argocd-image-updater config in apps/media/app.ts. Docker Hub
// only; upstream publishes no ghcr image.
export const CHECKRR_IMAGE = "docker.io/aetaric/checkrr:latest";

// Corruption scanning for the imported library, which Cleanuparr (queue-side
// only) doesn't do: ffprobes every video and flags anything that isn't
// audio/video/image/text. Moved in from a systemd unit on vmhost03 that had
// been disabled, with its *arr integration never configured.
export interface CheckrrProps {
  readonly tv: NFSConcreteVolume;
  readonly movies: NFSConcreteVolume;
  /** robfig/cron spec for the scan. Unchanged files are skipped by hash. */
  readonly schedule: string;
  /**
   * Have Sonarr delete and re-search episodes checkrr flags. Off, bad files are
   * only recorded in the web UI -- for reviewing a first scan before trusting
   * it. Radarr is report-only regardless; see checkrr.yaml.
   */
  readonly reacquire: boolean;
}

export class Checkrr extends Chart {
  constructor(scope: Construct, id: string, props: CheckrrProps) {
    super(scope, id);
    const labels = { "app.kubernetes.io/name": name, ...mediaLabel };

    const configTemplate = readFileSync(join(__dirname, "checkrr.yaml"), "utf-8")
      .replaceAll("@@CRON@@", props.schedule)
      .replaceAll("@@REACQUIRE@@", String(props.reacquire));

    // Same Bitwarden entries as the exportarr sidecars' sonarr-api/radarr-api.
    // checkrr reads only its YAML file, no env, so the keys have to be
    // rendered into it.
    const config = new BitwardenSecret(this, "config", {
      name: `${name}-config`,
      namespace: namespace,
      data: {
        SONARR_APIKEY: "9a5c19fe-540f-4118-b27d-b47e01821945",
        RADARR_APIKEY: "5c46e216-ac6c-4cd0-a268-b47e0182092b",
      },
      template: {
        engineVersion: ExternalSecretSpecTargetTemplateEngineVersion.V2,
        data: {
          "checkrr.yaml": configTemplate,
        },
      },
    });

    // The image runs as root by default; nothing in it needs to. Media is
    // mounted read-only -- deletions go through the *arr APIs, never the
    // filesystem.
    const securityContext = {
      ...NONROOT_SECURITY_CONTEXT_UID(Number(MEDIA_UID), Number(MEDIA_GID)),
      fsGroup: Number(MEDIA_GID),
    };

    new AppPlus(this, "app", {
      name: name,
      namespace: namespace,
      image: CHECKRR_IMAGE,
      labels: labels,
      // checkrr only reads its config at startup.
      annotations: RELOADER_ENABLED,
      args: ["-c", "/etc/checkrr/checkrr.yaml"],
      // the schedule is evaluated in local time
      extraEnv: { TZ: EnvValue.fromValue(TZ) },
      ports: [port],
      readinessProbe: Probe.fromHttpGet("/", { port: port }),
      livenessProbe: Probe.fromTcpSocket({ port: port }),
      resources: {
        cpu: {
          request: Cpu.millis(100),
        },
        memory: {
          request: Size.mebibytes(128),
          limit: Size.mebibytes(512),
        },
      },
      securityContext: securityContext,
      containerSecurityContext: securityContext,
      volumes: [
        {
          name: name,
          mountPath: "/data",
          props: {
            storage: Size.gibibytes(1),
          },
        },
      ],
      extraVolumeMounts: [
        {
          volume: Volume.fromSecret(this, "config-vol", config.secret),
          mountPath: "/etc/checkrr",
        },
        {
          volume: Volume.fromPersistentVolumeClaim(this, "tv-vol", props.tv.pvc, {
            readOnly: true,
          }),
          mountPath: "/tv",
          options: { readOnly: true },
        },
        {
          volume: Volume.fromPersistentVolumeClaim(this, "movies-vol", props.movies.pvc, {
            readOnly: true,
          }),
          mountPath: "/movies",
          options: { readOnly: true },
        },
      ],
    });
  }
}
