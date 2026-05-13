import { Chart, Size } from "cdk8s";
import { Cpu, Protocol, Service, ServiceType } from "cdk8s-plus-33";
import { Construct } from "constructs";
import { AppPlus } from "../../lib/app-plus";
import { EXTERNAL_DNS_ANNOTATION_KEY } from "../../lib/consts";
import { namespace } from "./app";

const name = "statsd-exporter";
const metricsPort = 9102;
const statsdPort = 9125;

export class StatsdExporter extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AppPlus(this, "app", {
      name,
      namespace,
      image: "prom/statsd-exporter",
      // InfluxDB-flavored tags are what versitygw emits (comma-separated key=value)
      args: ["--statsd.parse-influxdb-tags"],
      disableIngress: true,
      ports: [{ name: "metrics", number: metricsPort }],
      resources: {
        cpu: { request: Cpu.millis(50), limit: Cpu.millis(200) },
        memory: { request: Size.mebibytes(32), limit: Size.mebibytes(64) },
      },
    });

    // Separate LoadBalancer service so versitygw on vmhost03 can push StatsD UDP
    // to a stable in-cluster IP. VmAgent scrapes the ClusterIP service above.
    const lbSvc = new Service(this, "lb-svc", {
      metadata: {
        name: `${name}-lb`,
        namespace,
        annotations: {
          [EXTERNAL_DNS_ANNOTATION_KEY]: "statsd.cmdcentral.xyz",
        },
      },
      type: ServiceType.LOAD_BALANCER,
      ports: [{ port: statsdPort, name: "statsd", protocol: Protocol.UDP }],
    });
    lbSvc.selectLabel("app.kubernetes.io/name", name);
  }
}
