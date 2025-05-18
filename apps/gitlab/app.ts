import { App, Chart, Helm } from "cdk8s";
import { basename } from "path";
import { ArgoAppSource, NewArgoApp } from "../../lib/argo";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { MonitoringRule } from "../../lib/monitoring/victoriametrics";
import { Construct } from "constructs";
import { VmServiceScrape } from "../../imports/operator.victoriametrics.com";
import heredoc from "tsheredoc";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const version = "0.77.1";

NewArgoApp(name, {
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

class Runner extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Helm(this, "gitlab-runner", {
      chart: "gitlab-runner",
      repo: "https://charts.gitlab.io",
      version: version,
      releaseName: "prod-runner",
      namespace: "gitlab",
      values: {
        gitlabUrl: "https://gitlab.cmdcentral.xyz",
        concurrent: 6,
        logFormat: "json",
        metrics: {
          enabled: true,
          portName: "metrics",
        },
        service: {
          enabled: true,
          labels: {
            vmservicescrape: "true",
          },
        },
        rbac: {
          create: true,
        },
        runners: {
          secret: "runner-registration",
          config: heredoc`
            [[runners]]
              [runners.kubernetes]
                namespace = "{{.Release.Namespace}}"
                image = "alpine"
                privileged = true
`,
        },
      },
    });

    new VmServiceScrape(this, "servicescrape", {
      metadata: {
        name: "prod-runner",
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            vmservicescrape: "true",
          },
        },
        endpoints: [
          {
            port: "metrics",
          },
        ],
      },
    });
  }
}
new Runner(app, "gl-runner");

new MonitoringRule(app, "recording-rules", {
  name: "recording-rules",
  namespace: namespace,
  ruleGroups: [
    {
      name: "GitLab",
      rules: [
        {
          record: "instance:puma_utilization:ratio",
          expr: "sum by (instance) (\n  puma_active_connections\n) / sum by (instance) (\n  puma_max_threads\n)\n",
        },
        {
          record:
            "job_route_method_code:gitlab_workhorse_http_request_duration_seconds_count:rate5m",
          expr: "sum by (job, route, method, code) (\n  rate(gitlab_workhorse_http_request_duration_seconds_count[5m])\n)\n",
        },
        {
          alert: "RedisDown",
          expr: "avg_over_time(redis_up[5m]) * 100 < 50",
          annotations: {
            description:
              "The Redis service {{ $labels.job }} instance {{ $labels.instance }} is not responding for more than 50% of the time for 5 minutes.",
            summary: "The Redis service {{ $labels.job }} is not responding",
          },
        },
        {
          alert: "PostgresDown",
          expr: "avg_over_time(pg_up[5m]) * 100 < 50",
          annotations: {
            description:
              "The Postgres service {{ $labels.job }} instance {{ $labels.instance }} is not responding for more than 50% of the time for 5 minutes.",
            summary: "The Postgres service {{ $labels.job }} is not responding",
          },
        },
        {
          alert: "PumaQueueing",
          expr: "avg_over_time(puma_queued_connections[30m]) > 1",
          annotations: {
            description:
              'Puma instance {{ $labels.instance }} is queueing requests with an average of {{ $value | printf "%.1f" }} over the last 30 minutes.',
            summary: "Puma is queueing requests",
          },
        },
        {
          alert: "HighPumaUtilization",
          expr: "instance:puma_utilization:ratio * 100 > 90",
          for: "60m",
          annotations: {
            description:
              'Puma instance {{ $labels.instance }} has more than 90% thread utilization ({{ $value | printf "%.1f" }}%) over the last 60 minutes.',
            summary: "Puma is has high utilization",
          },
        },
        {
          alert: "SidekiqJobsQueuing",
          expr: "sum by (name) (sidekiq_queue_size) > 0",
          for: "60m",
          annotations: {
            summary: "Sidekiq has jobs queued",
            description:
              "Sidekiq queue {{ $labels.name }} has {{ $value }} jobs queued for 60 minutes.",
          },
        },
        {
          alert: "HighgRPCResourceExhaustedRate",
          expr: 'sum without (grpc_code, grpc_method, grpc_service, grpc_type) (\n  rate(grpc_server_handled_total{grpc_code="ResourceExhausted"}[5m])\n) / sum without (grpc_code, grpc_method, grpc_service, grpc_type) (\n  rate(grpc_server_handled_total[5m])\n) * 100 > 1\n',
          for: "60m",
          annotations: {
            summary: "High gRPC ResourceExhausted error rate",
            description:
              'Job {{ $labels.job }} instance {{ $labels.instance }} gRPC is returning more than 1% ({{ $value | printf "%.1f" }}%) ResourceExhausted errors over the last 60 minutes.',
          },
        },
        {
          alert: "PostgresDatabaseDeadlocks",
          expr: "increase(pg_stat_database_deadlocks[5m]) > 0",
          annotations: {
            summary: "Postgres database has deadlocks",
            description:
              'Postgres database {{ $labels.instance }} had {{ $value | printf "%d" }} deadlocks in the last 5 minutes.',
          },
        },
        {
          alert: "PostgresDatabaseDeadlockCancels",
          expr: "increase(pg_stat_database_deadlocks[5m]) > 0",
          annotations: {
            summary: "Postgres database has queries canceled due to deadlocks",
            description:
              'Postgres database {{ $labels.instance }} had {{ $value | printf "%d" }} queries canceled due to deadlocks in the last 5 minutes.',
          },
        },
        {
          alert: "WorkhorseHighErrorRate",
          expr: '(\n  sum without (job, code) (\n    job_route_method_code:gitlab_workhorse_http_request_duration_seconds_count:rate5m{code=~"5.."}\n  ) /\n  sum without (job,code) (\n    job_route_method_code:gitlab_workhorse_http_request_duration_seconds_count:rate5m\n  ) < 10\n) * 100 > 50\n',
          annotations: {
            summary: "Workhorse has high error rates",
            description:
              'Workhorse route {{ $labels.route }} method {{ $labels.method }} has more than 50% errors ({{ $value | printf "%.1f" }}%) for the last 60 minutes.',
          },
        },
        {
          alert: "WorkhorseHighErrorRate",
          expr: '(\n  sum without (job, code) (\n    job_route_method_code:gitlab_workhorse_http_request_duration_seconds_count:rate5m{code=~"5.."}\n  ) /\n  sum without (job,code) (\n    job_route_method_code:gitlab_workhorse_http_request_duration_seconds_count:rate5m\n  ) > 10\n) * 100 > 10\n',
          annotations: {
            summary: "Workhorse has high error rates",
            description:
              'Workhorse route {{ $labels.route }} method {{ $labels.method }} has more than 10% errors ({{ $value | printf "%.1f" }}%) for the last 60 minutes.',
          },
        },
      ],
    },
    {
      name: "Service Level Indicators",
      interval: "30s",
      rules: [
        {
          record: "gitlab_sli:job:availability:ratio",
          expr: "avg by (job) (\n  avg_over_time(up[30s])\n)\n",
        },
        {
          record: "gitlab_sli:rails_active_connections:avg30s",
          expr: "sum(avg_over_time(puma_active_connections[30s]))\n",
        },
        {
          record: "gitlab_sli:rails_queued_connections:avg30s",
          expr: "sum(avg_over_time(puma_queued_connections[30s]))\n",
        },
        {
          record: "gitlab_sli:rails_active_connections:max30s",
          expr: "sum(max_over_time(puma_active_connections[30s]))\n",
        },
        {
          record: "gitlab_sli:rails_queued_connections:max30s",
          expr: "sum(max_over_time(puma_queued_connections[30s]))\n",
        },
        {
          record: "gitlab_sli:rails_workers:avg30s",
          expr: "count(avg_over_time(ruby_memory_bytes[30s])) or sum(avg_over_time(puma_max_threads[30s]))\n",
        },
        {
          record: "gitlab_sli:redis_cpu_seconds:rate1m",
          expr: "(sum(rate(redis_used_cpu_sys[1m])) + sum(rate(redis_used_cpu_user[1m]))) or (sum(rate(redis_cpu_sys_seconds_total[1m])) + sum(rate(redis_cpu_user_seconds_total[1m])))\n",
        },
        {
          record:
            "gitlab_sli:code_method_route:workhorse_http_request_count:rate1m",
          expr: "sum by (code,method,route) (\n  rate(gitlab_workhorse_http_request_duration_seconds_count[1m])\n)\n",
        },
        {
          record:
            "gitlab_sli:code_method_route:workhorse_http_request_duration_seconds:rate1m",
          expr: "sum by (code,method,route) (\n  rate(gitlab_workhorse_http_request_duration_seconds_sum[1m])\n)\n",
        },
      ],
    },
    {
      name: "Service Level Indicators - Apdex",
      interval: "1m",
      rules: [
        {
          record: "gitlab_sli:gitlab_component_apdex:ratio",
          labels: {
            job: "gitaly",
          },
          expr: '(\n  sum(rate(grpc_server_handling_seconds_bucket{job="gitaly",grpc_type="unary",le="0.5",grpc_method!~"GarbageCollect|Fsck|RepackFull|RepackIncremental|CommitLanguages|CreateRepositoryFromURL|UserRebase|UserSquash|CreateFork|UserUpdateBranch|FindRemoteRepository|UserCherryPick|FetchRemote|UserRevert|FindRemoteRootRef"}[1m]))\n  +\n  sum(rate(grpc_server_handling_seconds_bucket{job="gitaly",grpc_type="unary",le="1",grpc_method!~"GarbageCollect|Fsck|RepackFull|RepackIncremental|CommitLanguages|CreateRepositoryFromURL|UserRebase|UserSquash|CreateFork|UserUpdateBranch|FindRemoteRepository|UserCherryPick|FetchRemote|UserRevert|FindRemoteRootRef"}[1m]))\n) / 2 / sum(rate(grpc_server_handling_seconds_count{job="gitaly",grpc_type="unary",grpc_method!~"GarbageCollect|Fsck|RepackFull|RepackIncremental|CommitLanguages|CreateRepositoryFromURL|UserRebase|UserSquash|CreateFork|UserUpdateBranch|FindRemoteRepository|UserCherryPick|FetchRemote|UserRevert|FindRemoteRootRef"}[1m]))\n',
        },
        {
          record: "gitlab_sli:gitlab_component_apdex:ratio",
          labels: {
            job: "gitlab-workhorse",
          },
          expr: '(\n  sum(rate(gitlab_workhorse_http_request_duration_seconds_bucket{le="1",route!="^/([^/]+/){1,}[^/]+/uploads\\\\z",route!="^/api/v4/jobs/request\\\\z"}[1m]))\n+\n  sum(rate(gitlab_workhorse_http_request_duration_seconds_bucket{le="10",route!="^/([^/]+/){1,}[^/]+/uploads\\\\z",route!="^/api/v4/jobs/request\\\\z"}[1m]))\n) / 2 / sum(rate(gitlab_workhorse_http_request_duration_seconds_count{route!="^/([^/]+/){1,}[^/]+/uploads\\\\z",route!="^/api/v4/jobs/request\\\\z"}[1m]))\n',
        },
      ],
    },
    {
      name: "Service Level Indicators - Errors",
      interval: "1m",
      rules: [
        {
          record: "gitlab_sli:gitlab_component_ops:rate",
          labels: {
            job: "postgres",
          },
          expr: "sum(rate(pg_stat_database_xact_commit[1m])) + sum(rate(pg_stat_database_xact_rollback[1m]))\n",
        },
        {
          record: "gitlab_sli:gitlab_component_errors:rate",
          labels: {
            job: "postgres",
          },
          expr: "sum(rate(pg_stat_database_xact_rollback[1m]))",
        },
        {
          record: "gitlab_sli:gitlab_component_ops:rate",
          labels: {
            job: "gitlab-rails",
          },
          expr: 'sum(\n  rate(http_request_duration_seconds_count{job="gitlab-rails"}[1m])\n)\n',
        },
        {
          record: "gitlab_sli:gitlab_component_errors:rate",
          labels: {
            job: "gitlab-rails",
          },
          expr: 'sum(\n  rate(http_request_duration_seconds_count{job="gitlab-rails",status=~"5.."}[1m])\n)\n',
        },
        {
          record: "gitlab_sli:gitlab_component_ops:rate",
          labels: {
            job: "gitlab-workhorse",
          },
          expr: 'sum(\n  rate(gitlab_workhorse_http_requests_total{job="gitlab-workhorse"}[1m])\n)\n',
        },
        {
          record: "gitlab_sli:gitlab_component_errors:rate",
          labels: {
            job: "gitlab-workhorse",
          },
          expr: 'sum(\n  rate(gitlab_workhorse_http_requests_total{job="gitlab-workhorse",code=~"5.."}[1m])\n)\n',
        },
        {
          record: "gitlab_sli:gitlab_component_errors:ratio",
          expr: "gitlab_sli:gitlab_component_errors:rate / gitlab_sli:gitlab_component_ops:rate\n",
        },
      ],
    },
    {
      name: "GitLab Saturation Ratios",
      interval: "1m",
      rules: [
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio",
          labels: {
            component: "cpu",
          },
          expr: 'avg(1 - rate(node_cpu_seconds_total{mode="idle"}[1m]))\n',
        },
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio",
          labels: {
            component: "single_node_cpu",
          },
          expr: 'max(\n  avg(1 - rate(node_cpu_seconds_total{mode="idle"}[1m]))\n)\n',
        },
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio",
          labels: {
            component: "disk_space",
          },
          expr: 'max(\n  (\n    (\n      node_filesystem_size_bytes{fstype=~"ext.|xfs|nfs.?"}\n      -\n      node_filesystem_free_bytes{fstype=~"ext.|xfs|nfs.?"}\n    )\n    /\n    node_filesystem_size_bytes{fstype=~"ext.|xfs|nfs.?"}\n  )\n)\n',
        },
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio",
          labels: {
            component: "memory",
          },
          expr: "max (instance:node_memory_utilization:ratio)",
        },
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio",
          labels: {
            component: "single_threaded_cpu",
          },
          expr: "clamp_max(\n  max (\n   (rate(redis_cpu_user_seconds_total[1m]) + rate(redis_cpu_sys_seconds_total[1m])) or\n   (rate(redis_used_cpu_user[1m]) + rate(redis_used_cpu_sys[1m]))\n  ),\n  1\n)\n",
        },
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio",
          labels: {
            component: "connection_pool",
          },
          expr: 'clamp_max(\n  max(\n    max_over_time(pgbouncer_pools_server_active_connections{user="gitlab"}[1m]) /\n    (\n      (\n        pgbouncer_pools_server_idle_connections{user="gitlab"} +\n        pgbouncer_pools_server_active_connections{user="gitlab"} +\n        pgbouncer_pools_server_testing_connections{user="gitlab"} +\n        pgbouncer_pools_server_used_connections{user="gitlab"} +\n        pgbouncer_pools_server_login_connections{user="gitlab"}\n      )\n      > 0\n    )\n), 1)\n',
        },
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio",
          labels: {
            component: "active_db_connections",
          },
          expr: 'clamp_max(\n  max(\n    sum without(state) (pg_stat_activity_count{datname="gitlabhq_production", state!="idle"})\n    /\n    (sum without(state) (pg_stat_activity_count{datname="gitlabhq_production"}) > 0)\n), 1)\n',
        },
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio",
          labels: {
            component: "redis_clients",
          },
          expr: "max(\n  max_over_time(redis_connected_clients[1m])\n  /\n  redis_config_maxclients\n)\n",
        },
        {
          record: "gitlab_sli:gitlab_service_saturation:ratio",
          expr: "max by (component) (gitlab_sli:gitlab_component_saturation:ratio)\n",
        },
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio:sapdex",
          expr: "clamp_min(gitlab_sli:gitlab_component_saturation:ratio <= on(component) group_left slo:max:soft:gitlab_sli:gitlab_component_saturation:ratio, 1) or clamp_min(clamp_max(gitlab_sli:gitlab_component_saturation:ratio > on(component) group_left slo:max:soft:gitlab_sli:gitlab_component_saturation:ratio, 0.5), 0.5) or clamp_max(gitlab_sli:gitlab_component_saturation:ratio > on(component) group_left slo:max:hard:gitlab_sli:gitlab_component_saturation:ratio, 0)\n",
        },
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio",
          labels: {
            component: "open_fds",
          },
          expr: "max(\n  max_over_time(process_open_fds[1m])\n  /\n  max_over_time(process_max_fds[1m])\n)\n",
        },
        {
          record: "gitlab_sli:gitlab_component_saturation:ratio",
          labels: {
            component: "open_ruby_fds",
          },
          expr: "max(\n  max_over_time(ruby_file_descriptors[1m])\n  /\n  max_over_time(ruby_process_max_fds[1m])\n)\n",
        },
      ],
    },
    {
      name: "GitLab Saturation Ratios Stats",
      interval: "5m",
      rules: [
        {
          record:
            "gitlab_sli:gitlab_component_saturation:ratio:avg_over_time_1w",
          expr: "avg_over_time(gitlab_sli:gitlab_component_saturation:ratio[1w])\n",
        },
        {
          record:
            "gitlab_sli:gitlab_component_saturation:ratio:predict_linear_2w",
          expr: "predict_linear(gitlab_sli:gitlab_component_saturation:ratio:avg_over_time_1w[1w], 86400 * 14)\n",
        },
        {
          record:
            "gitlab_sli:gitlab_component_saturation:ratio:predict_linear_30d",
          expr: "predict_linear(gitlab_sli:gitlab_component_saturation:ratio:avg_over_time_1w[1w], 86400 * 30)\n",
        },
        {
          record:
            "gitlab_sli:gitlab_component_saturation:ratio:sapdex:avg_over_time_1w",
          expr: "avg_over_time(gitlab_sli:gitlab_component_saturation:ratio:sapdex[1w])\n",
        },
        {
          record:
            "gitlab_sli:gitlab_component_saturation:ratio:sapdex:avg_over_time_1w:predict_linear_30d",
          expr: "predict_linear(gitlab_sli:gitlab_component_saturation:ratio:sapdex:avg_over_time_1w[1w], 86400 * 30)\n",
        },
      ],
    },
    {
      name: "GitLab Usage Ping",
      interval: "5m",
      rules: [
        {
          record: "gitlab_usage_ping:ops:rate5m",
          labels: {
            service: "workhorse",
            component: "http_requests",
          },
          expr: "sum (rate (gitlab_workhorse_http_requests_total[5m]))",
        },
        {
          record: "gitlab_usage_ping:sql_duration_apdex:ratio_rate5m",
          expr: '(\n  sum(rate(gitlab_sql_duration_seconds_bucket{le="0.1"}[5m]))\n  +\n  sum(rate(gitlab_sql_duration_seconds_bucket{le="0.25"}[5m]))\n) / 2 / (\n  sum(rate(gitlab_sql_duration_seconds_count[5m])) > 0\n)\n',
        },
        {
          record: "gitlab_usage_ping:gitaly_apdex:ratio_avg_over_time_5m",
          expr: 'avg_over_time(gitlab_sli:gitlab_component_apdex:ratio{job="gitaly"}[5m])',
        },
        {
          record: "gitlab_usage_ping:node_cpus:count",
          expr: "max (instance:node_cpus:count) by (instance)",
        },
        {
          record: "gitlab_usage_ping:node_memory_total_bytes:max",
          expr: "max (node_memory_MemTotal_bytes) by (instance)",
        },
        {
          record: "gitlab_usage_ping:node_cpu_utilization:avg",
          expr: "avg (instance:node_cpu_utilization:ratio) by (instance)",
        },
        {
          record: "gitlab_usage_ping:node_memory_utilization:avg",
          expr: "avg (instance:node_memory_utilization:ratio) by (instance)",
        },
        {
          record:
            "gitlab_usage_ping:node_service_process_resident_memory_bytes:avg",
          expr: 'avg by (instance, job) ({__name__ =~ "(ruby_){0,1}process_resident_memory_bytes", job != "gitlab_exporter_process"})',
        },
        {
          record:
            "gitlab_usage_ping:node_service_process_unique_memory_bytes:avg",
          expr: 'avg by (instance, job) ({__name__ =~ "(ruby_){0,1}process_unique_memory_bytes", job != "gitlab_exporter_process"})',
        },
        {
          record:
            "gitlab_usage_ping:node_service_process_proportional_memory_bytes:avg",
          expr: 'avg by (instance, job) ({__name__ =~ "(ruby_){0,1}process_proportional_memory_bytes", job != "gitlab_exporter_process"})',
        },
        {
          record: "gitlab_usage_ping:node_service_process:count",
          expr: 'count by (instance, job) (\n  {__name__ =~ "(ruby_){0,1}process_start_time_seconds", job != "gitlab_exporter_process"}\n)\n',
        },
        {
          record: "gitlab_usage_ping:node_service_app_server_workers:sum",
          labels: {
            server: "puma",
          },
          expr: "sum by (instance, job) (puma_workers)",
        },
      ],
    },
  ],
});

app.synth();
