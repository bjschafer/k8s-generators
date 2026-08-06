import { App, Duration, Size } from "cdk8s";
import { Cpu, EnvValue, Probe, Volume } from "cdk8s-plus-34";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, MEDIA_GID, MEDIA_UID, TZ } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";
import { NFSVolumeContainer } from "../../lib/nfs";
import { GeneratedSecret } from "../../lib/secrets";
import { basename } from "../../lib/util";
import { StorageClass } from "../../lib/volume";
import { createAppDatabaseSecret } from "../postgres/database-provisioning";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const port = 3000;

// Not `bookorbit.cmdcentral.xyz`: the hostname describes what is being served,
// not which product is serving it, so replacing the app later doesn't strand
// the name. Also what APP_URL and the OIDC redirect are built from.
const host = "ebooks.cmdcentral.xyz";

const image = "ghcr.io/bookorbit/bookorbit";

NewArgoApp(name, {
  namespace: namespace,
  autoUpdate: {
    images: [
      {
        image: image,
        strategy: "semver",
        versionConstraint: "2.x",
      },
    ],
  },
});

// Database and role are declared in apps/postgres/databases.ts. Note that they
// live on the `immich` cluster rather than prod -- BookOrbit needs pgvector
// from its very first migration, and prod's image does not carry it. See the
// comment on the registry entry.
const dbCreds = createAppDatabaseSecret(app, name);

// None of these are ever read by a human or by anything outside the cluster;
// they only have to exist and stay put. The two *_ENCRYPTION_KEY values are
// AES-256 keys that the app insists on receiving as exactly 64 hex characters
// -- it silently declines to encrypt anything if they are any other shape --
// which is what `hex` is for.
const secrets = new GeneratedSecret(app, "secrets", {
  name: `${name}-secrets`,
  namespace: namespace,
  data: {
    JWT_SECRET: {},
    SETUP_BOOTSTRAP_TOKEN: {},
    EMAIL_ENCRYPTION_KEY: { hex: true },
    MIGRATION_ENCRYPTION_KEY: { hex: true },
  },
});

// The same export calibre serves out of, mounted read-write: BookOrbit's
// import, file-rename and book-dock features all write into the library, and
// without them there is nothing to evaluate it on. Unlike calibre's PV this
// one reaches the NAS over the storage VLAN, which is lib/nfs.ts's default and
// how the media namespace already mounts this export -- calibre is on
// 10.0.10.5 only because its PV predates that.
const nfsVols = new NFSVolumeContainer(app, "nfs-volume-container");
nfsVols.Add("bookorbit-nfs-books", {
  exportPath: "/warp/Media/Ebooks",
  storage: Size.tebibytes(1),
  claimName: "nfs-books",
});
const books = nfsVols.Get("bookorbit-nfs-books");

new AppPlus(app, name, {
  name: name,
  namespace: namespace,
  image: image,
  ports: [port],
  resources: {
    cpu: {
      request: Cpu.millis(100),
      limit: Cpu.units(2),
    },
    memory: {
      request: Size.mebibytes(512),
      // The entrypoint reads this ceiling out of the cgroup and sizes the V8
      // heap at 75% of it, so raising the limit is how you give the app more
      // heap -- NODE_MAX_OLD_SPACE_SIZE below is deliberately left on `auto`.
      limit: Size.gibibytes(2),
    },
  },
  extraEnv: {
    TZ: EnvValue.fromValue(TZ),
    NODE_ENV: EnvValue.fromValue("production"),
    PORT: EnvValue.fromValue(`${port}`),

    // The entrypoint assembles DATABASE_URL from these, percent-encoding each
    // component, so the generated password's symbols survive the trip.
    POSTGRES_HOST: EnvValue.fromValue("immich-rw.postgres.svc.cluster.local"),
    POSTGRES_PORT: EnvValue.fromValue("5432"),
    POSTGRES_DB: EnvValue.fromValue(name),
    POSTGRES_USER: EnvValue.fromValue(name),
    POSTGRES_PASSWORD: EnvValue.fromSecretValue({
      secret: dbCreds.secret,
      key: "password",
    }),

    APP_URL: EnvValue.fromValue(`https://${host}`),
    // Behind traefik, so the peer address is always the ingress controller.
    // Without this every client looks like the same IP to rate limiting and
    // the audit log.
    TRUST_PROXY: EnvValue.fromValue("true"),
    // login.cmdcentral.xyz is externally reachable, but split-horizon DNS
    // answers 10.0.10.80 in here, and the app's SSRF guard judges an issuer by
    // the address it resolves to rather than by the name. Without this, OIDC
    // discovery throws "URL resolves to a private or local address" and the
    // provider can't even be saved.
    OIDC_ALLOW_LOCAL_ISSUERS: EnvValue.fromValue("true"),
    // Roots the library-folder picker at the mount rather than at `/`, so
    // creating a library means browsing the books and not the container.
    LIBRARY_BROWSE_ROOT: EnvValue.fromValue("/books"),

    // The entrypoint starts as root to chown /data, then drops to these.
    // Same ids the rest of the media stack writes as, which is what keeps the
    // library readable by calibre while both are running.
    PUID: EnvValue.fromValue(MEDIA_UID),
    PGID: EnvValue.fromValue(MEDIA_GID),

    ...secrets.toEnvValues(),
  },
  volumes: [
    {
      // Covers, the book-bucket staging area, and anything else the app
      // considers its own. Not the library, which is the NFS mount below.
      name: "data",
      mountPath: "/data",
      props: {
        storage: Size.gibibytes(20),
        storageClassName: StorageClass.CEPH_RBD,
      },
    },
  ],
  extraVolumeMounts: [
    {
      volume: Volume.fromPersistentVolumeClaim(app, "books-vol", books.pvc),
      mountPath: "/books",
    },
  ],
  livenessProbe: Probe.fromHttpGet("/api/v1/health", { port: port }),
  readinessProbe: Probe.fromHttpGet("/api/v1/health", { port: port }),
  // Migrations run inline at boot, before anything is served. Five minutes of
  // headroom so a long one isn't mistaken for a hung container and restarted
  // partway through.
  startupProbe: Probe.fromHttpGet("/api/v1/health", {
    port: port,
    periodSeconds: Duration.seconds(10),
    failureThreshold: 30,
  }),
  ingressHosts: [{ host: host, port: port }],
});

app.synth();

NewKustomize(app.outdir);
