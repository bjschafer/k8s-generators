import { ConfigMap } from "cdk8s-plus-34";
import { Construct } from "constructs";
import { readFileSync } from "fs";
import { extname, join } from "path";

/**
 * Shared look and feel: Catppuccin Frappé with a terminal-prompt mark (`>_`).
 * Apps that can be themed pull their colours from here so they stay in step.
 * The SVGs in resources/branding/ hard-code the same hex values; Catppuccin's
 * palette is fixed, so the two can't drift unless one is edited by hand.
 *
 * https://catppuccin.com/palette
 */
export const FRAPPE = {
  rosewater: "#f2d5cf",
  flamingo: "#eebebe",
  pink: "#f4b8e4",
  mauve: "#ca9ee6",
  red: "#e78284",
  maroon: "#ea999c",
  peach: "#ef9f76",
  yellow: "#e5c890",
  green: "#a6d189",
  teal: "#81c8be",
  sky: "#99d1db",
  sapphire: "#85c1dc",
  blue: "#8caaee",
  lavender: "#babbf1",
  text: "#c6d0f5",
  subtext1: "#b5bfe2",
  subtext0: "#a5adce",
  overlay2: "#949cbb",
  overlay1: "#838ba7",
  overlay0: "#737994",
  surface2: "#626880",
  surface1: "#51576d",
  surface0: "#414559",
  base: "#303446",
  mantle: "#292c3c",
  crust: "#232634",
} as const;

export const BRAND = {
  name: "cmdcentral",
  // the prompt colour: buttons, focus rings, the `>` in the mark. Mauve rather
  // than terminal green, which with a `>` reads as Splunk's logo.
  accent: FRAPPE.mauve,
  link: FRAPPE.blue,
} as const;

const ASSET_DIR = join(__dirname, "..", "resources", "branding");

// icon.png is icon.svg rasterised for things that won't take an SVG favicon:
//   inkscape icon.svg --export-type=png --export-width=180 --export-filename=icon.png
export type BrandingAsset = "logo.svg" | "icon.svg" | "icon.png" | "background.svg";

export interface BrandingAssetsProps {
  readonly name: string;
  readonly namespace: string;
  readonly assets: BrandingAsset[];
}

/**
 * A ConfigMap holding files from resources/branding/, for an app to mount and
 * serve itself. Keys are the file names.
 */
export class BrandingAssets extends ConfigMap {
  constructor(scope: Construct, id: string, props: BrandingAssetsProps) {
    super(scope, id, { metadata: { name: props.name, namespace: props.namespace } });

    for (const asset of props.assets) {
      const path = join(ASSET_DIR, asset);
      if (extname(asset) === ".svg") {
        this.addData(asset, readFileSync(path, "utf-8"));
      } else {
        this.addBinaryData(asset, readFileSync(path).toString("base64"));
      }
    }
  }
}
