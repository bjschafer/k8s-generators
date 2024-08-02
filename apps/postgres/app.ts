import { App, Chart } from "cdk8s";
import { basename } from "path";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { Construct } from "constructs";
import {
  Cluster,
  ClusterSpecBackupBarmanObjectStoreWalCompression,
} from "../../imports/postgresql.cnpg.io";
import { StorageClass } from "../../lib/volume";
import { IntOrString, KubeService, Quantity } from "../../imports/k8s";

const namespace = basename(__dirname);

const app = new App(DEFAULT_APP_PROPS(namespace));

NewArgoApp(namespace, {
  sync_policy: {
    automated: {
      prune: true,
      selfHeal: true,
    },
  },
  namespace: namespace,
  source: ArgoAppSource.GENERATORS,
  recurse: true,
});

class ProdPostgres extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Cluster(this, "cluster", {
      metadata: {
        namespace: namespace,
        name: "prod",
      },
      spec: {
        instances: 3,
        monitoring: {
          enablePodMonitor: true,
        },
        resources: {
          requests: {
            cpu: Quantity.fromString("500m"),
            memory: Quantity.fromString("1Gi"),
          },
          limits: {
            cpu: Quantity.fromString("500m"),
            memory: Quantity.fromString("1Gi"),
          },
        },
        storage: {
          size: "5Gi",
          storageClass: StorageClass.CEPH_RBD,
        },
        enableSuperuserAccess: true,
        postgresql: {
          pgHba: [
            "host pdns pdns 10.0.10.0/24 scram-sha-256",
            "hostssl pdns pdns 10.0.10.0/24 scram-sha-256",
          ],
        },

        backup: {
          barmanObjectStore: {
            endpointUrl: "https://ceph.cmdcentral.xyz",
            destinationPath: "s3://postgres/k8s/prod",
            s3Credentials: {
              accessKeyId: {
                name: "backups",
                key: "ACCESS_KEY_ID",
              },
              secretAccessKey: {
                name: "backups",
                key: "SECRET_ACCESS_KEY",
              },
            },
            wal: {
              compression:
                ClusterSpecBackupBarmanObjectStoreWalCompression.GZIP,
            },
          },
        },
      },
    });

    new KubeService(this, "lb", {
      metadata: {
        name: "prod",
        namespace: namespace,
        annotations: {
          "external-dns.alpha.kubernetes.io/hostname": "pg-prod.cmdcentral.xyz",
        },
      },
      spec: {
        type: "LoadBalancer",
        ports: [
          {
            name: "postgres",
            port: 5432,
            targetPort: IntOrString.fromNumber(5432),
            protocol: "TCP",
          },
        ],
        selector: {
          // TODO make this better
          "cnpg.io/cluster": "prod",
          role: "primary",
        },
      },
    });
  }
}

new ProdPostgres(app, "prod");

app.synth();
