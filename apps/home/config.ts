import { Chart } from "cdk8s";
import { Construct } from "constructs";
import { ConfigMap } from "cdk8s-plus-33";

/**
 * icon can be a URL, a Dashboard Icon https://github.com/walkxcode/dashboard-icons or an MD Icon https://icon-sets.iconify.design/mdi/
 */
export interface Service {
  name: string;
  uri: string;
  description?: string;
  icon?: string;
  iconBG?: string; // hex color or tailwind color
  iconColor?: string;
  iconBubble?: boolean;
  iconAspect?: "square" | "width" | "height";
  newWindow?: boolean;
}

export interface Category {
  category?: string;
  bubble?: boolean;
  services: Service[];
}

export interface HomeConfigProps {
  readonly name: string;
  readonly namespace: string;
  readonly links: Category[];
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

    cm.addData("config.json", JSON.stringify(props.links));
  }
}
