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
import { Construct } from "constructs";
import { readFileSync } from "fs";
import { join } from "path";
import { NONROOT_SECURITY_CONTEXT_UID } from "../../lib/consts";
import { BitwardenSecret } from "../../lib/secrets";
import { createAppDatabaseSecret } from "../postgres/database-provisioning";
import { namespace } from "./app";

const name = "alliant-collector";

// Bitwarden Secrets Manager items for the MyAccount login. One item per value --
// a BitwardenSecret key maps to a whole item, not to a field within one. The
// username lives here rather than inline because this repo is public.
const ALLIANT_USERNAME_BW_ID = "8f6137bf-487c-4182-83f8-b4a2000564c9";
const ALLIANT_PASSWORD_BW_ID = "8d0593c0-a09b-474d-acd3-b4a200058cbd";

// Alliant publishes usage ~4 days in arrears, so there is nothing to gain from
// running often. Once a day, off-peak, is plenty.
const SCHEDULE = Cron.schedule({ minute: "17", hour: "5" });

// Stock upstream images, deliberately: this repo builds none of its own, and a
// bespoke image would be a third thing to keep patched for the sake of gluing
// two programs together. The fetcher needs only the Python stdlib and the
// loader needs only psql, so the work splits cleanly across an initContainer
// and the main container sharing an emptyDir.
const FETCH_IMAGE = "python:3.13-alpine";
const PSQL_IMAGE = "postgres:17-alpine";

// Both images ship `USER root` -- the postgres entrypoint normally drops
// privileges itself, and we bypass it by invoking psql directly. Neither
// process needs root (verified: psql connects and python writes the CSVs as
// 65534), so pin nobody explicitly rather than letting ensureNonRoot reject the
// pod at admission.
const NOBODY = 65534;
const SECURITY_CONTEXT = NONROOT_SECURITY_CONTEXT_UID(NOBODY, NOBODY);

export class AlliantCollector extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const dbCreds = createAppDatabaseSecret(this, "energy");

    const alliantCreds = new BitwardenSecret(this, "alliant-credentials", {
      name: "alliant-credentials",
      namespace: namespace,
      data: {
        ALLIANT_USERNAME: ALLIANT_USERNAME_BW_ID,
        ALLIANT_PASSWORD: ALLIANT_PASSWORD_BW_ID,
      },
    });

    const scripts = new ConfigMap(this, "scripts", {
      metadata: { name: `${name}-scripts`, namespace: namespace },
      data: {
        "alliant_fetch.py": readFileSync(join(__dirname, "alliant_fetch.py"), "utf-8"),
        "load.sql": readFileSync(join(__dirname, "load.sql"), "utf-8"),
      },
    });
    const scriptVol = Volume.fromConfigMap(this, "scripts-vol", scripts);
    // CSV handoff between the two containers. The full history is ~1 MB, so this
    // comfortably fits in a memory-backed scratch volume.
    const dataVol = Volume.fromEmptyDir(this, "data-vol", "data", {
      sizeLimit: Size.mebibytes(64),
    });

    const cj = new CronJob(this, "cronjob", {
      metadata: { name: name, namespace: namespace },
      schedule: SCHEDULE,
      restartPolicy: RestartPolicy.ON_FAILURE,
      concurrencyPolicy: ConcurrencyPolicy.FORBID,
      successfulJobsRetained: 3,
      failedJobsRetained: 3,
      securityContext: {
        ensureNonRoot: true,
        user: NOBODY,
        group: NOBODY,
        // The two containers hand CSVs over via an emptyDir; fsGroup is what
        // makes that directory writable for a non-root uid.
        fsGroup: NOBODY,
      },
      // A run is a couple of HTTP calls and a COPY; if it is still going after
      // 15 minutes something is wedged and the next schedule should get a turn.
      activeDeadline: Duration.minutes(15),
      containers: [
        {
          name: "load",
          image: PSQL_IMAGE,
          imagePullPolicy: ImagePullPolicy.IF_NOT_PRESENT,
          securityContext: SECURITY_CONTEXT,
          command: [
            "psql",
            // Fail the pod on the first SQL error rather than plowing ahead and
            // reporting success, and keep the whole load atomic.
            "--single-transaction",
            "-v",
            "ON_ERROR_STOP=1",
            "-f",
            "/scripts/load.sql",
          ],
          envVariables: {
            PGHOST: EnvValue.fromValue("prod.postgres.svc.cluster.local"),
            PGPORT: EnvValue.fromValue("5432"),
            PGDATABASE: EnvValue.fromValue("energy"),
            PGUSER: EnvValue.fromValue("energy"),
            PGPASSWORD: EnvValue.fromSecretValue({ secret: dbCreds.secret, key: "password" }),
          },
          resources: {
            cpu: { request: Cpu.millis(50) },
            memory: { request: Size.mebibytes(128), limit: Size.mebibytes(256) },
          },
        },
      ],
      initContainers: [
        {
          name: "fetch",
          image: FETCH_IMAGE,
          imagePullPolicy: ImagePullPolicy.IF_NOT_PRESENT,
          securityContext: SECURITY_CONTEXT,
          command: ["python3", "/scripts/alliant_fetch.py"],
          envVariables: {
            ...alliantCreds.toEnvValues(),
            OUT_DIR: EnvValue.fromValue("/data"),
          },
          resources: {
            cpu: { request: Cpu.millis(100) },
            memory: { request: Size.mebibytes(128), limit: Size.mebibytes(256) },
          },
        },
      ],
    });

    for (const c of [...cj.containers, ...cj.initContainers]) {
      c.mount("/scripts", scriptVol);
      c.mount("/data", dataVol);
    }
  }
}
