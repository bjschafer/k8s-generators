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
          summary: "Argo app {{ $labels.name }} not synced for at least 15 minutes",
        },
      },
      {
        alert: "ArgoImageUpdaterFailedUpdates",
        expr: `increase(argocd_image_updater_images_errors_total[5m]) > 0`,
        for: "15m",
        labels: {
          priority: PRIORITY.NORMAL,
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
        // Every other rule in this group is a comparison, so all of them evaluate to
        // no-data (not true) the moment the exporter stops -- which is how Ceph
        // alerting sat dark from 2026-07-09 to 2026-08-01 after the active mgr moved
        // off the only host being scraped. This is the watchdog for that blind spot.
        // absent() has no instance label, so a standby mgr can never trip it; it only
        // fires when no mgr anywhere is serving metrics.
        alert: "CephMetricsAbsent",
        expr: `absent(ceph_osd_up)`,
        for: "15m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Ceph metrics missing -- all Ceph alerting is blind",
          description: heredoc`
            No ceph_osd_up series for 15m, so every other Ceph alert is evaluating
            against no data and cannot fire. Usually means the active ceph-mgr moved
            and the prometheus module is not serving: only the active mgr returns
            metrics, standbys answer 200 with an empty body.
            Check: curl -s http://vmhost0{1,2,3}.cmdcentral.xyz:9283/metrics | wc -l
            `,
        },
      },
      {
        // ceph_health_detail is one series per named check, so these say *what* is
        // wrong (MON_DOWN, PG_DEGRADED, ...) instead of just "ceph is unhealthy".
        // Ceph tags each check HEALTH_ERR or HEALTH_WARN itself; split on that label
        // rather than templating priority, so the routing stays greppable.
        alert: "CephHealthCheckError",
        expr: `ceph_health_detail{severity="HEALTH_ERR"} > 0`,
        for: "5m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Ceph {{ $labels.name }} (HEALTH_ERR)",
          description: heredoc`
            Ceph health check {{ $labels.name }} is failing at HEALTH_ERR.
            Detail: ceph health detail
            `,
        },
      },
      {
        // Excluded checks are lifecycle noise rather than faults: DAEMON_OLD_VERSION
        // and OSD_UPGRADE_FINISHED both trip during the routine kured/system-upgrade
        // rolling reboots, and TELEMETRY_CHANGED just means the telemetry prompt
        // changed. RECENT_CRASH is deliberately NOT excluded -- crashes should page.
        alert: "CephHealthCheckWarning",
        expr: `ceph_health_detail{severity="HEALTH_WARN", name!~"DAEMON_OLD_VERSION|OSD_UPGRADE_FINISHED|TELEMETRY_CHANGED"} > 0`,
        for: "15m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Ceph {{ $labels.name }} (HEALTH_WARN)",
          description: heredoc`
            Ceph health check {{ $labels.name }} has been failing for 15m.
            Detail: ceph health detail
            `,
        },
      },
      {
        // Was `ceph_health_state != 0` -- a metric that has never existed, so this
        // rule could never fire. The real series is ceph_health_status (0/1/2).
        //
        // ceph_health_detail only covers the ~24 checks the mgr currently knows about
        // (no OSD_FULL, MON_DISK_LOW, POOL_FULL, ...), so this stays as the catch-all
        // for anything the two rules above can't name. The `unless` suppresses it when
        // a named check already explains the unhealthy state, so a single problem
        // pages once rather than twice. If ceph_health_detail ever disappears the
        // unless matches nothing and this degrades back to a plain rollup.
        alert: "CephState",
        expr: `(ceph_health_status != 0) unless on () (max(ceph_health_detail) > 0)`,
        for: "5m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Ceph unhealthy, no named health check to explain it",
          description: heredoc`
            ceph_health_status = {{ $value }} (1 = HEALTH_WARN, 2 = HEALTH_ERR) but no
            ceph_health_detail check is set, so the cause is outside the set the mgr
            exports. Run: ceph health detail
            `,
        },
      },
      {
        alert: "CephOsdDown",
        expr: `ceph_osd_up == 0`,
        // for:0m made this the single highest-volume pager in the cluster: 44 pages in
        // 14 days, median firing duration 3 minutes, arriving in batches of ~8-9 because
        // a vmhost reboot takes every OSD on it down at once. Ceph rides out a flap of
        // that length without degrading; 5m drops all of it and still pages within
        // minutes for an OSD that is actually gone.
        for: "5m",
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
        expr: `1 - (sum by (job) ((ceph_cluster_total_bytes - ceph_cluster_total_used_bytes) / clamp_min(ceph_cluster_total_bytes, 1))) > 0.9`,
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

  new Alert(scope, `${id}-externalsecrets`, {
    name: "externalsecrets",
    namespace: namespace,
    rules: [
      {
        alert: "ExternalSecretSyncFailed",
        // The Ready condition gauge, not externalsecret_sync_calls_error: that is a
        // monotonic counter, so `> 0` latches true after the first ever failure and
        // never clears. Note the ExternalSecret's own namespace is exported_namespace;
        // plain `namespace` is always the controller's (external-secrets).
        expr: `externalsecret_status_condition{condition="Ready",status="False"} == 1`,
        for: "15m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary:
            "ExternalSecret {{ $labels.name }} in {{ $labels.exported_namespace }} failed to sync",
        },
      },
    ],
  });

  new Alert(scope, `${id}-energy`, {
    name: "energy",
    namespace: namespace,
    rules: [
      {
        // The gauge is a timestamp rather than a lag on purpose: the lag is
        // derived here, so it keeps climbing even if the collector stops
        // emitting entirely. A lag gauge would freeze at its last good value
        // and go quiet in exactly the case worth paging about.
        //
        // Alliant publishes ~4 days in arrears normally, so 8 days is roughly
        // two missed collections -- late enough not to fire on their routine
        // slowness, early enough to notice before a month of data is missing.
        alert: "AlliantUsageDataStale",
        expr: `(time() - alliant_last_data_timestamp_seconds) / 86400 > 8`,
        for: "6h",
        labels: {
          priority: PRIORITY.LOW,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Alliant usage data is {{ $value | humanize }} days old",
          description: heredoc`
            Either the collector is failing or Alliant has stopped publishing.
            Check: kubectl logs -n energy -l job-name=<latest> -c fetch
            `,
        },
      },
      {
        // Distinct from the staleness alert and deliberately faster: this fires
        // on the mechanism (the CronJob) rather than the data, so a broken
        // collector is visible a day before the data itself looks old.
        alert: "AlliantCollectorNotSucceeding",
        expr: `time() - kube_cronjob_status_last_successful_time{namespace="energy", cronjob="alliant-collector"} > 36 * 3600`,
        for: "1h",
        labels: {
          priority: PRIORITY.LOW,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "alliant-collector has not completed successfully in over 36 hours",
        },
      },
    ],
  });

  new Alert(scope, `${id}-certmanager`, {
    name: "certmanager",
    namespace: namespace,
    rules: [
      {
        alert: "CertificateExpiringSoon",
        expr: "(certmanager_certificate_expiration_timestamp_seconds - time()) / 86400 < 14",
        for: "1h",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary:
            'Certificate {{ $labels.name }} in {{ $labels.namespace }} expires in {{ $value | printf "%.0f" }} days',
        },
      },
      {
        alert: "CertificateNotReady",
        expr: `certmanager_certificate_ready_status{condition="False"} == 1`,
        for: "15m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} is not ready",
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
        expr: `max by(persistentvolumeclaim) (1 - kubelet_volume_stats_available_bytes{namespace="postgres"} / kubelet_volume_stats_capacity_bytes{namespace="postgres"}) > 0.85`,
        for: "15m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "CNPG volume {{ $labels.persistentvolumeclaim }} is > 85% full",
        },
      },
      {
        alert: "CNPGMaxConnectionsReached",
        expr: `100 * sum by (pod) (cnpg_backends_total{namespace="postgres"}) / sum by (pod) (cnpg_pg_settings_setting{name="max_connections", namespace="postgres"}) > 90`,
        for: "5m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "CNPG pod {{ $labels.pod }}'s connections are > 90% used",
        },
      },
      {
        alert: "CNPGClusterNotHealthy",
        expr: `cnpg_cluster_instances_status{status!="ready"} > 0`,
        for: "5m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "CNPG cluster {{ $labels.cluster }} has unhealthy instances",
        },
      },
      {
        alert: "CNPGReplicationLag",
        expr: "cnpg_pg_replication_lag > 60",
        for: "5m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "CNPG replication lag on {{ $labels.pod }} is {{ $value }}s",
        },
      },
      {
        alert: "CNPGBackupFailed",
        // Use the barman plugin's own metrics rather than the CNPG collector's
        // last_failed_backup_timestamp.  The collector metric fires for any
        // failure in the past 24h, so a transient scheduling blip during a node
        // restart sticks around all day.  The barman metric only records failures
        // that made it past the k8s exec stage and into the actual barman
        // invocation, and it clears immediately when a new successful backup
        // completes because last_failed < last_available.
        expr: heredoc`
          max by(job) (barman_cloud_cloudnative_pg_io_last_failed_backup_timestamp)
          > on(job)
          max by(job) (barman_cloud_cloudnative_pg_io_last_available_backup_timestamp)
          `,
        for: "5m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "CNPG backup failed for cluster {{ $labels.job }}",
        },
      },
      {
        alert: "CNPGBackupStale",
        // Catch the case where backups stop running entirely (e.g. schedule
        // deleted, plugin broken) rather than just failing.  Time threshold is
        // 25h since we run nightly backups at 01:00/01:30.
        expr: "time() - max by(job) (barman_cloud_cloudnative_pg_io_last_available_backup_timestamp) > 90000",
        for: "1h",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "CNPG backup stale for cluster {{ $labels.job }} (no success in 25h)",
        },
      },
      {
        // Distinct from the two above, which watch barman. These dumps are the
        // only copy of the databases that goes offsite encrypted -- barman's
        // object stores are versitygw-only and server-side encrypted at best.
        // A quietly failing dump job leaves a PVC of stale files that Velero
        // keeps dutifully backing up, which reads exactly like working
        // coverage. 36h so a single missed nightly is not enough to fire.
        alert: "PostgresDumpNotSucceeding",
        expr: `time() - kube_cronjob_status_last_successful_time{namespace="postgres", cronjob="pg-dump"} > 36 * 3600`,
        for: "1h",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "pg-dump has not completed successfully in over 36 hours",
          description: heredoc`
            The offsite copy of the databases is going stale. Barman still holds
            local base backups and WAL, so this is not data loss yet.
            Check: kubectl logs -n postgres -l job-name=<latest>
            `,
        },
      },
    ],
  });

  // Requires `etcd-expose-metrics: true` in /etc/rancher/k3s/config.yaml on every
  // server plus the "etcd" VmScrapeConfig in scrapeconfigs.ts. Until 2026-08-16 none
  // of this existed, so the failure below was completely invisible in Grafana.
  new Alert(scope, `${id}-etcd`, {
    name: "etcd",
    namespace: namespace,
    rules: [
      {
        // The leading indicator for the whole cascade. On 2026-08-16 fsync hit 3.9s,
        // kube-controller-manager lost its lease, and k3s exits on lease loss -- all
        // three servers died inside 90s.
        //
        // The 2026-08-16 baseline this used to cite (fsync p99 30-62ms, commit p99
        // 3.6-4.2ms) was measured while the VMs ran cache=unsafe, where the guest fsync
        // returns as soon as the host page cache accepts it -- those numbers were never
        // real. Moving etcd onto local ZFS zvols with cache=writeback on 2026-08-24 made
        // the metrics honest and they jumped ~2x for fsync and ~50x for commit with no
        // change in load (~9 proposals/s, 60MB db). Re-measured over 2026-08-24..08-30:
        // fsync p99 median 60-125ms, p95 ~0.27s, tail to 1.6s; commit p99 median
        // 0.10-0.22s, p95 ~0.26s, tail to 1.6s.
        //
        // 1.5s is ~6x the p95 and still well inside the 1-4s seen during the incident.
        // At 0.5s this alert had 1238 firing-minutes in six days; at 1.5s it has 13.
        // Re-measure before tightening -- the honest floor is HDD-bound, not tunable.
        alert: "EtcdHighFsyncDurations",
        expr: `histogram_quantile(0.99, sum(rate(etcd_disk_wal_fsync_duration_seconds_bucket{job="etcd"}[5m])) by (instance, le)) > 1.5`,
        // 10m so a short snapshot or compaction blip doesn't page, but a backup-driven
        // stall (which runs for many minutes) does.
        for: "10m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "etcd WAL fsync p99 above 1.5s on {{ $labels.instance }}",
          description:
            "etcd is struggling to fsync its write-ahead log, which starves every leader-elected controller and can make k3s exit.\n  VALUE = {{ $value }}s\n  LABELS = {{ $labels }}",
        },
      },
      {
        // Backend commit is the other half of the disk story and catches slow reads /
        // large transactions that fsync latency alone misses. Same recalibration as
        // EtcdHighFsyncDurations above: the old 250ms came from the fake cache=unsafe
        // baseline and now sits *below* the honest p95 (~0.26s), so it fired on nearly
        // every nightly Velero/Kopia window -- 1698 firing-minutes in six days, 21 of
        // them overnight pages, none actionable. 1.5s gives 30.
        alert: "EtcdHighCommitDurations",
        expr: `histogram_quantile(0.99, sum(rate(etcd_disk_backend_commit_duration_seconds_bucket{job="etcd"}[5m])) by (instance, le)) > 1.5`,
        for: "10m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "etcd backend commit p99 above 1.5s on {{ $labels.instance }}",
          description:
            "etcd backend commit latency is high, usually the same Ceph contention that drives EtcdHighFsyncDurations.\n  VALUE = {{ $value }}s\n  LABELS = {{ $labels }}",
        },
      },
      {
        // Leader churn is the symptom that immediately precedes controllers dropping
        // their leases. More than two elections in 15m is never normal here.
        alert: "EtcdFrequentLeaderChanges",
        expr: `increase(etcd_server_leader_changes_seen_total{job="etcd"}[15m]) > 2`,
        for: "0m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "etcd leader changed more than twice in 15m",
          description:
            "Frequent etcd leader elections indicate the cluster is unstable, typically from disk or network latency.\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        // Catches the case where a member is up but not part of a healthy quorum, and
        // (via absent()) the case where the scrape itself has gone away -- which is how
        // we ended up blind before 2026-08-16.
        alert: "EtcdMembersDown",
        expr: `count(up{job="etcd"} == 0) > 0 or absent(up{job="etcd"})`,
        for: "5m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "etcd member down or etcd metrics missing entirely",
          description:
            "An etcd member is unreachable, or the etcd scrape has stopped returning data.\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        // etcd's default quota is 2GiB (quota-backend-bytes in the k3s startup log).
        // Crossing it puts the cluster into read-only alarm state, which is a very bad
        // day. Warn with plenty of runway.
        alert: "EtcdDatabaseQuotaLowSpace",
        expr: `(etcd_mvcc_db_total_size_in_bytes{job="etcd"} / etcd_server_quota_backend_bytes{job="etcd"}) * 100 > 80`,
        for: "10m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "etcd database is above 80% of its backend quota",
          description:
            "etcd will go read-only when it hits the quota.\n  VALUE = {{ $value }}%\n  LABELS = {{ $labels }}",
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
          summary: "Host memory under memory pressure (instance {{ $labels.instance }})",
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
          summary: "Host inodes will fill in 24 hours (instance {{ $labels.instance }})",
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
          summary: "Host disk will fill in 24 hours (instance {{ $labels.instance }})",
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
          summary: "Host unusual disk read latency (instance {{ $labels.instance }})",
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
          summary: "Host unusual disk write latency (instance {{ $labels.instance }})",
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
          description: "CPU load is > 80%\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostCpuStealNoisyNeighbor",
        expr: 'avg by(instance) (rate(node_cpu_seconds_total{mode="steal"}[5m])) * 100 > 10',
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary: "Host CPU steal noisy neighbor (instance {{ $labels.instance }})",
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
        expr: 'node_systemd_unit_state{\n    state="failed",\n    name!="motd-news.service",\n    name!~"sssd.*socket",\n    name!~"fwupd.*service",\n    name!="rpc-svcgssd.service",\n    name!="systemd-networkd-wait-online.service"\n} == 1',
        for: "1h",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary: "Host systemd service crashed (instance {{ $labels.instance }})",
          description: "systemd service crashed\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostOomKillDetected",
        expr: 'increase(node_vmstat_oom_kill{job!="node-exporter"}[1m]) > 0',
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "Host {{ $labels.instance }} OOM kill detected",
          description: "OOM kill detected\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "HostNetworkInterfaceSaturated",
        expr: '(\n    rate(\n        node_network_receive_bytes_total{device!~"tap.*",job!="vmhost"}[1m]\n    )\n    +\n    rate(\n        node_network_transmit_bytes_total{device!~"tap.*",job!="vmhost"}[1m]\n    )\n) / node_network_speed_bytes{device!~"tap.*",job!="vmhost"} > 0.8 < 10000',
        for: "10m",
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
          summary: "Kubernetes memory pressure (instance {{ $labels.instance }})",
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
        expr: 'kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} > 0',
        for: "0m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary:
            "Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }} was OOMKilled",
          description:
            "Container {{ $labels.container }} in pod {{ $labels.namespace }}/{{ $labels.pod }} has been OOMKilled.\n  LABELS = {{ $labels }}",
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
          summary: "Kubernetes PersistentVolumeClaim pending (instance {{ $labels.instance }})",
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
          summary: "Kubernetes Volume out of disk space (instance {{ $labels.instance }})",
          description:
            "Volume is almost full (< 10% left)\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesPersistentvolumeError",
        expr: 'kube_persistentvolume_status_phase{phase=~"Failed|Pending", job="kube-state-metrics"} > 0',
        for: "15m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary: "Kubernetes PersistentVolume error (instance {{ $labels.instance }})",
          description:
            "Persistent volume is in bad state\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesStatefulsetDown",
        expr: "(kube_statefulset_status_replicas_ready / kube_statefulset_status_replicas) != 1",
        // for:1m fired on any single StatefulSet pod restart -- node reboots, valkey
        // rollouts, Renovate-driven image bumps. 13 pages in 14 days with a median
        // firing duration of 1 minute. Anything that recovers inside 10m recovered on
        // its own; anything that does not is a real outage and still pages.
        for: "10m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary: "Kubernetes StatefulSet down (instance {{ $labels.instance }})",
          description: "A StatefulSet went down\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
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
          summary: "Kubernetes HPA scale capability (instance {{ $labels.instance }})",
          description:
            "The maximum number of desired Pods has been hit\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesPodNotHealthy",
        // Job-owned pods are excluded wholesale rather than by name. Velero's Kopia
        // repo-maintenance pods were already special-cased, but the same false positives
        // came from velero backup pods and system-upgrade's apply-*-plan pods, which are
        // Pending by design while they wait for a node. Joining against kube_pod_owner
        // covers every Job the cluster grows later without another pod!~ pattern.
        expr: 'sum by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Unknown|Failed"} * on (namespace, pod) group_left () max by (namespace, pod) (kube_pod_owner{owner_kind!="Job"})) > 0',
        // was 5m, which never matched the "longer than 15 minutes" the description
        // promises. 15m is the documented intent and rides out normal scheduling waits.
        for: "15m",
        labels: {
          priority: PRIORITY.HIGH,
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
        // Use a 15m window so accumulated restarts remain visible even at max CrashLoopBackOff
        // backoff (~5 min/restart), where a 1m window drops below the threshold.
        //
        // `max without (instance)` before the increase() is load-bearing: `instance` is
        // kube-state-metrics' own pod IP, so every KSM restart/reschedule starts a fresh series
        // for each counter. VictoriaMetrics counts a new series' first sample as an increase from
        // zero, which re-reports every pod's *lifetime* restart total as if it just happened --
        // a KSM rollout on 2026-08-02 fired 49 phantom alerts that way. Aggregating the label off
        // first keeps the series stable across KSM churn, unlike an `offset` guard which would go
        // blind for a full window after each rollout.
        expr: "increase(max without (instance) (kube_pod_container_status_restarts_total)[15m:1m]) > 3",
        for: "5m",
        labels: {
          priority: PRIORITY.NORMAL,
          push_notify: "true",
        },
        annotations: {
          // Deliberately not {{ $labels.instance }}: that was KSM's IP, identical on every alert,
          // which made a batch of these indistinguishable in notifications.
          summary:
            "Kubernetes pod crash looping (namespace: {{ $labels.namespace }}; pod: {{ $labels.pod }})",
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
          summary: "Kubernetes Deployment generation mismatch (instance {{ $labels.instance }})",
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
          summary: "Kubernetes StatefulSet generation mismatch (instance {{ $labels.instance }})",
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
          summary: "Kubernetes StatefulSet update not rolled out (instance {{ $labels.instance }})",
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
          summary: "Kubernetes DaemonSet rollout stuck (instance {{ $labels.instance }})",
          description:
            "Some Pods of DaemonSet are not scheduled or not ready\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesDaemonsetMisscheduled",
        expr: "kube_daemonset_status_number_misscheduled > 0",
        // Every kured/system-upgrade node reboot taints the node before its DaemonSet
        // pods are gone, so all ~7 cluster-wide DaemonSets briefly report a misscheduled
        // pod at once. At for:1m that was 30 pages in 14 days, 29 of them overnight, and
        // every single episode had a measured duration of 0-1 minutes -- i.e. it never
        // once caught anything but a rolling reboot. A genuinely misscheduled pod does
        // not self-heal, so 15m keeps the real signal and drops all of the reboot noise.
        for: "15m",
        labels: {
          // dropped from HIGH: this is a "look at it tomorrow" condition, and HIGH
          // punches through Pushover quiet hours.
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "Kubernetes DaemonSet misscheduled (instance {{ $labels.instance }})",
          description:
            "Some DaemonSet Pods are running where they are not supposed to run\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "KubernetesApiServerErrors",
        expr: 'sum(rate(apiserver_request_total{job="apiserver",code=~"(?:5..)"}[1m])) / sum(rate(apiserver_request_total{job="apiserver"}[1m])) * 100 > 3',
        // Velero's nightly Kopia repo-maintenance burst (~35+ jobs across
        // backup repos, a couple hours after the 06:00 UTC daily backup)
        // briefly starves etcd on the control-plane nodes, pushing 5xx rate
        // above 3% for 5-10min most nights before self-resolving. 2m paged
        // every night for a non-issue; 10m rides out the known blip while
        // still catching a real sustained outage.
        for: "10m",
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
        for: "20m",
        labels: {
          priority: PRIORITY.HIGH,
        },
        annotations: {
          summary: "Kubernetes API client errors (instance {{ $labels.instance }})",
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
          description: "Machine(s) require being rebooted, probably due to kernel update.",
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
          summary: "{{ $value }} nodes are not running the same kubelet version as the others",
        },
      },
      {
        alert: "KubernetesPodCpuThrottling",
        expr: `increase(container_cpu_cfs_throttled_periods_total{}[5m]) / increase(container_cpu_cfs_periods_total{}[5m]) * 100 > 25`,
        for: "30m",
        labels: {
          priority: PRIORITY.NORMAL,
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
          description: "Ping loss from at least one source > 10%\n  VALUE = {{ $value }}",
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
          description: "Ping loss across all sources > 10%\n  VALUE = {{ $value }}",
        },
      },
    ],
  });

  new Alert(scope, `${id}-gitlab`, {
    name: "gitlab",
    namespace: namespace,
    rules: [
      {
        alert: "GitLabSidekiqJobsQueuedHigh",
        expr: "gitlab_sidekiq_queue_size > 1000",
        for: "15m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "GitLab Sidekiq queue {{ $labels.name }} has {{ $value }} jobs backed up",
        },
      },
      {
        alert: "GitLabSidekiqJobsFailing",
        expr: "increase(gitlab_sidekiq_jobs_failed_total[5m]) > 0",
        for: "15m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "GitLab Sidekiq jobs failing in queue {{ $labels.queue }}",
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
        },
        annotations: {
          summary: "PM2.5 in living room is rising rapidly (delta {{ $value }})",
        },
      },
      {
        alert: "SmartHomeBadAirQuality",
        expr: "max_over_time(hass_sensor_pm25_u0xb5g_per_mu0xb3[1h]) > 100",
        for: "60m",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary: "PM2.5 has been > 100 for the past hour ({{ $value }})",
        },
      },
    ],
  });

  new Alert(scope, `${id}-ups`, {
    name: "ups",
    namespace: namespace,
    rules: [
      {
        alert: "UpsOnBattery",
        expr: "nut_status{status='OB'} == 1",
        for: "0m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "UPS {{ $labels.ups }} is running on battery!",
        },
      },
      {
        alert: "UpsLowBattery",
        expr: "nut_battery_charge < 0.5",
        for: "1m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "UPS {{ $labels.ups }} battery is below 50% ({{ $value }})",
        },
      },
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
      {
        alert: "UpsBatteryReplacementNeeded",
        expr: "nut_battery_mfr_date_seconds > 0 and (time() - nut_battery_mfr_date_seconds) > (3 * 365 * 24 * 3600)",
        for: "1d",
        labels: {
          priority: PRIORITY.LOW,
        },
        annotations: {
          summary: "UPS {{ $labels.ups }} battery is over 3 years old",
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
          message: "Velero backup {{ $labels.schedule }} has partially failed backups.",
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
      {
        alert: "VeleroBackupStaleDaily",
        expr: `time() - velero_backup_last_successful_timestamp{schedule!="",schedule!~".*weekly.*"} > 86400 * 2`,
        for: "1h",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary:
            "Velero schedule {{ $labels.schedule }} hasn't had a successful backup in 2 days",
        },
      },
      {
        alert: "VeleroBackupStaleWeekly",
        expr: `time() - velero_backup_last_successful_timestamp{schedule=~".*weekly.*"} > 86400 * 8`,
        for: "1h",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary:
            "Velero schedule {{ $labels.schedule }} hasn't had a successful backup in 8 days",
        },
      },
    ],
  });

  new Alert(scope, `${id}-versitygw`, {
    name: "versitygw",
    namespace: namespace,
    rules: [
      {
        alert: "VersityGWDown",
        expr: `up{job="statsd-exporter", namespace="metrics-exporters"} == 0`,
        for: "5m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "VersityGW metrics pipeline is down (statsd-exporter scrape failing)",
        },
      },
      {
        alert: "VersityGWServerErrors",
        expr: heredoc`
          sum(rate(caddy_http_request_duration_seconds_count{job="vmhost-caddy", host="s3.cmdcentral.xyz", code=~"5.."}[5m]))
          /
          sum(rate(caddy_http_request_duration_seconds_count{job="vmhost-caddy", host="s3.cmdcentral.xyz"}[5m]))
          > 0.01
          `,
        for: "5m",
        labels: {
          priority: PRIORITY.NORMAL,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "VersityGW S3 server error rate exceeds 1% ({{ $value | humanizePercentage }})",
          description:
            "5xx responses from s3.cmdcentral.xyz sustained for 5m. Check VersityGW logs on vmhost03.",
        },
      },
      {
        alert: "VersityGWHighLatency",
        expr: heredoc`
          histogram_quantile(0.99,
            sum by (le) (
              rate(caddy_http_request_duration_seconds_bucket{job="vmhost-caddy", host="s3.cmdcentral.xyz"}[5m])
            )
          ) > 10
          `,
        for: "10m",
        labels: {
          priority: PRIORITY.NORMAL,
        },
        annotations: {
          summary: "VersityGW S3 p99 latency is above 10s ({{ $value | humanizeDuration }})",
          description:
            "S3 requests through Caddy on vmhost03 are extremely slow. Check disk and network.",
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
          summary: "ZFS ARC hit ratio below 90% (instance {{ $labels.instance }})",
          description:
            "ZFS ARC hit ratio on {{ $labels.instance }}\n  VALUE = {{ $value }}\n  LABELS = {{ $labels }}",
        },
      },
      {
        alert: "ZfsPoolDegraded",
        expr: `node_zfs_zpool_state{state!="online"} == 1`,
        for: "1m",
        labels: {
          priority: PRIORITY.HIGH,
          ...SEND_TO_PUSHOVER,
        },
        annotations: {
          summary: "ZFS pool {{ $labels.zpool }} is {{ $labels.state }} on {{ $labels.instance }}",
        },
      },
    ],
  });
}
