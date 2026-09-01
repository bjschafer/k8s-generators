import { Chart, Cron, Duration, Size } from "cdk8s";
import {
  ConcurrencyPolicy,
  ConfigMap,
  Cpu,
  CronJob,
  EnvValue,
  ImagePullPolicy,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeMode,
  RestartPolicy,
  Secret,
  Volume,
} from "cdk8s-plus-34";
import { Construct } from "constructs";
import { readFileSync } from "fs";
import { join } from "path";
import { NONROOT_SECURITY_CONTEXT_UID } from "../../lib/consts";
import { StorageClass } from "../../lib/volume";

const name = "pg-dump";
const OUT_DIR = "/dumps";

// Same image the energy collector already pulls, so this adds no new thing to
// keep patched. Client major must match the servers: both clusters are 17, so
// a Renovate PR moving this to 18 is a signal to check the clusters first, not
// something to merge on green -- hence no automerge for it in renovate.json.
// renovate: datasource=docker depName=postgres
const PG_VERSION = "17-alpine";
const PG_IMAGE = `postgres:${PG_VERSION}`;

// The image ships `USER root` and we bypass the entrypoint that would normally
// drop privileges, so pin nobody explicitly rather than have ensureNonRoot
// reject the pod at admission. fsGroup is what makes the PVC writable for it.
const NOBODY = 65534;

// After the barman nightlies (01:00 and 01:30 UTC) so the two are not competing
// for the same primaries, and well before Velero's daily at 06:00 UTC, which is
// what actually carries these offsite.
const SCHEDULE = Cron.schedule({ minute: "0", hour: "3" });

export interface PgDumpProps {
  readonly namespace: string;
  /** CNPG cluster names. Each needs a `<name>-superuser` Secret and a `<name>-rw` Service. */
  readonly clusters: string[];
}

/**
 * Nightly logical dumps of every CNPG cluster onto a PVC, so the databases get
 * an offsite copy that is encrypted at rest.
 *
 * barman-cloud cannot do that on its own: its `encryption` field takes only
 * AES256 or aws:kms, both server-side, so whoever holds the bucket holds the
 * plaintext. Velero's Kopia repos are encrypted under a password that never
 * leaves Bitwarden, so putting the dumps on a PVC is what buys confidentiality.
 *
 * This does not replace barman. Barman is still the only thing here that can
 * do point-in-time recovery, and it is still the first thing to reach for; the
 * dumps are the copy that survives losing the site.
 */
export class PgDump extends Chart {
  constructor(scope: Construct, id: string, props: PgDumpProps) {
    super(scope, id);

    // Deliberately NOT labelled velero.io/exclude-from-backup, unlike the CNPG
    // data volumes around it -- being backed up is this volume's entire reason
    // to exist.
    const pvc = new PersistentVolumeClaim(this, "pvc", {
      metadata: {
        name: name,
        namespace: props.namespace,
      },
      accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      storageClassName: StorageClass.CEPH_RBD,
      // Only ever holds one dump per database; the clusters total ~3 GB live
      // and compress well past that, so this is mostly headroom.
      storage: Size.gibibytes(10),
      volumeMode: PersistentVolumeMode.FILE_SYSTEM,
    });
    const dumpVol = Volume.fromPersistentVolumeClaim(this, "pvc-vol", pvc);

    const scripts = new ConfigMap(this, "scripts", {
      metadata: { name: `${name}-scripts`, namespace: props.namespace },
      data: {
        "pg_dump.sh": readFileSync(join(__dirname, "pg_dump.sh"), "utf-8"),
      },
    });
    const scriptVol = Volume.fromConfigMap(this, "scripts-vol", scripts, {
      defaultMode: 0o555,
    });

    const cj = new CronJob(this, "cronjob", {
      metadata: { name: name, namespace: props.namespace },
      schedule: SCHEDULE,
      restartPolicy: RestartPolicy.ON_FAILURE,
      concurrencyPolicy: ConcurrencyPolicy.FORBID,
      successfulJobsRetained: 3,
      failedJobsRetained: 3,
      securityContext: {
        ensureNonRoot: true,
        user: NOBODY,
        group: NOBODY,
        fsGroup: NOBODY,
      },
      // A few GB of pg_dump over the cluster network. If it is still going
      // after an hour something is wedged, and it should be out of the way
      // well before Velero starts reading the volume at 06:00.
      activeDeadline: Duration.hours(1),
      containers: [
        {
          name: "dump",
          image: PG_IMAGE,
          imagePullPolicy: ImagePullPolicy.IF_NOT_PRESENT,
          securityContext: {
            ...NONROOT_SECURITY_CONTEXT_UID(NOBODY, NOBODY),
          },
          command: ["/bin/sh", "/scripts/pg_dump.sh"],
          envVariables: {
            CLUSTERS: EnvValue.fromValue(props.clusters.join(" ")),
            OUT_DIR: EnvValue.fromValue(OUT_DIR),
            NAMESPACE: EnvValue.fromValue(props.namespace),
          },
          resources: {
            cpu: { request: Cpu.millis(100), limit: Cpu.millis(1000) },
            memory: { request: Size.mebibytes(256), limit: Size.mebibytes(512) },
          },
        },
      ],
    });

    const container = cj.containers[0];
    container.mount("/scripts", scriptVol);
    container.mount(OUT_DIR, dumpVol);

    // One mount per cluster rather than env vars: a single container dumps
    // several clusters and each has its own superuser, so the script picks the
    // right credentials by path.
    for (const cluster of props.clusters) {
      const secret = Secret.fromSecretName(this, `${cluster}-superuser`, `${cluster}-superuser`);
      container.mount(
        `/creds/${cluster}`,
        Volume.fromSecret(this, `${cluster}-superuser-vol`, secret),
        { readOnly: true },
      );
    }
  }
}
