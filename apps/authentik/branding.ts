import { Chart, Yaml } from "cdk8s";
import { ConfigMap } from "cdk8s-plus-34";
import { Construct } from "constructs";
import { BRAND, BrandingAssets, FRAPPE } from "../../lib/branding";

/** Where the server reads media from: authentik's file storage path (/data) is
 * `/data/media -> /media` in the image, and uploads live under `<usage>/<schema>`.
 * Mount at the real path rather than through the symlink. */
export const MEDIA_MOUNT_PATH = "/media/public/branding";
export const BLUEPRINT_MOUNT_PATH = "/blueprints/cmdcentral";

// file picker values are relative to /data/media/public
const media = (file: string) => `branding/${file}`;

const p = FRAPPE;

/**
 * Brand custom CSS. authentik adopts it as the last sheet of every component's
 * shadow root, not into the document, so it works from `:host` down. The
 * selectors repeat the hooks authentik's dark mode uses (`:host([theme])`) so
 * these win on specificity, not just on order.
 *
 * 2026.8 has no stable token set yet (the `--ak-color-*` names in the docs are
 * unreleased), so this sets the PatternFly globals the dark theme reads. Some
 * tokens and the font are resolved on the document and only inherited into the
 * shadow roots, so overriding their inputs does nothing; those are set
 * directly.
 */
const customCss = `
:host, :host([theme]) {
  --ak-accent: ${BRAND.accent};
  --ak-dark-foreground: ${p.text};
  --ak-dark-background: ${p.mantle};
  --ak-dark-background-light: ${p.base};
  --ak-dark-background-lighter: ${p.surface0};
  --ak-v2-global--BackgroundColor--100: ${p.base};
  --ak-v2-global--Color--100: ${p.text};
  --ak-v2-global--BorderColor--100: ${p.surface1};
  --ak-v2-global--BorderColor--200: ${p.surface1};
  --ak-c-login__main--BackgroundColor: ${p.base};
  --ak-c-login__main--Color: ${p.text};
  --ak-c-login__footer--Color: ${p.subtext0};
  --ak-scrollbar-background-color: ${p.mantle};
  --ak-scrollbar-thumb-background-color: ${p.surface1};

  --pf-global--BackgroundColor--100: ${p.base};
  --pf-global--BackgroundColor--dark-100: ${p.base};
  --pf-global--BackgroundColor--light-100: ${p.base};
  --pf-global--BackgroundColor--150: ${p.surface0};
  --pf-global--BackgroundColor--200: ${p.mantle};
  --pf-global--BackgroundColor--dark-200: ${p.mantle};
  --pf-global--BackgroundColor--light-200: ${p.mantle};
  --pf-global--BackgroundColor--300: ${p.surface0};
  --pf-global--BackgroundColor--dark-300: ${p.surface0};
  --pf-global--BackgroundColor--light-300: ${p.surface0};
  --pf-global--BackgroundColor--400: ${p.surface1};
  --pf-global--BackgroundColor--dark-400: ${p.surface1};

  --pf-global--Color--100: ${p.text};
  --pf-global--Color--dark-100: ${p.text};
  --pf-global--Color--light-100: ${p.text};
  --pf-global--Color--200: ${p.subtext0};
  --pf-global--Color--dark-200: ${p.subtext0};
  --pf-global--Color--light-200: ${p.subtext0};
  --pf-global--icon--Color--light: ${p.subtext0};
  --pf-global--icon--Color--dark: ${p.subtext0};

  --pf-global--BorderColor--100: ${p.surface1};
  --pf-global--BorderColor--dark-100: ${p.surface1};
  --pf-global--BorderColor--light-100: ${p.surface1};
  --pf-global--BorderColor--200: ${p.surface2};
  --pf-global--BorderColor--300: ${p.surface1};
  --pf-global--BorderColor--400: ${p.overlay1};

  --pf-global--primary-color--100: ${BRAND.accent};
  --pf-global--primary-color--dark-100: ${BRAND.accent};
  --pf-global--primary-color--light-100: ${BRAND.accent};
  --pf-global--primary-color--200: ${p.pink};
  --pf-global--primary-color--300: ${BRAND.accent};
  --pf-global--active-color--100: ${BRAND.accent};

  --pf-global--link--Color: ${BRAND.link};
  --pf-global--link--Color--dark: ${BRAND.link};
  --pf-global--link--Color--light: ${BRAND.link};
  --pf-global--link--Color--hover: ${p.lavender};
  --pf-global--link--Color--dark--hover: ${p.lavender};
  --pf-global--link--Color--light--hover: ${p.lavender};
  --pf-global--link--Color--visited: ${p.mauve};

  --pf-global--danger-color--100: ${p.red};
  --pf-global--success-color--100: ${p.green};
  --pf-global--warning-color--100: ${p.yellow};
  --pf-global--info-color--100: ${p.blue};
  --pf-global--disabled-color--100: ${p.overlay0};
  --pf-global--disabled-color--200: ${p.surface1};

  /* terminal look: authentik bundles RedHatMono, so no font to fetch */
  --ak-font-family-sans-serif: var(--ak-generic-monospace);
  --ak-font-family-heading: var(--ak-generic-monospace);
  --pf-global--FontFamily--sans-serif: var(--ak-generic-monospace);
  --pf-global--FontFamily--heading--sans-serif: var(--ak-generic-monospace);
}

/* the document resolves body's font before these variables can reach it */
:host {
  font-family: var(--ak-generic-monospace);
}

/* PatternFly defines the button's colours on the button itself, so they can't
 * be inherited from :host. The prompt colour is light: text on it goes dark. */
.pf-c-button {
  --pf-c-button--m-primary--Color: ${p.crust};
  --pf-c-button--m-primary--hover--Color: ${p.crust};
  --pf-c-button--m-primary--focus--Color: ${p.crust};
  --pf-c-button--m-primary--active--Color: ${p.crust};
}

:focus-visible {
  outline-color: ${BRAND.accent};
}
`;

/**
 * Flows that were on authentik's stock background photo, which changes from
 * release to release. Titles are only set where they named authentik or used
 * the old "Cmdcentral Login" brand.
 */
const flowOverrides: { slug: string; title?: string }[] = [
  { slug: "default-authentication-flow", title: `${BRAND.name} login` },
  { slug: "default-enrollment-flow", title: `Welcome to ${BRAND.name}` },
  { slug: "book-club-registration" },
  { slug: "print-dis-registration" },
];

export interface AuthentikBrandingProps {
  readonly namespace: string;
  // the authentik version, embedded so every upgrade re-applies this blueprint
  readonly version: string;
}

/**
 * The cmdcentral brand, as an authentik blueprint plus the media it points at.
 * The worker discovers the blueprint from BLUEPRINT_MOUNT_PATH and re-applies it
 * whenever its content changes; the server serves the assets from
 * MEDIA_MOUNT_PATH. Anything changed by hand on these objects in the admin UI is
 * overwritten on the next apply.
 */
export class AuthentikBranding extends Chart {
  public readonly blueprint: ConfigMap;
  public readonly assets: ConfigMap;

  constructor(scope: Construct, id: string, props: AuthentikBrandingProps) {
    super(scope, id);

    this.assets = new BrandingAssets(this, "assets", {
      name: "branding-assets",
      namespace: props.namespace,
      assets: ["logo.svg", "icon.svg", "background.svg"],
    });

    const background = media("background.svg");

    const blueprint = {
      version: 1,
      metadata: {
        name: `${BRAND.name} branding`,
        labels: {
          "blueprints.goauthentik.io/description": `${BRAND.name} brand, theme and flow titles`,
          // authentik's own blueprint for default-authentication-flow sets the
          // stock title and re-applies whenever an upgrade changes that file.
          // Changing this label with every version re-applies this blueprint
          // too, and the meta entry below runs the default first, so the
          // override always lands last.
          "cmdcentral.xyz/authentik-version": props.version,
        },
      },
      entries: [
        {
          model: "authentik_blueprints.metaapplyblueprint",
          attrs: {
            identifiers: { name: "Default - Authentication flow" },
            required: false,
          },
        },
        {
          model: "authentik_brands.brand",
          identifiers: { domain: "cmdcentral.xyz" },
          attrs: {
            branding_title: BRAND.name,
            branding_logo: media("logo.svg"),
            branding_favicon: media("icon.svg"),
            branding_default_flow_background: background,
            branding_custom_css: customCss.trim(),
            // Frappé is a dark palette; let the OS preference flip it to light
            // and every surface would be wrong
            attributes: { settings: { theme: { base: "dark" } } },
          },
        },
        ...flowOverrides.map(({ slug, title }) => ({
          model: "authentik_flows.flow",
          identifiers: { slug },
          attrs: { background, ...(title ? { title } : {}) },
        })),
      ],
    };

    this.blueprint = new ConfigMap(this, "blueprint", {
      metadata: { name: "branding-blueprint", namespace: props.namespace },
      data: { "branding.yaml": Yaml.stringify(blueprint) },
    });
  }
}
