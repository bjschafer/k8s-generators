import {
  Application,
  ApplicationSpecIgnoreDifferences,
  ApplicationSpecSyncPolicy,
} from "../imports/argoproj.io";
import { App, AppProps, Chart, YamlOutputType } from "cdk8s";
import { Construct } from "constructs";
import { SecretReference } from "cdk8s-plus-33/lib/imports/k8s";
import * as path from "node:path";

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

    const app = new Application(this, `${name}-application`, {
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
      app.metadata.addAnnotation(
        `${argoUpdateAnnotationBase}/write-back-method`,
        props.autoUpdate.writebackMethod?.method ?? "git",
      );
      if (
        !props.autoUpdate.writebackMethod?.method ||
        props.autoUpdate.writebackMethod?.method === "git"
      ) {
        app.metadata.addAnnotation(
          `${argoUpdateAnnotationBase}/git-branch`,
          props.autoUpdate.writebackMethod?.gitBranch ?? "main",
        );
      }

      // the annotation expects images to be in the format
      // alias=image:version,alias=image:version
      const imageList = props.autoUpdate.images
        .map((image) => {
          const alias = this.getImageAlias(image.image);
          const versionConstraint = image.versionConstraint
            ? `:${image.versionConstraint}`
            : ":latest";
          return `${alias}=${image.image}${versionConstraint}`;
        })
        .join(",");

      app.metadata.addAnnotation(
        `${argoUpdateAnnotationBase}/image-list`,
        imageList,
      );

      for (const image of props.autoUpdate.images) {
        const alias = this.getImageAlias(image.image);

        app.metadata.addAnnotation(
          `${argoUpdateAnnotationBase}/${alias}.update-strategy`,
          image.strategy,
        );

        if (image.allowTags) {
          app.metadata.addAnnotation(
            `${argoUpdateAnnotationBase}/${alias}.allow-tags`,
            `regexp:${image.allowTags}`,
          );
        }
        if (image.ignoreTags) {
          app.metadata.addAnnotation(
            `${argoUpdateAnnotationBase}/${alias}.ignore-tags`,
            image.ignoreTags.join(", "),
          );
        }

        if (image.imagePullSecret) {
          app.metadata.addAnnotation(
            `${argoUpdateAnnotationBase}/${alias}.imagePullSecret`,
            `pullsecret:${image.imagePullSecret.namespace}/${image.imagePullSecret.name}}`,
          );
        }
      }
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

const argoUpdateAnnotationBase = "argocd-image-updater.argoproj.io";

/**
 * How ArgoCD Image Updater will determine if an image is out of date.
 * Odds are, you probably want digest, not latest.
 * @see - https://argocd-image-updater.readthedocs.io/en/stable/basics/update-strategies/
 */
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
