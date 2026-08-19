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

    new VmServiceScrape(this, "cert-manager", {
      metadata: {
        name: "cert-manager",
        namespace: namespace,
      },
      spec: {
        namespaceSelector: {
          matchNames: ["cert-manager"],
        },
        endpoints: [{ port: "tcp-prometheus-servicemonitor" }],
        selector: {
          matchLabels: {
            "app.kubernetes.io/component": "controller",
            "app.kubernetes.io/instance": "cert-manager",
            "app.kubernetes.io/name": "cert-manager",
          },
        },
      },
    });

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

    new VmServiceScrape(this, "statsd-exporter", {
      metadata: {
        name: "statsd-exporter",
        namespace: namespace,
      },
      spec: {
        namespaceSelector: {
          matchNames: ["metrics-exporters"],
        },
        endpoints: [{ port: "metrics" }],
        selector: {
          matchLabels: {
            "app.kubernetes.io/name": "statsd-exporter",
          },
        },
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
            // Only the *active* ceph-mgr serves metrics; standbys answer 200 with an
            // empty body. Target all three mons so the scrape follows mgr failover
            // instead of silently going empty (which is what happened on 2026-07-09,
            // when the active mgr moved off vmhost03 and every ceph_* series stopped).
            targets: [
              "vmhost01.cmdcentral.xyz:9283",
              "vmhost02.cmdcentral.xyz:9283",
              "vmhost03.cmdcentral.xyz:9283",
            ],
            // Standbys scrape clean (200, no samples), so they never trip a down-target
            // rule -- and they keep distinct instance labels, so there are no duplicate
            // `up` series. Cost is a one-window gap in rate() when the active mgr moves;
            // the dashboards all sum() across instance, so they ride through it.
            labels: {
              job: "ceph",
              cluster: "ceph",
            },
          },
        ],
      },
    });

    // k3s serves embedded-etcd metrics on :2381 over plain HTTP with no auth, which
    // is why it binds to 127.0.0.1 unless `etcd-expose-metrics: true` is set in
    // /etc/rancher/k3s/config.yaml on each server -- that flag is a prerequisite for
    // this scrape and is NOT managed from this repo.
    //
    // Without this, etcd_disk_wal_fsync_duration_seconds does not exist anywhere, and
    // that is the single metric that predicts the failure mode in
    // ETCDHighFsyncDurations below: Velero backup reads saturate the all-HDD Ceph pool
    // that the control-plane VM disks live on, WAL fsync blows past 1s, controllers
    // lose their leases, and k3s exits. On 2026-08-16 that killed all three servers
    // within 90s and destroyed the weekly backup. We were blind to it at the time.
    new VmScrapeConfig(this, "etcd", {
      metadata: {
        name: "etcd",
        namespace: namespace,
      },
      spec: {
        staticConfigs: [
          {
            targets: [
              "k8s-01.cmdcentral.xyz:2381",
              "k8s-02.cmdcentral.xyz:2381",
              "k8s-03.cmdcentral.xyz:2381",
            ],
            labels: { job: "etcd" },
          },
        ],
        scheme: VmScrapeConfigSpecScheme.HTTP,
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
            targets: ["infra1.cmdcentral.xyz:9100", "infra2.cmdcentral.xyz:9100"],
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
            targets: ["pandora.cmdcentral.xyz:9100"],
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
            targets: ["jellyfin.cmdcentral.xyz:9100", "plex.cmdcentral.xyz:9100"],
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
            targetPort: VmPodScrapeSpecPodMetricsEndpointsTargetPort.fromNumber(8080),
          },
        ],
        selector: {
          matchLabels: { "app.kubernetes.io/name": "argocd-image-updater" },
        },
      },
    });

    // --- services

    // ArgoCD moved from hand-applied upstream manifests to the argo-cd Helm
    // chart (apps/argocd), which names things differently: every metrics port
    // became `http-metrics` rather than `metrics`, and the chart reuses the
    // label `app.kubernetes.io/name: argocd-metrics` across the application-,
    // applicationset- and notifications-controller Services -- so that label
    // can no longer identify one component. Select on `component` instead,
    // which is unique per Service and stable across chart versions.
    //
    // Getting this wrong fails silently: the scrape simply matches nothing, and
    // the only symptom is the ArgoCDAppNotSynced alert below quietly going blind
    // and resources/Dashboard/K8S/argocd.json rendering empty.
    [
      "application-controller",
      "server",
      "repo-server",
      "applicationset-controller",
      "notifications-controller",
      // dex-server is new here. It is the component whose silent death (dex
      // exits, its wrapper does not) caused repeated ArgoCD login outages, so
      // it is the one that most needs a scrapeable up{} series.
      "dex-server",
    ].forEach((component: string) => {
      const name = `argocd-${component}-metrics`;
      new VmServiceScrape(this, name, {
        metadata: {
          name: name,
          namespace: namespace,
        },
        spec: {
          namespaceSelector: {
            matchNames: ["argocd"],
          },
          endpoints: [{ port: "http-metrics" }],
          selector: {
            matchLabels: {
              "app.kubernetes.io/part-of": "argocd",
              "app.kubernetes.io/component": component,
            },
          },
        },
      });
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
    ].forEach((obj: { job_name: string; port: number; metrics_path?: string; scheme?: string }) => {
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
            obj.scheme === "https" ? VmScrapeConfigSpecScheme.HTTPS : VmScrapeConfigSpecScheme.HTTP,
        },
      });
    });
  }
}
