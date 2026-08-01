# pint configuration
# https://cloudflare.github.io/pint/configuration.html

checks {
  # alerts/template verifies that $labels references in annotations exist as labels in the
  # query result. In offline mode pint cannot verify labels for recording rule metrics
  # (e.g. job_route_method_code:* series), so it produces false positives. Demote to warning.
  disabled = ["alerts/template"]
}

# GitLab splits saturation ratios / apdex into focused recording-rule groups and then
# aggregates them in separate stats groups; the cross-group dependency is intentional.
check "rule/dependency" {
  ignoreGroupMismatch = ["gitlab_sli:.*"]
}

# Some alerts legitimately filter by name substring because the source metrics don't
# expose a finer-grained label for the thing we need to exclude (systemd units, backup
# schedules, maintenance job pods). Disable the smelly-regex lint for those rules.
rule {
  match {
    name = "HostSystemdServiceCrashed"
  }
  disable = ["promql/regexp"]
}

rule {
  match {
    name = "KubernetesPodNotHealthy"
  }
  disable = ["promql/regexp"]
}

rule {
  match {
    name = "VeleroBackupStale(Daily|Weekly)"
  }
  disable = ["promql/regexp"]
}
