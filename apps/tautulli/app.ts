import { App, Size } from "cdk8s";
import { Cpu, PersistentVolumeAccessMode } from "cdk8s-plus-33";
import { basename } from "path";
import { AppPlus } from "../../lib/app-plus";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, LSIO_ENVVALUE } from "../../lib/consts";
import { NewKustomize } from "../../lib/kustomize";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const image = "ghcr.io/tautulli/tautulli"
const port = 8181;

NewArgoApp(name, {
    namespace: namespace,
    autoUpdate: {
        images: [{
            image: image,
            strategy: "digest"
        }]
    }
})

new AppPlus(app, "tautulli", {
    name: name,
    namespace: namespace,
    image: image,
    resources: {
        memory: {
            request: Size.mebibytes(256),
            limit: Size.mebibytes(512)
        },
        cpu: {
            request: Cpu.millis(100),
            limit: Cpu.millis(800)
        }
    },
    ports: [port],
    extraIngressHosts: ["plex-dash.cmdcentral.xyz"],
    extraEnv: {
        LSIO_ENVVALUE,
    },
    volumes: [
        {
            name: "config",
            mountPath: "/config",
            enableBackups: true,
            props: {
                storage: Size.gibibytes(5),
                accessModes: [PersistentVolumeAccessMode.READ_WRITE_ONCE],
            },
        },
    ]
})

app.synth();
NewKustomize(app.outdir);