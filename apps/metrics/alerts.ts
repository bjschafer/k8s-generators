import { Construct } from "constructs";
import heredoc from "tsheredoc";
import { Alert, PRIORITY, SEND_TO_PUSHOVER } from "../../lib/monitoring/alerts";
import { namespace } from "./app";

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
          priority: PRIORITY.NORMAL,
          namespace: "metrics", // Override pod namespace for alertmanager routing
          ...SEND_TO_PUSHOVER,
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
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
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
          ...SEND_TO_PUSHOVER,
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
          ...SEND_TO_PUSHOVER,
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

  new Alert(scope, `${id}-database`, {
    name: "database",
    namespace: namespace,
    rules: [
      {
        alert: "CNPGVolumeAlmostFull",
        expr: `max(max by(persistentvolumeclaim) (1 - kubelet_volume_stats_available_bytes{namespace="postgres"} / kubelet_volume_stats_capacity_bytes{namespace="postgres"})) > 0.85`,
        for: "15m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary:
            "CNPG volume {{ $labels.persistentvolumeclaim }} is > 85% full",
        },
      },
      {
        alert: "CNPGMaxConnectionsReached",
        expr: `100 * sum by (pod) (cnpg_backends_total{namespace=~"postgres"}) / sum by (pod) (cnpg_pg_settings_setting{name="max_connections", namespace=~"postgres"}) > 90`,
        for: "5m",
        labels: {
          priority: PRIORITY.NORMAL,
          namespace: "metrics", // Override pod namespace for alertmanager routing
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "CNPG pod {{ $labels.pod }}'s connections are > 90% used",
        },
      },
    ],
  });

  new Alert(scope, `${id}-host`, {
    name: "host",
    namespace: namespace,
    rules: [
      {
        alert: "HostOutOfMemory",
        expr: heredoc`
          (
              node_memory_MemAvailable_bytes
              +
              node_zfs_arc_size
          )
          /
          node_memory_MemTotal_bytes * 100 < 10
          `,
        for: "2m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Host {{ $labels.instance }} out of memory",
          description: heredoc`
            Node memory is filling up (< 10% left)
            VALUE = {{ $value }}
            LABELS = {{ $labels }}
            `,
        },
      },
      {
        alert: "HostMemoryUnderMemoryPressure",
        expr: "rate(node_vmstat_pgmajfault[1m]) > 1000",
        for: "2m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary:
            "Host memory under memory pressure (instance {{ $labels.instance }})",
          description:
            '"The node is under heavy memory pressure. High rate of major page faults\\n VALUE = {{ $value }}\\n LABELS = {{ $labels }}"',
        },
      },
      {
        alert: "HostOutOfDiskSpace",
        expr: '(node_filesystem_avail_bytes{mountpoint!="/boot/firmware"} * 100) / node_filesystem_size_bytes < 10 and ON (instance, device, mountpoint) node_filesystem_readonly == 0',
        for: "2m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "Host {{ $labels.instance }} out of disk space",
          description:
            "Disk is almost full (< 10% left)\n\nVALUE = {{ $value }}\n\nLABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostOutOfInodes",
        expr: "node_filesystem_files_free{} / node_filesystem_files{} * 100 < 10 and ON (instance, device, mountpoint) node_filesystem_readonly{} == 0",
        for: "2m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "Host {{ $labels.instance }} out of inodes",
          description:
            "Disk is almost running out of available inodes (< 10% left)\n\nVALUE = {{ $value }}\n\nLABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostInodesWillFillIn24Hours",
        expr: "node_filesystem_files_free{} / node_filesystem_files{} * 100 < 10 and predict_linear(node_filesystem_files_free{}[1h], 24 * 3600) < 0 and ON (instance, device, mountpoint) node_filesystem_readonly{} == 0",
        for: "2m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary:
            "Host inodes will fill in 24 hours (instance {{ $labels.instance }})",
          description:
            "Filesystem is predicted to run out of inodes within the next 24 hours at current write rate\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostDiskWillFillIn24Hours",
        expr: '(node_filesystem_avail_bytes * 100) / node_filesystem_size_bytes < 10 and ON (instance, device, mountpoint) predict_linear(node_filesystem_avail_bytes{\n    fstype!="tmpfs"}[1h], 24 * 3600) < 0\nand ON (instance, device, mountpoint) node_filesystem_readonly == 0',
        for: "2m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary:
            "Host disk will fill in 24 hours (instance {{ $labels.instance }})",
          description:
            '"Filesystem is predicted to run out of space within the next 24 hours at current write rate\\n VALUE = {{ $value }}\\n LABELS = {{ $labels }}"',
        },
      },
      {
        alert: "HostUnusualDiskReadLatency",
        expr: "rate(node_disk_read_time_seconds_total[1m]) / rate(node_disk_reads_completed_total[1m]) > 0.1 and rate(node_disk_reads_completed_total[1m]) > 0",
        for: "20m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary:
            "Host unusual disk read latency (instance {{ $labels.instance }})",
          description:
            '"Disk latency is growing (read operations > 100ms)\\n VALUE = {{ $value }}\\n LABELS = {{ $labels }}"',
        },
      },
      {
        alert: "HostUnusualDiskWriteLatency",
        expr: "rate(node_disk_write_time_seconds_total[1m]) / rate(node_disk_writes_completed_total[1m]) > 0.1 and rate(node_disk_writes_completed_total[1m]) > 0",
        for: "20m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary:
            "Host unusual disk write latency (instance {{ $labels.instance }})",
          description:
            '"Disk latency is growing (write operations > 100ms)\\n VALUE = {{ $value }}\\n LABELS = {{ $labels }}"',
        },
      },
      {
        alert: "HostHighIOPS",
        expr: 'sum by (instance) (irate(node_disk_writes_completed_total{device=~"[a-z]+|nvme[0-9]+n[0-9]+"}[5m])) + sum by (instance) (irate(node_disk_reads_completed_total{device=~"[a-z]+|nvme[0-9]+n[0-9]+"}[5m])) > 5000',
        for: "15m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: '"Host {{ $labels.instance }} high total IOPS (>5000)',
          description:
            '"Host has more than 5k combined IOPS\\n VALUE = {{ $value }}\\n LABELS = {{ $labels }}"',
        },
      },
      {
        alert: "HostHighCpuLoad",
        expr: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[2m])) * 100) > 80',
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "Host high CPU load (instance {{ $labels.instance }})",
          description:
            "CPU load is > 80%\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostCpuStealNoisyNeighbor",
        expr: 'avg by(instance) (rate(node_cpu_seconds_total{mode="steal"}[5m])) * 100 > 10',
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary:
            "Host CPU steal noisy neighbor (instance {{ $labels.instance }})",
          description:
            "CPU steal is > 10%. A noisy neighbor is killing VM performances or a spot instance may be out of credit.\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostContextSwitching",
        expr: '(rate(node_context_switches_total{job!="node-exporter",job!="vmhost"}[5m])) / (\n    count by(instance, job)\n    (node_cpu_seconds_total{mode="idle"})\n) > 1200',
        for: "15m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary: "Host context switching (instance {{ $labels.instance }})",
          description:
            "Context switching is growing on node (> 1200 / s)\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostSwapIsFillingUp",
        expr: "(1 - (node_memory_SwapFree_bytes / node_memory_SwapTotal_bytes)) * 100 > 90",
        for: "20m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary: "Host swap is filling up (instance {{ $labels.instance }})",
          description:
            "Swap is filling up (>90%)\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostSystemdServiceCrashed",
        expr: 'node_systemd_unit_state{\n    state="failed",\n    name!="motd-news.service",\n    name!~"sssd.*socket",\n    name!~"fwupd.*service",\n    name!="rpc-svcgssd.service"\n} == 1',
        for: "1h",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary:
            "Host systemd service crashed (instance {{ $labels.instance }})",
          description:
            "systemd service crashed\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostOomKillDetected",
        expr: "increase(node_vmstat_oom_kill[1m]) > 0",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Host {{ $labels.instance }} OOM kill detected",
          description:
            "OOM kill detected\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostNetworkInterfaceSaturated",
        expr: '(\n    rate(\n        node_network_receive_bytes_total{device!~"tap.*",job!="vmhost"}[1m]\n    )\n    +\n    rate(\n        node_network_transmit_bytes_total{device!~"tap.*",job!="vmhost"}[1m]\n    )\n) / node_network_speed_bytes{device!~"tap.*",job!="vmhost"} > 0.8 < 10000',
        for: "1m",
        labels: {
          priority: PRIORITY.LOW,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Host {{ $labels.instance }} Network interface saturated",
          description:
            'The network interface "{{ $labels.device }}" on "{{ $labels.instance }}" is getting overloaded.\n\nVALUE = {{ $value }}\n\nLABELS = {{ $labels }}',
        },
      },
      {
        alert: "HostRequiresReboot",
        expr: "kured_reboot_required > 0",
        for: "4h",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary: "Host requires reboot (instance {{ $labels.instance }})",
          description:
            "{{ $labels.instance }} requires a reboot.\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
    ],
  });

  new Alert(scope, `${id}-k8s`, {
    name: "k8s",
    namespace: namespace,
    rules: [
      {
        alert: "KubernetesNodeReady",
        expr: 'kube_node_status_condition{condition="Ready",status="true"} == 0',
        for: "10m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Kubernetes Node ready (instance {{ $labels.instance }})",
          description:
            "Node {{ $labels.node }} has been unready for a long time\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesMemoryPressure",
        expr: 'kube_node_status_condition{condition="MemoryPressure",status="true"} == 1',
        for: "2m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary:
            "Kubernetes memory pressure (instance {{ $labels.instance }})",
          description:
            "{{ $labels.node }} has MemoryPressure condition\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesDiskPressure",
        expr: 'kube_node_status_condition{condition="DiskPressure",status="true"} == 1',
        for: "2m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary: "Kubernetes disk pressure (instance {{ $labels.instance }})",
          description:
            "{{ $labels.node }} has DiskPressure condition\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesContainerOomKilled",
        expr: 'sum by(namespace, pod) (kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}) > 0',
        for: "0m",
        labels: {
          priority: PRIORITY.NORMAL,
          namespace: "metrics", // Override pod namespace for alertmanager routing
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary:
            "Kubernetes container oom killed (instance {{ $labels.instance }})",
          description:
            "Container {{ $labels.container }} in pod {{ $labels.namespace }}/{{ $labels.pod }} has been OOMKilled {{ $value }}.\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesPersistentvolumeclaimPending",
        expr: 'kube_persistentvolumeclaim_status_phase{phase="Pending"} == 1',
        for: "2m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary:
            "Kubernetes PersistentVolumeClaim pending (instance {{ $labels.instance }})",
          description:
            "PersistentVolumeClaim {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is pending\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesVolumeOutOfDiskSpace",
        expr: "kubelet_volume_stats_available_bytes / kubelet_volume_stats_capacity_bytes * 100 < 10",
        for: "2m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary:
            "Kubernetes Volume out of disk space (instance {{ $labels.instance }})",
          description:
            "Volume is almost full (< 10% left)\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesPersistentvolumeError",
        expr: 'kube_persistentvolume_status_phase{phase=~"Failed|Pending", job="kube-state-metrics"} > 0',
        for: "0m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary:
            "Kubernetes PersistentVolume error (instance {{ $labels.instance }})",
          description:
            "Persistent volume is in bad state\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesStatefulsetDown",
        expr: "(kube_statefulset_status_replicas_ready / kube_statefulset_status_replicas) != 1",
        for: "1m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary:
            "Kubernetes StatefulSet down (instance {{ $labels.instance }})",
          description:
            "A StatefulSet went down\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesHpaScaleCapability",
        expr: "kube_horizontalpodautoscaler_status_desired_replicas >= kube_horizontalpodautoscaler_spec_max_replicas",
        for: "2m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary:
            "Kubernetes HPA scale capability (instance {{ $labels.instance }})",
          description:
            "The maximum number of desired Pods has been hit\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesPodNotHealthy",
        expr: 'sum by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Unknown|Failed",pod!~".*maintain-job.*"}) > 0',
        for: "5m",
        labels: {
          priority: PRIORITY.HIGH,
          namespace: "metrics", // Override pod namespace for alertmanager routing
          push_notify: "true",
        },
        annotations: {
          summary:
            "Kubernetes Pod not healthy (namespace: {{ $labels.namespace }}; pod: {{ $labels.pod }})",
          description:
            "Pod has been in a non-ready state for longer than 15 minutes.\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesPodCrashLooping",
        expr: "increase(kube_pod_container_status_restarts_total[1m]) > 3",
        for: "15m",
        labels: {
          priority: PRIORITY.NORMAL,
          namespace: "metrics", // Override pod namespace for alertmanager routing
          push_notify: "true",
        },
        annotations: {
          summary:
            "Kubernetes pod crash looping (instance {{ $labels.instance }})",
          description:
            "Pod {{ $labels.pod }} is crash looping\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesDeploymentGenerationMismatch",
        expr: "kube_deployment_status_observed_generation != kube_deployment_metadata_generation",
        for: "10m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary:
            "Kubernetes Deployment generation mismatch (instance {{ $labels.instance }})",
          description:
            "A Deployment has failed but has not been rolled back.\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesStatefulsetGenerationMismatch",
        expr: "kube_statefulset_status_observed_generation != kube_statefulset_metadata_generation",
        for: "10m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary:
            "Kubernetes StatefulSet generation mismatch (instance {{ $labels.instance }})",
          description:
            "A StatefulSet has failed but has not been rolled back.\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesStatefulsetUpdateNotRolledOut",
        expr: "max without (revision) (kube_statefulset_status_current_revision unless kube_statefulset_status_update_revision) * (kube_statefulset_replicas != kube_statefulset_status_replicas_updated)",
        for: "10m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary:
            "Kubernetes StatefulSet update not rolled out (instance {{ $labels.instance }})",
          description:
            "StatefulSet update has not been rolled out.\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesDaemonsetRolloutStuck",
        expr: "kube_daemonset_status_number_ready / kube_daemonset_status_desired_number_scheduled * 100 < 100 or kube_daemonset_status_desired_number_scheduled - kube_daemonset_status_current_number_scheduled > 0",
        for: "10m",
        labels: {
          priority: PRIORITY.NORMAL,
          push_notify: "true",
        },
        annotations: {
          summary:
            "Kubernetes DaemonSet rollout stuck (instance {{ $labels.instance }})",
          description:
            "Some Pods of DaemonSet are not scheduled or not ready\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesDaemonsetMisscheduled",
        expr: "kube_daemonset_status_number_misscheduled > 0",
        for: "1m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary:
            "Kubernetes DaemonSet misscheduled (instance {{ $labels.instance }})",
          description:
            "Some DaemonSet Pods are running where they are not supposed to run\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesApiServerErrors",
        expr: 'sum(rate(apiserver_request_total{job="apiserver",code=~"(?:5..)"}[1m])) / sum(rate(apiserver_request_total{job="apiserver"}[1m])) * 100 > 3',
        for: "2m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary: "Kubernetes API server errors",
          description:
            "Kubernetes API server is experiencing high error rate\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesApiClientErrors",
        expr: '(sum(rate(rest_client_requests_total{code=~"(4|5)..",job!="metrics-victoria-metrics-operator"}[1m])) by (instance, job) / sum(rate(rest_client_requests_total[1m])) by (instance, job)) * 100 > 1',
        for: "2m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary:
            "Kubernetes API client errors (instance {{ $labels.instance }})",
          description:
            "Kubernetes API client is experiencing high error rate\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesClientCertificateExpiresNextWeek",
        expr: 'sum by (job) (apiserver_client_certificate_expiration_seconds_count{job="apiserver"}) > 0 and histogram_quantile(0.01, sum by (job, le) (rate(apiserver_client_certificate_expiration_seconds_bucket{job="apiserver"}[5m]))) < 7*24*60*60',
        for: "0m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "Kubernetes client certificate expires next week",
          description:
            "A client certificate used to authenticate to the apiserver is expiring next week.\n\nVALUE = {{ $value }}\n\nLABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesApiServerLatency",
        expr: 'histogram_quantile(0.99, sum(rate(apiserver_request_latencies_bucket{subresource!="log",verb!~"(?:CONNECT|WATCHLIST|WATCH|PROXY)"} [10m])) WITHOUT (instance, resource)) / 1e+06 > 1',
        for: "2m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "Kubernetes API server latency",
          description:
            "Kubernetes API server has a 99th percentile latency of {{ $value }} seconds for {{ $labels.verb }}.\n\nVALUE = {{ $value }}\nLABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubeRebootRequired",
        expr: "max(kured_reboot_required) by (node) != 0",
        for: "4h",
        labels: {
          priority: PRIORITY.NORMAL,
          push_notify: "true",
        },
        annotations: {
          summary:
            "{{ $labels.node }} requires being rebooted, and the reboot daemon has failed to do so for 4 hours",
          impact:
            "Cluster nodes more vulnerable to security exploits. Eventually, no disk space left.",
          description:
            "Machine(s) require being rebooted, probably due to kernel update.",
        },
      },
      {
        alert: "KubeletVersionSkew",
        expr: "min(count(kube_node_info) by (kubelet_version)) < count(kube_node_info)",
        for: "1h",
        labels: {
          priority: PRIORITY.NORMAL,
          push_notify: "true",
        },
        annotations: {
          summary:
            "{{ $value }} nodes are not running the same kubelet version as the others",
        },
      },
      {
        alert: "KubernetesPodCpuThrottling",
        expr: `increase(container_cpu_cfs_throttled_periods_total{}[$__rate_interval]) / increase(container_cpu_cfs_periods_total{}[$__rate_interval]) * 100 > 25`,
        for: "30m",
        labels: {
          priority: PRIORITY.NORMAL,
          namespace: "metrics", // Override pod namespace for alertmanager routing
          push_notify: "true",
        },
        annotations: {
          summary:
            "Pod {{ $labels.pod }} in {{ $labels.namespace }} seeing 25% of CFS periods throttled.",
        },
      },
    ],
  });

  new Alert(scope, `${id}-network`, {
    name: "network",
    namespace: namespace,
    rules: [
      {
        alert: "HighPingLossMax",
        expr: 'min(probe_success{job!="blackbox-ping-lakelair",job=~"blackbox-ping.*"}) < 0.9',
        for: "10m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary: "Ping loss from at least one source > 10%",
          description:
            "Ping loss from at least one source > 10%\n  VALUE = {{ $value }}",
        },
      },
      {
        alert: "HighPingLossAvg",
        expr: 'avg(probe_success{job!="blackbox-ping-lakelair",job=~"blackbox-ping.*"}) < 0.9',
        for: "10m",
        labels: {
          priority: PRIORITY.HIGH,
          push_notify: "true",
        },
        annotations: {
          summary: "Ping loss across all sources > 10%",
          description:
            "Ping loss across all sources > 10%\n  VALUE = {{ $value }}",
        },
      },
    ],
  });

  new Alert(scope, `${id}-smarthome`, {
    name: "smarthome",
    namespace: namespace,
    rules: [
      {
        alert: "SmartHomeAirQualityDropping",
        expr: "delta(hass_sensor_pm25_u0xb5g_per_mu0xb3[30m]) > 2.5",
        for: "5m",
        labels: {
          priority: PRIORITY.LOW,
          push_notify: "true",
        },
        annotations: {
          summary:
            "PM2.5 in living room is rising rapidly (delta {{ $value }})",
        },
      },
      {
        alert: "SmartHomeBadAirQuality",
        expr: "max_over_time(hass_sensor_pm25_u0xb5g_per_mu0xb3[1h]) > 20",
        for: "60m",
        labels: {
          priority: PRIORITY.LOW,
          push_notify: "true",
        },
        annotations: {
          summary:
            "PM2.5 in living room has been > 20 for the past hour ({{ $value }})",
        },
      },
    ],
  });

  new Alert(scope, `${id}-ups`, {
    name: "ups",
    namespace: namespace,
    rules: [
      {
        alert: "UpsHighLoad",
        expr: "nut_load * 100 > 75",
        for: "5m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "UPS load over 75% on UPS {{ $labels.ups }}",
          description:
            "UPS load on {{ $labels.ups }}\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
    ],
  });

  new Alert(scope, `${id}-velero`, {
    name: "velero",
    namespace: namespace,
    rules: [
      {
        alert: "VeleroBackupPartialFailures",
        annotations: {
          message:
            "Velero backup {{ $labels.schedule }} has partially failed backups.",
        },
        expr: 'sum by (schedule) (increase(velero_backup_partial_failure_total{schedule!=""}[1h])) > 0',
        for: "0m",
        labels: {
          priority: PRIORITY.NORMAL,
          push_notify: "true",
        },
      },
      {
        alert: "VeleroBackupFailures",
        annotations: {
          message: "Velero backup {{ $labels.schedule }} has failed backups.",
        },
        expr: 'sum by (schedule) (increase(velero_backup_failure_total{schedule!=""}[1h])) > 0',
        for: "0m",
        labels: {
          priority: PRIORITY.NORMAL,
          push_notify: "true",
        },
      },
    ],
  });

  new Alert(scope, `${id}-zfs`, {
    name: "zfs",
    namespace: namespace,
    rules: [
      {
        alert: "ZfsLowArcHitRate",
        expr: "node_zfs_arc_hits / (node_zfs_arc_misses + node_zfs_arc_hits) * 100 < 90",
        for: "5m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary:
            "ZFS ARC hit ratio below 90% (instance {{ $labels.instance }})",
          description:
            "ZFS ARC hit ratio on {{ $labels.instance }}\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
    ],
  });
}
