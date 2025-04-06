import { Chart, Size } from "cdk8s";
import { Construct } from "constructs";
import { IntOrString } from "../../imports/k8s";
import { mediaLabel, namespace } from "./app";
import {
  Cpu,
  Deployment,
  DeploymentStrategy,
  Env,
  EnvValue,
  PersistentVolumeAccessMode,
  PersistentVolumeClaim,
  PersistentVolumeMode,
  Probe,
  Protocol,
  Secret,
  Volume,
} from "cdk8s-plus-32";
import {
  BACKUP_ANNOTATION_NAME,
  DEFAULT_SECURITY_CONTEXT,
  LSIO_ENVVALUE,
} from "../../lib/consts";
import { StorageClass } from "../../lib/volume";
import {
  IngressRoute,
  IngressRouteSpecRoutesKind,
  IngressRouteSpecRoutesServicesKind,
} from "../../imports/traefik.io";
import { VmPodScrape } from "../../imports/operator.victoriametrics.com";

const name = "navidrome";
const port = 4533;

export class Navidrome extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const labels = { "app.kubernetes.io/name": "navidrome", ...mediaLabel };

    const deploy = new Deployment(this, "navidrome-deploy", {
      metadata: {
        name: name,
        namespace: namespace,
        labels: {
          ...labels,
        },
      },
      replicas: 1,
      strategy: DeploymentStrategy.recreate(),
      podMetadata: {
        labels: {
          ...labels,
        },
        annotations: {
          [BACKUP_ANNOTATION_NAME]: "config",
        },
      },
      securityContext: DEFAULT_SECURITY_CONTEXT,
      containers: [
        {
          name: name,
          securityContext: DEFAULT_SECURITY_CONTEXT,
          image: "ghcr.io/navidrome/navidrome:latest",
          ports: [
            {
              name: "http",
              number: port,
              protocol: Protocol.TCP,
            },
          ],
          resources: {
            cpu: {
              request: Cpu.millis(200),
              limit: Cpu.millis(1000),
            },
            memory: {
              request: Size.mebibytes(256),
              limit: Size.mebibytes(256),
            },
          },
          envVariables: {
            ND_PROMETHEUS_ENABLED: EnvValue.fromValue("true"),
            ND_REVERSEPROXYWHITELIST: EnvValue.fromValue(
              "10.0.0.0/8,127.0.0.0/8",
            ),
            ND_REVERSEPROXYUSERHEADER: EnvValue.fromValue(
              "X-authentik-username",
            ),
            ND_ENABLEUSEREDITING: EnvValue.fromValue("false"),
            ...LSIO_ENVVALUE,
          },
          envFrom: [
            Env.fromSecret(
              Secret.fromSecretName(this, `${name}-lastfm`, "navidrome-lastfm"),
            ),
          ],
          readiness: Probe.fromHttpGet("/ping", {
            port: 4533,
          }),
          liveness: Probe.fromHttpGet("/ping", {
            port: 4533,
          }),
        },
      ],
    });

    const pvc = Volume.fromPersistentVolumeClaim(
      this,
      "navidrome-config-vol",
      new PersistentVolumeClaim(this, "navidrome-config", {
        metadata: {
          name: name,
          namespace: namespace,
          labels: labels,
        },
        accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
        storage: Size.gibibytes(5),
        storageClassName: StorageClass.CEPH_RBD,
        volumeMode: PersistentVolumeMode.FILE_SYSTEM,
      }),
    );

    const nfs = Volume.fromPersistentVolumeClaim(
      this,
      "navidrome-nfs-vol",
      PersistentVolumeClaim.fromClaimName(
        this,
        "nfs-media-music",
        "nfs-media-music",
      ),
    );

    deploy.addVolume(pvc);
    deploy.addVolume(nfs);
    deploy.containers[0].mount("/data", pvc);
    deploy.containers[0].mount("/music", nfs);

    deploy.exposeViaService({
      name: name,
      ports: [
        {
          port: port,
          targetPort: port,
          name: "http",
        },
      ],
    });

    new IngressRoute(this, `${name}-ingressroute`, {
      metadata: {
        name,
        namespace: namespace,
        labels: labels,
        annotations: {
          "external-dns.alpha.kubernetes.io/target": "10.0.10.80", // ew
        },
      },
      spec: {
        routes: [
          {
            kind: IngressRouteSpecRoutesKind.RULE,
            match:
              "Host(`music.cmdcentral.xyz`) || Host(`navidrome.cmdcentral.xyz`)",
            priority: 10,
            middlewares: [
              {
                name: "authentik",
                namespace: "authentik",
              },
            ],
            services: [
              {
                name: name,
                kind: IngressRouteSpecRoutesServicesKind.SERVICE,
                port: IntOrString.fromNumber(port),
              },
            ],
          },
          {
            kind: IngressRouteSpecRoutesKind.RULE,
            match:
              "(Host(`music.cmdcentral.xyz`) || Host(`navidrome.cmdcentral.xyz`)) && PathPrefix(`/outpost.goauthentik.io/`)",
            priority: 15,
            services: [
              {
                kind: IngressRouteSpecRoutesServicesKind.SERVICE,
                name: "ak-outpost-authentik-embedded-outpost",
                namespace: "authentik",
                port: IntOrString.fromNumber(9000),
              },
            ],
          },
          {
            kind: IngressRouteSpecRoutesKind.RULE,
            match:
              "(Host(`music.cmdcentral.xyz`) || Host(`navidrome.cmdcentral.xyz`)) && PathPrefix(`/rest/`) && !Query(`c`, `NavidromeUI`)",
            priority: 15,
            services: [
              {
                kind: IngressRouteSpecRoutesServicesKind.SERVICE,
                name: "ak-outpost-authentik-embedded-outpost",
                namespace: "authentik",
                port: IntOrString.fromNumber(9000),
              },
            ],
          },
        ],
        tls: {
          secretName: "media-tls",
        },
      },
    });

    new VmPodScrape(this, `${name}-scrape`, {
      metadata: {
        name: name,
        namespace: namespace,
        labels: {
          ...labels,
        },
      },
      spec: {
        selector: {
          matchLabels: labels,
        },
        podMetricsEndpoints: [
          {
            port: "http",
          },
        ],
      },
    });
  }
}
