import { App, Chart } from "cdk8s";
import { NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS, HOMELAB_CRITICAL_PRIORITY_CLASS } from "../../lib/consts";
import { HelmApp } from "../../lib/helm";
import { Values } from "../../imports/helm-values/metallb-values.schema";
import { Construct } from "constructs";
import { infraResources } from "../../lib/util";
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
// renovate: datasource=helm depName=metallb registryUrl=https://metallb.github.io/metallb
const version = "0.16.1";

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
  version: version,
  releaseName: name,
  namespace: namespace,
  values: {
    controller: {
      image: {},
      serviceAccount: {},
      priorityClassName: HOMELAB_CRITICAL_PRIORITY_CLASS,
      resources: infraResources("10m", "160Mi", "384Mi"),
    },
    speaker: {
      frr: {
        enabled: false,
      },
      image: {},
      serviceAccount: {},
      tolerateMaster: true,
      priorityClassName: "system-node-critical",
      resources: infraResources("10m", "112Mi", "256Mi"),
    },
    "frr-k8s": {
      frrk8s: {
        priorityClassName: "system-node-critical",
        // Shared by the frr-k8s controller container and the statuscleaner
        // Deployment; the chart has no separate key for the latter.
        resources: infraResources("10m", "96Mi", "256Mi"),
        frr: { resources: infraResources("10m", "96Mi", "256Mi") },
        reloader: { resources: infraResources("5m", "64Mi", "128Mi") },
        frrMetrics: { resources: infraResources("5m", "64Mi", "128Mi") },
        frrStatus: { resources: infraResources("5m", "64Mi", "128Mi") },
      },
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
        // Unset, these defaulted to 0s, which FRR negotiates as "no keepalives,
        // never time out". A hard-rebooted worker sends no Cease, so the gateway
        // kept each old session ESTABLISHED forever and rejected the rebooted
        // speaker's reconnect as a Cease/Connection Collision -- leaving stale
        // routes to nodes that no longer had a Traefik endpoint (Local policy),
        // and all ingress timed out after the 2026-10-22 worker reboots until
        // `clear bgp` on the gateway. kube-vip's GoBGP peers, on normal timers,
        // recovered on their own from the same reboots. 90s/30s per RFC 4271.
        holdTime: "90s",
        keepaliveTime: "30s",
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
