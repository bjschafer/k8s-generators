import { App, Duration, Size } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { AppPlus } from "../../lib/app-plus";
import { NewKustomize } from "../../lib/kustomize";
import { EnvValue, PersistentVolumeAccessMode, Probe } from "cdk8s-plus-34";

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

app.synth();
NewKustomize(app.outdir);
