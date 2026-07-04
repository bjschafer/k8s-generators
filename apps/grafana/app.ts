import { App, Chart, Helm } from "cdk8s";
import { basename, join, dirname } from "path";
import { readdirSync, readFileSync } from "fs";
import { DEFAULT_APP_PROPS } from "../../lib/consts";
import { NewArgoApp } from "../../lib/argo";
import { Construct } from "constructs";
import { ConfigMap } from "cdk8s-plus-33";
import {
  VmServiceScrape,
  VmServiceScrapeSpecEndpointsScheme,
} from "../../imports/operator.victoriametrics.com";

const namespace = basename(__dirname);
const name = namespace;
const app = new App(DEFAULT_APP_PROPS(namespace));
const version = "12.7.2";

NewArgoApp(name, {
  namespace: namespace,
});

class Grafana extends Chart {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new Helm(this, "grafana", {
      chart: "grafana",
      repo: "https://grafana-community.github.io/helm-charts",
      version: version,
      releaseName: name,
      namespace: namespace,
      values: {
        replicas: 2,
        ingress: {
          enabled: true,
          annotations: {
            "cert-manager.io/cluster-issuer": "letsencrypt",
          },
          hosts: ["grafana.cmdcentral.xyz", "dashboards.cmdcentral.xyz"],
          tls: [
            {
              secretName: "grafana-tls",
              hosts: ["grafana.cmdcentral.xyz", "dashboards.cmdcentral.xyz"],
            },
          ],
        },
        resources: {
          requests: {
            cpu: "100m",
            memory: "384Mi",
          },
          limits: {
            memory: "512Mi",
          },
        },
        persistence: {
          enabled: true,
          type: "pvc",
          accessModes: ["ReadWriteMany"],
          storageClassName: "cephfs",
          size: "5Gi",
        },
        env: {
          TZ: "America/Chicago",
          GF_DATABASE_TYPE: "postgres",
          GF_DATABASE_HOST: "prod-pg17-pooler-rw.postgres.svc.cluster.local:5432",
          GF_DATABASE_NAME: "grafana",
          GF_DATABASE_USER: "grafana",
          GF_DATABASE_SSL_MODE: "require",
          GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION: "true",
        },
        envFromSecret: "grafana-secrets",
        plugins: [
          "grafana-googlesheets-datasource",
          "grafana-piechart-panel",
          "grafana-worldmap-panel",
          "grafana-clock-panel",
          "marcusolsson-dynamictext-panel",
          "victoriametrics-metrics-datasource",
          "victoriametrics-logs-datasource",
        ],
        serviceMonitor: {
          enabled: false,
        },
        "grafana.ini": {
          auth: {
            signout_redirect_url: "https://login.cmdcentral.xyz/application/o/grafana/end-session/",
            oauth_auto_login: true,
            oauth_allow_insecure_email_lookup: true,
          },
          "auth.generic_oauth": {
            enabled: true,
            client_id: "$__file{/etc/secrets/auth_cmdcentral_oauth/client_id}",
            client_secret: "$__file{/etc/secrets/auth_cmdcentral_oauth/client_secret}",
            name: "Cmdcentral Login",
            scopes: "openid email profile",
            auth_url: "https://login.cmdcentral.xyz/application/o/authorize/",
            token_url: "https://login.cmdcentral.xyz/application/o/token/",
            api_url: "https://login.cmdcentral.xyz/application/o/userinfo/",
            role_attribute_path: "contains(groups[*], 'wheel') && 'Admin' || 'Viewer'",
          },
          "auth.proxy": {
            enabled: true,
            header_name: "cf-access-authenticated-user-email",
            header_property: "email",
            auto_sign_up: true,
            enable_login_token: false,
          },
          feature_toggles: {
            publicDashboards: true,
          },
          server: {
            root_url: "https://grafana.cmdcentral.xyz",
          },
        },
        extraSecretMounts: [
          {
            name: "auth-cmdcentral-oauth",
            secretName: "auth-cmdcentral-oauth",
            defaultMode: 288,
            mountPath: "/etc/secrets/auth_cmdcentral_oauth",
            readOnly: true,
          },
        ],
        sidecar: {
          dashboards: {
            enabled: true,
            folderAnnotation: "k8s-sidecar-target-directory",
            provider: {
              allowUiUpdates: true,
              foldersFromFilesStructure: true,
            },
          },
        },
        initChownData: {
          image: {
            registry: "public.ecr.aws/docker",
            tag: "latest",
          },
        },
      },
    });

    this.loadDashboards(namespace);

    new VmServiceScrape(this, "servicescrape", {
      metadata: {
        name: name,
        namespace: namespace,
      },
      spec: {
        selector: {
          matchLabels: {
            "app.kubernetes.io/name": name,
            "app.kubernetes.io/instance": name,
          },
        },
        endpoints: [
          {
            honorLabels: true,
            interval: "30s",
            path: "/metrics",
            port: "service",
            scheme: VmServiceScrapeSpecEndpointsScheme.HTTP,
            scrapeTimeout: "30s",
          },
        ],
      },
    });
  }

  private loadDashboards(ns: string) {
    const dashboardsDir = join(dirname(dirname(__dirname)), "resources", "Dashboard");
    this.loadDashboardsFromDir(dashboardsDir, dashboardsDir, ns);
  }

  private loadDashboardsFromDir(rootDir: string, dir: string, ns: string) {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        this.loadDashboardsFromDir(rootDir, join(dir, entry.name), ns);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;

      const raw = JSON.parse(readFileSync(join(dir, entry.name), "utf-8"));
      // v2+ dashboards are not supported by the file provisioner sidecar
      if (/\/v2/.test(raw.apiVersion ?? "")) continue;
      // grafanactl wraps dashboards in apiVersion/kind/spec — extract the inner spec
      const dashboardJson = raw.spec ?? raw;
      const uid: string = dashboardJson.uid ?? raw.metadata?.name ?? basename(entry.name, ".json");
      // Inject uid so Grafana can upsert existing dashboards rather than creating duplicates
      dashboardJson.uid = uid;
      // ConfigMap names must be RFC 1123: lowercase alphanumeric and hyphens only
      const safeName = uid
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");

      // Derive the Grafana folder from the full path relative to the dashboards root.
      // "General" is a convention for root-level dashboards (no folder).
      const folder = dir
        .slice(rootDir.length)
        .replace(/^[/\\]/, "")
        .replace(/\\/g, "/");

      const annotations: Record<string, string> = {
        "argocd.argoproj.io/sync-options": "ServerSideApply=true",
      };
      if (folder && folder !== "General") annotations["k8s-sidecar-target-directory"] = folder;

      new ConfigMap(this, `dashboard-${uid}`, {
        metadata: {
          name: `grafana-dashboard-${safeName}`,
          namespace: ns,
          labels: { grafana_dashboard: "1" },
          annotations,
        },
        data: { [`${uid}.json`]: JSON.stringify(dashboardJson) },
      });
    }
  }
}

new Grafana(app, "grafana");

app.synth();
