import { Chart } from "cdk8s";
import {
  PrometheusRule,
  PrometheusRuleSpec,
} from "../imports/monitoring.coreos.com";
import { PROMETHEUS_RELEASE_LABEL } from "./consts";

export function NewPrometheusRule(
  chart: Chart,
  id: string,
  spec: PrometheusRuleSpec,
): void {
  new PrometheusRule(chart, id, {
    metadata: {
      labels: {
        release: PROMETHEUS_RELEASE_LABEL,
      },
    },
    spec,
  });
}
