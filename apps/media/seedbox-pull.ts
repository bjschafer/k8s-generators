import { Chart, Cron, Duration, Size } from "cdk8s";
import {
  ConcurrencyPolicy,
  ConfigMap,
  Cpu,
  CronJob,
  EnvValue,
  ImagePullPolicy,
  RestartPolicy,
  Volume,
} from "cdk8s-plus-34";
import { readFileSync } from "fs";
import { join } from "path";
import { Construct } from "constructs";
import { MEDIA_GID, MEDIA_UID, NONROOT_SECURITY_CONTEXT_UID } from "../../lib/consts";
import { NFSConcreteVolume } from "../../lib/nfs";
import { BitwardenSecret } from "../../lib/secrets";
import { mediaLabel, namespace } from "./app";

const name = "seedbox-pull";

// ghcr rather than Docker Hub: same manifest digest as rclone/rclone, published
// by rclone's own release workflow. Exported so apps/media/app.ts can hand it
// to argocd-image-updater, which follows `:latest` by digest -- this pulls
// IfNotPresent, so without that it would never move off its first pull.
export const SEEDBOX_PULL_IMAGE = "ghcr.io/rclone/rclone:latest";

// The seedbox's port 22 is ProFTPD mod_sftp, not OpenSSH: SFTP only, password
// auth only, and a lone ssh-rsa host key. No shell means no remote hashing, so
// rclone compares on size + modtime.
const SEEDBOX_HOST = "psb52743.seedbox.io";
const SEEDBOX_USER = "psb52743";
const SEEDBOX_KNOWN_HOSTS =
  "psb52743.seedbox.io ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDLw8QPXaNlm+aMT1HwhT2+HsMk+50SQgXTasZktlbteX8HcEHjelbhzs4iomzVjmv7tKjnnjpLqIOot3l424qT0U/0PwrP1dNn0Q6iG+p4r8uuQmMuRGRxk0MJIdS++5MYaSAXR52ML9/VuNkwa1J9FEl6LaQsOiy3mYYHI5Wbwze2He7SOSpKULQO+eMdhvh/Chaai3kjJN7dlhQ5eHqDulQK2eovsgbq5ALZ4wb9onL+3Yh5jZQZeN4lOyqOUozntV7ECtZdav6M9rIDyv4XNwuOA/eWKoy+dIe9/fcSfi9SJJKCN0Qdx1DC3dK/HWhdi1JnM9IDD0wqgkUH9osZ\n";

// rTorrent moves a torrent into done/ only once it has finished, so done/ is
// all there is to pull. The *arrs' "remove from client" deletes only their
// mapped local copy and rTorrent leaves the data behind, so the seedbox only
// stays under quota if local deletions are mirrored back -- which Resilio's
// two-way sync did implicitly. The script keeps a manifest to tell those
// apart from new downloads; see seedbox-pull.sh.
export interface SeedboxPullProps {
  /** The Downloads export; everything lands under its `seedbox/` subPath. */
  readonly downloads: NFSConcreteVolume;
  /**
   * Directory under `seedbox/` to mirror into. The *arrs' remote path mapping
   * points at `sync`.
   */
  readonly destDir: string;
  /**
   * Actually mirror deletions, both ways: items gone from done/ are removed
   * locally, and items the *arrs removed locally are deleted on the seedbox.
   * Off, both only log what they would do -- for checking the mirror before
   * trusting it.
   */
  readonly prune: boolean;
}

export class SeedboxPull extends Chart {
  constructor(scope: Construct, id: string, props: SeedboxPullProps) {
    super(scope, id);
    const labels = { "app.kubernetes.io/name": name, ...mediaLabel };

    const secrets = new BitwardenSecret(this, "secrets", {
      name: `${name}-secrets`,
      namespace: namespace,
      data: {
        SEEDBOX_PASSWORD: "85fe2b80-865a-449f-99bc-b4da0172fb95",
      },
    });

    const config = new ConfigMap(this, "config", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      data: {
        "pull.sh": readFileSync(join(__dirname, "seedbox-pull.sh"), "utf-8"),
        known_hosts: SEEDBOX_KNOWN_HOSTS,
      },
    });

    const cj = new CronJob(this, "cronjob", {
      metadata: {
        name: name,
        namespace: namespace,
        labels: labels,
      },
      schedule: Cron.schedule({ minute: "*/5" }),
      concurrencyPolicy: ConcurrencyPolicy.FORBID,
      // The first pull runs for hours at 100Mbit. Without a deadline the
      // controller counts every slot missed meanwhile, and past 100 it stops
      // scheduling the job altogether.
      startingDeadline: Duration.minutes(5),
      backoffLimit: 0,
      restartPolicy: RestartPolicy.NEVER,
      successfulJobsRetained: 1,
      failedJobsRetained: 3,
      securityContext: NONROOT_SECURITY_CONTEXT_UID(Number(MEDIA_UID), Number(MEDIA_GID)),
      containers: [
        {
          name: name,
          image: SEEDBOX_PULL_IMAGE,
          imagePullPolicy: ImagePullPolicy.IF_NOT_PRESENT,
          command: ["/bin/sh", "/scripts/pull.sh"],
          envVariables: {
            ...secrets.toEnvValues(),
            HOME: EnvValue.fromValue("/tmp"),
            SEEDBOX_DONE_PATH: EnvValue.fromValue("files/done"),
            DEST_ROOT: EnvValue.fromValue("/seedbox"),
            DEST_DIR: EnvValue.fromValue(props.destDir),
            PRUNE: EnvValue.fromValue(String(props.prune)),
            RCLONE_SFTP_HOST: EnvValue.fromValue(SEEDBOX_HOST),
            RCLONE_SFTP_USER: EnvValue.fromValue(SEEDBOX_USER),
            RCLONE_SFTP_KNOWN_HOSTS_FILE: EnvValue.fromValue("/scripts/known_hosts"),
            RCLONE_SFTP_SHELL_TYPE: EnvValue.fromValue("none"),
            RCLONE_SFTP_DISABLE_HASHCHECK: EnvValue.fromValue("true"),
            RCLONE_TRANSFERS: EnvValue.fromValue("4"),
            RCLONE_MULTI_THREAD_STREAMS: EnvValue.fromValue("4"),
            RCLONE_STATS: EnvValue.fromValue("1m"),
            RCLONE_STATS_ONE_LINE: EnvValue.fromValue("true"),
            RCLONE_STATS_LOG_LEVEL: EnvValue.fromValue("NOTICE"),
          },
          resources: {
            cpu: {
              request: Cpu.millis(100),
            },
            memory: {
              request: Size.mebibytes(128),
              limit: Size.mebibytes(512),
            },
          },
          securityContext: NONROOT_SECURITY_CONTEXT_UID(Number(MEDIA_UID), Number(MEDIA_GID)),
        },
      ],
    });

    const configVol = Volume.fromConfigMap(this, "config-vol", config);
    cj.addVolume(configVol);
    cj.containers[0].mount("/scripts", configVol);

    const downloadsVol = Volume.fromPersistentVolumeClaim(
      this,
      "downloads-vol",
      props.downloads.pvc,
    );
    cj.addVolume(downloadsVol);
    cj.containers[0].mount("/seedbox", downloadsVol, { subPath: "seedbox" });
  }
}
