import { Construct } from "constructs";
import { Alert, SEND_TO_TELEGRAM } from "../../lib/monitoring/alerts";
import { namespace } from "./app";
import heredoc from "tsheredoc";

export function addAlerts(scope: Construct, id: string): void {
  new Alert(scope, `${id}-argo`, {
    name: "argo",
    namespace: namespace,
    rules: [
      {
        alert: "ArgoAppNotSynced",
        expr: `count by (name) (argocd_app_info{sync_status!="Synced"}) > 0`,
        for: "15m",
        labels: {
          severity: "warning",
        },
        annotations: {
          summary:
            "Argo app {{ $labels.name }} not synced for at least 15 minutes",
        },
      },
      {
        alert: "ArgoImageUpdaterFailedUpdates",
        expr: `increase(argocd_image_updater_images_errors_total[5m]) > 0`,
        for: "15m",
        labels: {
          severity: "warning",
          ...SEND_TO_TELEGRAM,
        },
        annotations: {
          summary: "Argo app {{ $labels.application }} failing to autoupdate",
        },
      },
    ],
  });

  new Alert(scope, `${id}-ceph`, {
    name: "ceph",
    namespace: namespace,
    rules: [
      {
        alert: "CephState",
        expr: `ceph_health_state != 0`,
        for: "0m",
        labels: {
          severity: "critical",
          ...SEND_TO_TELEGRAM,
        },
        annotations: {
          summary: "Ceph unhealthy (instance {{ $labels.instance }})",
          description: heredoc`
            Ceph instance unhealthy
              VALUE = {{ $value }}
              LABELS = {{ $labels}}
            `,
        },
      },
      {
        alert: "CephOsdDown",
        expr: `ceph_osd_up == 0`,
        for: "0m",
        labels: {
          severity: "critical",
          ...SEND_TO_TELEGRAM,
        },
        annotations: {
          summary: "Ceph OSD Down (instance {{ $labels.instance }})",
          description: heredoc`
            Ceph Object Storage Daemon Down
              VALUE = {{ $value }}
              LABELS = {{ $labels}}
            `,
        },
      },
      {
        alert: "CephOsdLowSpace",
        expr: `1 - (sum by (job) ((ceph_cluster_total_bytes-ceph_cluster_total_used_bytes)/ceph_cluster_total_bytes)) > 0.9`,
        for: "30m",
        labels: {
          severity: "warning",
        },
        annotations: {
          summary: "Ceph OSD low space",
          description: heredoc`
            Ceph Object Storage Daemon is running out of space. Please add more disks.
              VALUE = {{ $value }}
              LABELS = {{ $labels}}
            `,
        },
      },
      {
        alert: "CephOsdFlagNoRebalanceSet",
        expr: `max(ceph_osd_flag_norebalance) by (instance) > 0`,
        for: "60m",
        labels: {
          severity: "critical",
          ...SEND_TO_TELEGRAM,
        },
        annotations: {
          summary: "Ceph OSD norebalance flag set for 60m",
          description: "Did you forget to unset it after a reboot?",
        },
      },
      {
        alert: "CephHighOsdLatency",
        expr: `ceph_osd_apply_latency_ms > 2000`,
        for: "1m",
        labels: {
          severity: "warning",
        },
        annotations: {
          summary: "Ceph high OSD latency (instance {{ $labels.instance }})",
          description: heredoc`
            Ceph OSD latency is high. Please check if it's stuck in a weird state
              VALUE = {{ $value }}
              LABELS = {{ $labels}}
            `,
        },
      },
    ],
  });
}
