import { Atom, AsyncResult } from "effect/reactivity";
import { Option } from "effect";
import { getDomain } from "tldts";
import type { CatalogEntry } from "@executor-js/catalog/contracts";
import type { AppRequirements } from "@executor-js/sdk";
import type { Query } from "./dashboard.ts";

/** Use the old product's logo proxy, sending only a registrable domain at double display resolution. */
export const faviconUrl = (url: string | null | undefined, size: number): string | null => {
  if (!url) return null;
  const domain = getDomain(url) ?? (URL.canParse(url) ? getDomain(new URL(url).hostname) : null);
  return domain === null ? null : `https://integrations.sh/logo/${domain}?sz=${size * 2}`;
};

/** Exact catalog names can supply missing display metadata; ambiguous brands never guess a domain. */
export const catalogIconDomainsAtom = <E>(catalogAtom: Query<readonly CatalogEntry[], E>) =>
  Atom.make((get) => {
    const domains = new Map<string, string | null>();
    const catalog = AsyncResult.value(get(catalogAtom));
    if (Option.isNone(catalog)) return domains;
    for (const entry of catalog.value) {
      const name = entry.name.trim().toLowerCase();
      const domain = getDomain(entry.domain);
      if (domain === null) continue;
      domains.set(name, domains.has(name) && domains.get(name) !== domain ? null : domain);
    }
    return domains;
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

/** The variant made for each theme, else one without a theme, else the first loadable one. */
export const appIconSources = (icons: AppRequirements["icons"]): AppIconSources | null => {
  const usable = (icons ?? []).filter((icon) => loadable(icon.src));
  const pick = (theme: "light" | "dark") =>
    (
      usable.find((icon) => icon.theme === theme) ??
      usable.find((icon) => icon.theme === undefined) ??
      usable[0]
    )?.src;
  const light = pick("light");
  const dark = pick("dark");
  return light === undefined || dark === undefined ? null : { light, dark };
};
