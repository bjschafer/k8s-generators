import { App, Chart } from "cdk8s";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { Values } from "../../imports/helm-values/metallb-values.schema";
import { Construct } from "constructs";
import {
  BgpAdvertisement,
  BgpPeer,
  IpAddressPool,
  L2Advertisement,
} from "../../imports/metallb.io";
import { VmPodScrape } from "../../imports/operator.victoriametrics.com";

const namespace = "metallb-system";
const name = "metallb";
const app = new App(DEFAULT_APP_PROPS(name));
const version = "0.14.9";

NewArgoApp(name, {
  namespace: namespace,
  ignoreDifferences: [
    {
      group: "apiextensions.k8s.io",
      kind: "CustomResourceDefinition",
      jsonPointers: ["/spec/conversion/webhook/clientConfig/caBundle"],
    },
  ],
});

new HelmApp<Values>(app, "helm", {
  chart: "metallb",
  repo: "https://metallb.github.io/metallb",
  targetRevision: version,
  releaseName: name,
  namespace: namespace,
  values: {
    controller: {
      image: {},
      serviceAccount: {},
    },
    speaker: {
      frr: {
        enabled: false,
      },
      image: {},
      serviceAccount: {},
      tolerateMaster: true,
    },
  },
});

class MetalLBConfig extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new BgpPeer(this, "bgp-peer", {
      metadata: {
        name: "gateway",
        namespace: namespace,
      },
      spec: {
        myAsn: 64512,
        peerAsn: 64512,
        peerAddress: "10.0.10.1",
      },
    });

    new BgpAdvertisement(this, "bgp-advert", {
      metadata: {
        name: "default",
        namespace: namespace,
      },
    });

    // this is necessary to ensure hosts in the same subnet can find services
    new L2Advertisement(this, "l2-advert", {
      metadata: {
        name: "default-l2",
        namespace: namespace,
      },
    });

    new IpAddressPool(this, "pool", {
      metadata: {
        name: "default-pool",
        namespace: namespace,
      },
      spec: {
        addresses: ["10.0.10.80-10.0.10.99"],
      },
    });

    new VmPodScrape(this, "controller-scrape", {
      metadata: {
        name: "controller-monitor",
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            "app.kubernetes.io/component": "controller",
          },
        },
        podMetricsEndpoints: [
          {
            port: "monitoring",
            path: "/metrics",
          },
        ],
      },
    });

    new VmPodScrape(this, "speaker-scrape", {
      metadata: {
        name: "speaker-monitor",
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            "app.kubernetes.io/component": "speaker",
          },
        },
        podMetricsEndpoints: [
          {
            port: "monitoring",
            path: "/metrics",
          },
        ],
      },
    });
  }
}

new MetalLBConfig(app, "config");

app.synth();
