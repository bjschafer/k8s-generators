import { ApiObject, App, Duration, JsonPatch, Size } from "cdk8s";
import { Cpu, Probe, Protocol, ServiceType } from "cdk8s-plus-33";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "ghcr.io/netbootxyz/netbootxyz";

NewArgoApp(namespace, {
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

const deploy = new AppPlus(app, name, {
  name: name,
  namespace: namespace,
  image: image,
  replicas: 1,
  resources: {
    cpu: {
      request: Cpu.millis(50),
    },
    memory: {
      request: Size.mebibytes(64),
    },
  },
  ports: [
    {
      name: "http",
      number: 3000,
    },
    {
      name: "tftp",
      number: 69,
      protocol: Protocol.UDP,
    },
  ],
  livenessProbe: Probe.fromCommand(["/healthcheck.sh"], {
    initialDelaySeconds: Duration.seconds(15),
    timeoutSeconds: Duration.seconds(5),
  }),
  readinessProbe: Probe.fromCommand(["/healthcheck.sh"], {
    initialDelaySeconds: Duration.seconds(15),
    timeoutSeconds: Duration.seconds(5),
  }),
  volumes: [
    {
      name: "config",
      mountPath: "/config",
      props: {
        storage: Size.gibibytes(1),
      },
      enableBackups: true,
    },
    {
      name: "assets",
      mountPath: "/assets",
      props: {
        storage: Size.gibibytes(1),
      },
      enableBackups: true,
    },
  ],
});

const svc = deploy.Deployment.exposeViaService({
  name: `${name}-tftp`,
  ports: [
    {
      port: 69,
      targetPort: 69,
      name: "tftp",
      protocol: Protocol.UDP,
    },
  ],
  serviceType: ServiceType.LOAD_BALANCER,
});
ApiObject.of(svc).addJsonPatch(
  JsonPatch.replace("/spec/externalTrafficPolicy", "Local"),
);

app.synth();
NewKustomize(app.outdir);
