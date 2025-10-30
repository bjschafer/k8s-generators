import { Chart } from "cdk8s";
import { Construct } from "constructs";
import {
  VmPodScrape,
  VmPodScrapeSpecPodMetricsEndpointsTargetPort,
  VmRule,
  VmScrapeConfig,
  VmScrapeConfigSpecScheme,
  VmServiceScrape,
} from "../../imports/operator.victoriametrics.com";
import { namespace } from "./app";

export class ScrapeConfigs extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new VmServiceScrape(this, "node-exporter", {
      metadata: {
        name: "node-exporter",
        namespace: namespace,
      },
      spec: {
        jobLabel: "node-exporter",
        selector: {
          matchLabels: {
            "app.kubernetes.io/instance": "metrics",
            "app.kubernetes.io/name": "prometheus-node-exporter",
          },
        },
        endpoints: [
          {
            port: "metrics",
            metricRelabelConfigs: [
              {
                action: "drop",
                regex: "/var/lib/kubelet/pods.+",
                sourceLabels: ["mountpoint"],
              },
              {
                action: "labeldrop",
                regex: "(plan_upgrade_cattle_io.*)",
              },
              {
                action: "labeldrop",
                regex: "(beta_kubernetes_io.*)",
              },
            ],
            relabelConfigs: [
              {
                regex: "([^:]+)(:[0-9]+)?",
                replacement: "$1",
                sourceLabels: ["__meta_kubernetes_pod_node_name"],
                targetLabel: "instance",
              },
            ],
          },
        ],
      },
    });

    new VmScrapeConfig(this, "ceph", {
      metadata: {
        name: "ceph",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: ["vmhost03.cmdcentral.xyz:9283"],
            labels: {
              job: "ceph",
              cluster: "ceph",
            },
          },
        ],
      },
    });

    new VmScrapeConfig(this, "garage", {
      metadata: {
        name: "garage",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: ["garage-admin.cmdcentral.xyz:443"],
            labels: { job: "garage" },
          },
        ],
      },
    });

    new VmScrapeConfig(this, "hass", {
      metadata: {
        name: "hass",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: ["home-assistant.hass.svc.cluster.local:8123"],
            labels: { job: "hass" },
          },
        ],
        path: "/api/prometheus",
        scheme: VmScrapeConfigSpecScheme.HTTP,
        // bearer auth
        authorization: {
          credentials: {
            name: "hass-bearer-token",
            key: "token",
          },
        },
      },
    });

    new VmScrapeConfig(this, "infra", {
      metadata: {
        name: "infra",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "infra1.cmdcentral.xyz:9100",
              "infra2.cmdcentral.xyz:9100",
            ],
            labels: { job: "infra" },
          },
        ],
      },
    });

    // new VmScrapeConfig(this, "lakelair-gateway", {
    //   metadata: {
    //     name: "lakelair-gateway",
    //     namespace: namespace,
    //   },
    //   spec: {
    //     staticConfigs: [
    //       {
    //         labels: { job: "lakelair-gateway" },
    //         targets: ["gateway.lakelair.net:9100"],
    //       },
    //     ],
    //   },
    // });

    new VmScrapeConfig(this, "mgt", {
      metadata: {
        name: "mgt",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: ["mgt.cmdcentral.xyz:9100"],
            labels: { job: "mgt" },
          },
        ],
      },
    });

    ["cluster", "node"].forEach((kind: string) => {
      new VmScrapeConfig(this, `minio-${kind}`, {
        metadata: {
          name: `minio-${kind}`,
          namespace: namespace,
        },
        spec: {
          staticConfigs: [
            {
              labels: { job: `minio-${kind}` },
              targets: ["minio.cmdcentral.xyz:9000"],
            },
          ],
          path: `/minio/v2/metrics/${kind}`,
          authorization: {
            credentials: {
              name: "minio-bearer-token",
              key: "token",
            },
          },
        },
      });
    });

    new VmScrapeConfig(this, "nut", {
      metadata: {
        name: "nut",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            labels: { job: "nut" },
            targets: ["infra2.cmdcentral.xyz:3493"], // address of nut server
          },
        ],
        relabelConfigs: [
          {
            action: "replace",
            sourceLabels: ["__address__"],
            targetLabel: "__param_target",
          },
          {
            action: "replace",
            sourceLabels: ["__param_target"],
            targetLabel: "instance",
          },
          {
            action: "replace",
            replacement: "infra2.cmdcentral.xyz:9995", // address of nut exporter
            targetLabel: "__address__",
          },
        ],
      },
    });
    new VmRule(this, "nut-power-usage", {
      metadata: {
        name: "nut-power-usage",
        namespace: namespace,
        labels: {
          "alerts.cmdcentral.xyz/kind": "metrics",
        },
      },
      spec: {
        groups: [
          {
            name: "nut_power_usage_watts",
            rules: [
              {
                record: "ups:power_usage_watts:a_side",
                expr: 'nut_load{ups="a-side"} * nut_power_nominal_watts{ups="a-side"}',
              },
              {
                record: "ups:power_usage_watts:b_side",
                expr: 'nut_load{ups="b-side"} * nut_power_nominal_watts{ups="b-side"}',
              },
            ],
          },
        ],
      },
    });

    new VmScrapeConfig(this, "pdns", {
      metadata: {
        name: "pdns",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "infra1.cmdcentral.xyz:8081",
              "infra1.cmdcentral.xyz:8082",
              "infra2.cmdcentral.xyz:8081",
              "infra2.cmdcentral.xyz:8082",
            ],
            labels: { job: "pdns" },
          },
        ],
      },
    });

    new VmScrapeConfig(this, "printers", {
      metadata: {
        name: "printers",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "pandora.cmdcentral.xyz:9100",
              "trident.cmdcentral.xyz:9100",
            ],
            labels: { job: "printers" },
          },
        ],
      },
    });

    new VmScrapeConfig(this, "servers", {
      metadata: {
        name: "servers",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "jellyfin.cmdcentral.xyz:9100",
              "plex.cmdcentral.xyz:9100",
            ],
            labels: { job: "servers" },
          },
        ],
      },
    });

    new VmScrapeConfig(this, "vmhost", {
      metadata: {
        name: "vmhost",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "vmhost01.cmdcentral.xyz:9100",
              "vmhost02.cmdcentral.xyz:9100",
              "vmhost03.cmdcentral.xyz:9100",
            ],
            labels: { job: "vmhost" },
          },
        ],
      },
    });

    new VmScrapeConfig(this, "vmhost-caddy", {
      metadata: {
        name: "vmhost-caddy",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "vmhost01.cmdcentral.xyz:2025",
              "vmhost02.cmdcentral.xyz:2025",
              "vmhost03.cmdcentral.xyz:2025",
            ],
            labels: { job: "vmhost-caddy" },
          },
        ],
      },
    });

    // --- pods
    new VmPodScrape(this, "argocd-image-updater", {
      metadata: {
        name: "argocd-image-updater",
        namespace: namespace,
      },
      spec: {
        namespaceSelector: {
          matchNames: ["argocd"],
        },
        podMetricsEndpoints: [
          {
            targetPort:
              VmPodScrapeSpecPodMetricsEndpointsTargetPort.fromNumber(8081),
          },
        ],
        selector: {
          matchLabels: { "app.kubernetes.io/name": "argocd-image-updater" },
        },
      },
    });

    // --- services

    [
      { name: "argocd", serviceName: "metrics" },
      { name: "server", serviceName: "server-metrics" },
      { name: "repo-server", serviceName: "repo-server" },
      {
        name: "applicationset-controller",
        serviceName: "applicationset-controller",
      },
    ].forEach((obj: { name: string; serviceName: string }) => {
      const name =
        obj.name === "argocd"
          ? `${obj.name}-metrics`
          : `argocd-${obj.name}-metrics`;
      new VmServiceScrape(this, name, {
        metadata: {
          name: name,
          namespace: namespace,
        },
        spec: {
          namespaceSelector: {
            matchNames: ["argocd"],
          },
          endpoints: [{ port: "metrics" }],
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": `argocd-${obj.serviceName}`,
            },
          },
        },
      });
    });

    new VmServiceScrape(this, "unifi-exporter", {
      metadata: {
        name: "unifi-exporter",
        namespace: namespace,
      },
      spec: {
        namespaceSelector: { matchNames: ["prometheus"] },
        selector: { matchLabels: { app: "unifi-exporter" } },
        endpoints: [{ port: "metrics" }],
      },
    });

    // --- gitlab
    [
      { job_name: "gitlab-nginx", port: 8060 },
      { job_name: "gitlab-redis", port: 9121 },
      { job_name: "gitlab-postgres", port: 9187 },
      { job_name: "gitlab-node", port: 9100 },
      { job_name: "gitlab-registry", port: 5001 },
      { job_name: "gitlab-workhorse", port: 9229 },
      {
        job_name: "gitlab-rails",
        port: 443,
        metrics_path: "/-/metrics",
        scheme: "https",
      },
    ].forEach(
      (obj: {
        job_name: string;
        port: number;
        metrics_path?: string;
        scheme?: string;
      }) => {
        new VmScrapeConfig(this, `scrape-${obj.job_name}`, {
          metadata: {
            name: obj.job_name,
            namespace: namespace,
          },
          spec: {
            staticConfigs: [
              {
                targets: [`gitlab.cmdcentral.xyz:${obj.port}`],
                labels: { job: obj.job_name },
              },
            ],
            path: obj.metrics_path,
            scheme:
              obj.scheme === "https"
                ? VmScrapeConfigSpecScheme.HTTPS
                : VmScrapeConfigSpecScheme.HTTP,
          },
        });
      },
    );
  }
}
