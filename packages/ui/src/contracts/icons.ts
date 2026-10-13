import { Atom, AsyncResult } from "effect/reactivity";
import { Option } from "effect";
import { getDomain } from "tldts";
import type { CatalogEntry, CatalogIcon } from "@executor-js/catalog/contracts";
import type { AppRequirements } from "@executor-js/sdk";
import type { Query } from "./dashboard.ts";

/** Use the old product's logo proxy, sending only a registrable domain at double display resolution. */
export const faviconUrl = (url: string | null | undefined, size: number): string | null => {
  if (!url) return null;
  const domain = getDomain(url) ?? (URL.canParse(url) ? getDomain(new URL(url).hostname) : null);
  return domain === null ? null : `https://integrations.sh/logo/${domain}?sz=${size * 2}`;
};

/**
 * Catalog apps' own icons by exact name, so an installed copy shows its catalog logo. Names that two
 * entries share map to nothing rather than guess between them.
 */
export const catalogIconsAtom = <E>(catalogAtom: Query<readonly CatalogEntry[], E>) =>
  Atom.make((get) => {
    const icons = new Map<string, readonly CatalogIcon[] | null>();
    const catalog = AsyncResult.value(get(catalogAtom));
    if (Option.isNone(catalog)) return icons;
    for (const entry of catalog.value) {
      if (entry.icons.length === 0) continue;
      const name = entry.name.trim().toLowerCase();
      icons.set(name, icons.has(name) ? null : entry.icons);
    }
    return icons;
  });

/** An app's declared icon for each color scheme. Both are the same when it declares one. */
export interface AppIconSources {
  readonly light: string;
  readonly dark: string;
}

/**
 * Icons come from app code. The build accepts only image data and HTTPS URLs; the dashboard checks
 * again and loads them only through an image element, where an SVG cannot run script or reach the
 * page.
 */
const loadable = (src: string) =>
  /^data:image\/(?:svg\+xml|png|webp|jpeg)[;,]/u.test(src) ||
  (URL.canParse(src) && new URL(src).protocol === "https:");

/** The variant made for each theme, else one without a theme, else the first one. */
const themedSources = (
  icons: readonly { readonly src: string; readonly theme?: "light" | "dark" }[],
): AppIconSources | null => {
  const pick = (theme: "light" | "dark") =>
    (
      icons.find((icon) => icon.theme === theme) ??
      icons.find((icon) => icon.theme === undefined) ??
      icons[0]
    )?.src;
  const light = pick("light");
  const dark = pick("dark");
  return light === undefined || dark === undefined ? null : { light, dark };
};

/** The loadable icons an app declares on `defineApp`, for each color scheme. */
export const appIconSources = (icons: AppRequirements["icons"]): AppIconSources | null =>
  themedSources((icons ?? []).filter((icon) => loadable(icon.src)));

/** A catalog app's icons for each color scheme; they come from the operator's own feed. */
export const catalogIconSources = (
  icons: readonly CatalogIcon[] | undefined,
): AppIconSources | null => themedSources(icons ?? []);
