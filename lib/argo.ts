import { App, AppProps, Chart, YamlOutputType } from "cdk8s";
import { SecretReference } from "cdk8s-plus-33/lib/imports/k8s";
import { Construct } from "constructs";
import * as path from "node:path";
import {
  ImageUpdater,
  ImageUpdaterSpecApplicationRefsImages,
  ImageUpdaterSpecWriteBackConfig,
} from "../imports/argocd-image-updater.argoproj.io";
import {
  Application,
  ApplicationSpecIgnoreDifferences,
  ApplicationSpecSyncPolicy,
} from "../imports/argoproj.io";

export const ARGO_NAMESPACE = "argocd";
export const ARGO_DESTINATION_SERVER = "https://kubernetes.default.svc";
export const ARGO_DEFAULT_PROPS: AppProps = {
  outdir: "dist/apps",
  outputFileExtension: ".yaml",
  yamlOutputType: YamlOutputType.FILE_PER_CHART,
};
export const ENABLE_SERVERSIDE_APPLY = {
  sync_policy: {
    syncOptions: ["ServerSideApply=true"],
  },
};

export function NewArgoApp(name: string, props: ArgoAppProps) {
  const app = new App(ARGO_DEFAULT_PROPS);

  new ArgoApp(app, name, props);
  app.synth();
}

export enum ArgoAppSource {
  GENERATORS,
  PROD,
}
const sources = {
  [ArgoAppSource.GENERATORS]: {
    url: "git@github.com:bjschafer/k8s-generators.git",
    basePath: "dist",
  },
  [ArgoAppSource.PROD]: {
    url: "git@github.com:bjschafer/k8s-prod.git",
    basePath: "",
  },
};

export interface ArgoAppProps {
  readonly namespace: string;
  readonly directoryName?: string;
  readonly labels?: { [name: string]: string };
  readonly destination_server?: string;
  readonly project?: string;
  readonly source?: ArgoAppSource;
  readonly sync_policy?: ApplicationSpecSyncPolicy;
  readonly recurse?: boolean;
  readonly autoUpdate?: ArgoUpdaterProps;
  readonly ignoreDifferences?: ApplicationSpecIgnoreDifferences[];
}

export class ArgoApp extends Chart {
  constructor(scope: Construct, name: string, props: ArgoAppProps) {
    super(scope, name, {
      namespace: props.namespace,
      labels: {
        "app.kubernetes.io/name": name,
        ...props.labels,
      },
    });

    const source = props.source ?? ArgoAppSource.GENERATORS;

    const defaultSyncOptions = ["CreateNamespace=true"];
    const providedSyncOptions = props.sync_policy?.syncOptions ?? [];
    const syncOptions = [
      ...defaultSyncOptions,
      ...providedSyncOptions.filter(
        (option) => !defaultSyncOptions.includes(option),
      ),
    ];

    const syncPolicy: ApplicationSpecSyncPolicy = {
      automated: { prune: true, selfHeal: true },
      ...props.sync_policy,
      syncOptions,
    };

    new Application(this, `${name}-application`, {
      metadata: {
        name: name,
        namespace: ARGO_NAMESPACE,
      },
      spec: {
        destination: {
          namespace: props.namespace,
          server: props.destination_server ?? ARGO_DESTINATION_SERVER,
        },
        project: props.project ?? "default",
        source: {
          path: path.join(
            sources[source].basePath,
            props.directoryName ?? name,
          ),
          repoUrl: sources[source].url,
          targetRevision: "main",
        },
        syncPolicy,
        ignoreDifferences: props.ignoreDifferences,
      },
    });

    if (props.autoUpdate) {
      const images: ImageUpdaterSpecApplicationRefsImages[] =
        props.autoUpdate.images.map((image) => {
          const alias = this.getImageAlias(image.image);
          const versionConstraint = image.versionConstraint
            ? `:${image.versionConstraint}`
            : ":latest";

          const updateStrategy = this.mapUpdateStrategy(image.strategy);

          return {
            alias,
            imageName: `${image.image}${versionConstraint}`,
            commonUpdateSettings: {
              updateStrategy,
              allowTags: image.allowTags
                ? `regexp:${image.allowTags}`
                : undefined,
              ignoreTags: image.ignoreTags,
              pullSecret: image.imagePullSecret
                ? `${image.imagePullSecret.namespace}/${image.imagePullSecret.name}`
                : undefined,
            },
            manifestTargets: image.helm
              ? {
                  helm: {
                    name: image.helm.name,
                    tag: image.helm.tag,
                  },
                }
              : undefined,
          };
        });

      const writeBackMethod = props.autoUpdate.writebackMethod?.method ?? "git";
      const writeBackConfig: ImageUpdaterSpecWriteBackConfig = {
        method: writeBackMethod,
        gitConfig:
          writeBackMethod === "git"
            ? {
                branch: props.autoUpdate.writebackMethod?.gitBranch ?? "main",
              }
            : undefined,
      };

      new ImageUpdater(this, `${name}-updater`, {
        metadata: {
          name: `${name}-updater`,
          namespace: ARGO_NAMESPACE,
        },
        spec: {
          namespace: ARGO_NAMESPACE,
          applicationRefs: [
            {
              namePattern: name,
              images,
            },
          ],
          writeBackConfig,
        },
      });
    }
  }

  private mapUpdateStrategy(strategy: ArgoUpdateStrategy): string {
    switch (strategy) {
      case "newest-build":
        return "latest";
      case "alphabetical":
        return "name";
      default:
        return strategy;
    }
  }

  private getImageAlias(image: string): string {
    const alias = image.split("/").pop();
    if (!alias) {
      return image;
    }
    return alias;
  }
}

export type ArgoUpdateStrategy =
  | "digest"
  | "semver"
  | "newest-build"
  | "alphabetical";

export type ArgoWritebackMethod = "git" | "argocd";

export type ArgoWritebackProps = {
  readonly method: ArgoWritebackMethod;
  readonly gitBranch?: string;
};

export interface ArgoUpdaterImageProps {
  readonly image: string;
  readonly strategy: ArgoUpdateStrategy;
  readonly versionConstraint?: string;
  readonly allowTags?: string;
  readonly ignoreTags?: string[];
  readonly imagePullSecret?: SecretReference;
  readonly helm?: ArgoUpdaterImagePropsHelm;
}

export interface ArgoUpdaterProps {
  readonly images: ArgoUpdaterImageProps[];
  readonly writebackMethod?: ArgoWritebackProps;
}

export interface ArgoUpdaterImagePropsHelm {
  // value path for name
  readonly name: string;
  // value path for tag
  readonly tag: string;
}
