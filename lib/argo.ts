import { Application, ApplicationSpecSyncPolicy } from "../imports/argoproj.io";
import { App, Chart, YamlOutputType } from "cdk8s";
import { Construct } from "constructs";
import { SecretReference } from "cdk8s-plus-29/lib/imports/k8s";
import path = require("path");

export const ARGO_NAMESPACE = "argocd";
const ARGO_DESTINATION_SERVER = "https://kubernetes.default.svc";

export function NewArgoApp(name: string, props: ArgoAppProps) {
  const app = new App({
    outdir: "dist/apps",
    outputFileExtension: ".yaml",
    yamlOutputType: YamlOutputType.FILE_PER_CHART,
  });

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
  readonly labels?: { [name: string]: string };
  readonly destination_server?: string;
  readonly project?: string;
  readonly source: ArgoAppSource;
  readonly sync_policy: ApplicationSpecSyncPolicy;
  readonly recurse?: boolean;
  readonly autoUpdate?: ArgoUpdaterProps;
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
          path: path.join(sources[props.source].basePath, props.namespace),
          repoUrl: sources[props.source].url,
          targetRevision: "main",
        },
        syncPolicy: {
          syncOptions: ["CreateNamespace=true"],
          ...props.sync_policy,
        },
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
export type ArgoUpdateStrategy = "digest" | "semver" | "latest" | "name";

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
}

export interface ArgoUpdaterProps {
  readonly images: ArgoUpdaterImageProps[];
  readonly writebackMethod?: ArgoWritebackProps;
}
