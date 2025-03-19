import { App, Chart, Helm } from "cdk8s";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { Construct } from "constructs";
import { DiskPool } from "../../imports/openebs.io";

const namespace = "openebs";
const name = namespace;
const version = "4.2.0";
const app = new App(DEFAULT_APP_PROPS(namespace));

NewArgoApp(name, {
  namespace: namespace,
});

class OpenEBS extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Helm(this, "openebs", {
      chart: "openebs",
      repo: "https://openebs.github.io/openebs",
      version: version,
      releaseName: name,
      namespace: namespace,
      values: {
        engines: {
          local: {
            zfs: {
              enabled: false,
            },
          },
        },
        mayastor: {
          "loki-stack": {
            enabled: false,
          },
        },
        "openebs-crds": {
          csi: {
            volumeSnapshots: {
              enabled: false,
            },
          },
        },
      },
    });

    const nodeDisks = [
      {
        node: "k8s-work-01",
        disks: ["aio:///dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_drive-scsi2"],
      },
      {
        node: "k8s-work-02",
        disks: ["aio:///dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_drive-scsi2"],
      },
    ];

    nodeDisks.forEach((value) => {
      new DiskPool(this, `diskpool-${value.node}`, {
        metadata: {
          name: `diskpool-${value.node}`,
          namespace: namespace,
        },
        spec: {
          node: value.node,
          disks: value.disks,
        },
      });
    });
  }
}

new OpenEBS(app, "openebs");

app.synth();
