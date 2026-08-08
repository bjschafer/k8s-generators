import { App, Chart, Cron, Duration, Size } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS, DEFAULT_SECURITY_CONTEXT, KUBERNETES_VERSION } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";
import {
  ApiResource,
  ConcurrencyPolicy,
  CronJob,
  EnvValue,
  ImagePullPolicy,
  PersistentVolumeAccessMode,
  Probe,
  RestartPolicy,
  Role,
  RoleBinding,
  ServiceAccount,
} from "cdk8s-plus-34";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "ghcr.io/arabcoders/watchstate";
const port = 8080;

NewArgoApp(name, {
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

new AppPlus(app, "watchstate", {
  name,
  namespace,
  image,
  resources: {
    memory: {
      request: Size.mebibytes(512),
      limit: Size.gibibytes(1.5),
    },
  },
  ports: [port],

  // Startup runs SQLite maintenance over a ~1GB DB on Ceph RBD before Caddy
  // binds :8080 — roughly 45s today and it grows with the DB. Without this the
  // default liveness probe (0s delay, 3x10s) kills the container mid-migration
  // every time, which reads as an OOM because the SIGTERM is ignored and the
  // grace period expires into a SIGKILL (exit 137).
  startupProbe: Probe.fromTcpSocket({
    port: port,
    periodSeconds: Duration.seconds(5),
    failureThreshold: 60,
  }),

  extraEnv: {
    WS_API_AUTO: EnvValue.fromValue("true"),

    // The import/export tasks default to '-v', which logs a notice line per
    // media item. That lands twice: in logs/task.<date>.jsonl (~30MB/day) and
    // in the events table's `logs` column (~320KB per import row, 851MB total).
    // "(empty)" is the app's own sentinel for an empty string -- see env() in
    // src/Libs/helpers.php. Warnings and errors are still recorded.
    WS_CRON_IMPORT_ARGS: EnvValue.fromValue("(empty)"),
    WS_CRON_EXPORT_ARGS: EnvValue.fromValue("(empty)"),
  },

  volumes: [
    {
      name: "config",
      mountPath: "/config",
      props: {
        storage: Size.gibibytes(5),
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
      },
    },
  ],
});

// WatchState's own scheduler cannot be relied on to prune. It loops on a bare
// `sleep(60)` (src/Commands/System/SchedulerCommand.php), so its tick drifts by
// however long the due tasks took -- while each pruner's cron is matched with
// CronExpression::isDue('now'), which is minute-exact. file_pruner and
// database_pruner are both '0 */12 * * *', so a tick has to land inside the
// 00:00 or 12:00 minute for them to run at all. Measured: the wrapper task
// fired ~18x/day against an expected 288, and the pruners had run about once
// in the preceding 50 days -- which is how 1.3GB of logs and an 857MB events
// table accumulated under a 7-day TTL.
//
// `--run -p <name>` skips the due check entirely (see runPruners() in
// PruneCommand.php), so driving the pruners from a real CronJob sidesteps the
// drift without patching upstream.
const pruneChart = new Chart(app, "watchstate-prune", { namespace: namespace });

const pruneSa = new ServiceAccount(pruneChart, "prune-sa", {
  metadata: { name: `${name}-pruner`, namespace: namespace },
});

const pruneRole = new Role(pruneChart, "prune-role", {
  metadata: {
    name: `${name}-pruner`,
    namespace: namespace,
    annotations: {
      "cmdcentral.xyz/why":
        "Lets the prune CronJob find the watchstate pod and exec the pruners inside it. The config PVC is RWO and held by the Deployment, so a standalone job cannot mount it.",
    },
  },
});
pruneRole.allowRead(ApiResource.PODS);
// `kubectl exec deploy/<name>` reads the Deployment to resolve its selector,
// then lists pods to pick one.
pruneRole.allowRead(ApiResource.DEPLOYMENTS);
// apiGroup must be the empty string -- pods/exec is in the core group, and
// omitting it synths `apiGroups: [null]`, which matches nothing.
pruneRole.allow(["create"], ApiResource.custom({ apiGroup: "", resourceType: "pods/exec" }));

new RoleBinding(pruneChart, "prune-binding", {
  metadata: { name: `${name}-pruner`, namespace: namespace },
  role: pruneRole,
}).addSubjects(pruneSa);

// Every pruner deletes by absolute age rather than by time-since-last-run, so
// running them more often than their declared cron is idempotent.
const pruners = [
  "file_pruner",
  "database_pruner",
  "backend_metadata",
  "command_sessions",
  "media_health_reports",
];

new CronJob(pruneChart, "prune-cronjob", {
  metadata: { name: `${name}-prune`, namespace: namespace },
  schedule: Cron.schedule({ minute: "0", hour: "*/6" }),
  concurrencyPolicy: ConcurrencyPolicy.FORBID,
  restartPolicy: RestartPolicy.ON_FAILURE,
  successfulJobsRetained: 1,
  failedJobsRetained: 3,
  serviceAccount: pruneSa,
  // The job's whole purpose is calling the API, so it needs its token. cdk8s
  // defaults this to false.
  automountServiceAccountToken: true,
  // Default is 10s, which silently skips the run if the CronJob controller is
  // busy at the top of the hour.
  startingDeadline: Duration.minutes(10),
  securityContext: DEFAULT_SECURITY_CONTEXT,
  containers: [
    {
      name: "prune",
      // Derived from the cluster's own k3s pin rather than hand-written, so it
      // cannot drift out of kubectl's one-minor support window with the
      // apiserver -- which it already had, sitting on v1.36.2 against a v1.36.3
      // cluster. This image ships kubectl as its entrypoint with no shell at
      // all, hence the single exec below -- the loop runs in the watchstate
      // container, which does have sh.
      image: `rancher/kubectl:${KUBERNETES_VERSION}`,
      imagePullPolicy: ImagePullPolicy.IF_NOT_PRESENT,
      securityContext: DEFAULT_SECURITY_CONTEXT,
      command: ["kubectl"],
      args: [
        "exec",
        "-n",
        namespace,
        `deploy/${name}`,
        "--",
        "sh",
        "-c",
        [
          "rc=0",
          // Each pruner is independent, so one failure should not skip the
          // rest -- collect the status and fail the job at the end instead.
          `for p in ${pruners.join(" ")}; do`,
          '  echo "==> $p"',
          '  console system:prune --run --execute -p "$p" -v || rc=1',
          "done",
          "exit $rc",
        ].join("\n"),
      ],
      resources: {
        memory: { request: Size.mebibytes(64), limit: Size.mebibytes(128) },
      },
    },
  ],
});

app.synth();
NewKustomize(app.outdir);
