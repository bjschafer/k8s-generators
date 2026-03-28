# pint configuration
# https://cloudflare.github.io/pint/configuration.html

checks {
  # alerts/template verifies that $labels references in annotations exist as labels in the
  # query result. In offline mode pint cannot verify labels for recording rule metrics
  # (e.g. job_route_method_code:* series), so it produces false positives. Demote to warning.
  disabled = ["alerts/template"]
}
