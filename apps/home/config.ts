import { Chart } from "cdk8s";
import { Construct } from "constructs";
import { ConfigMap } from "cdk8s-plus-27";
import { stringify as yamlStringify } from "yaml";

export interface Bookmark {
  [name: string]: {
    abbr: string;
    href: string;
    description?: string;
    icon?: string;
  }[];
}

export interface BookmarkCategory {
  [category: string]: Bookmark[];
}

export interface Service {
  [name: string]: {
    href: string;
    description?: string;
    icon?: string;
    ping?: string;
    widget?: { [key: string]: any };
  };
}

export interface ServiceCategory {
  [category: string]: Service[];
}

export interface HomeConfigProps {
  readonly name: string;
  readonly namespace: string;
  readonly Kubernetes: { [key: string]: any };
  readonly Settings: { [key: string]: any };
  readonly Bookmarks: BookmarkCategory[];
  readonly Services: ServiceCategory[];
  readonly Widgets: { [key: string]: any }[];
}

export class HomeConfig extends Chart {
  constructor(scope: Construct, id: string, props: HomeConfigProps) {
    super(scope, id);

    const cm = new ConfigMap(this, `${id}-cm`, {
      metadata: {
        name: props.name,
        namespace: props.namespace,
      },
    });

    cm.addData("kubernetes.yaml", yamlStringify(props.Kubernetes));
    cm.addData("settings.yaml", yamlStringify(props.Settings));
    cm.addData("bookmarks.yaml", yamlStringify(props.Bookmarks));
    cm.addData("services.yaml", yamlStringify(props.Services));
    cm.addData("widgets.yaml", yamlStringify(props.Widgets));
  }
}

export function MakeService(
  name: string,
  url: string,
  icon?: string,
  description?: string,
  widget?: { type: string; key: string },
): Service {
  let w;
  if (widget) {
    w = {
      type: widget.type,
      key: widget.key,
      url: url,
    };
  }

  return {
    [name]: {
      href: url,
      icon: icon,
      ping: url,
      description: description,
      widget: w,
    },
  };
}
