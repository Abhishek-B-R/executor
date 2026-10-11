import { Atom, AsyncResult } from "effect/reactivity";
import { Option } from "effect";
import { getDomain } from "tldts";
import type { CatalogIcons } from "@executor-js/catalog/contracts";
import type { Query } from "./dashboard.ts";

/** Use the old product's logo proxy, sending only a registrable domain at double display resolution. */
export const faviconUrl = (url: string | null | undefined, size: number): string | null => {
  if (!url) return null;
  const domain = getDomain(url) ?? (URL.canParse(url) ? getDomain(new URL(url).hostname) : null);
  return domain === null ? null : `https://integrations.sh/logo/${domain}?sz=${size * 2}`;
};

/**
 * Logo domains by lower-cased name, from the host's small icon read rather than the full catalog.
 * The host already left out names that list more than one domain, so none is guessed.
 */
export const catalogIconDomainsAtom = <E>(iconsAtom: Query<CatalogIcons, E>) =>
  Atom.make((get): ReadonlyMap<string, string | null> => {
    const icons = AsyncResult.value(get(iconsAtom));
    return Option.isNone(icons) ? new Map() : new Map(icons.value);
  });
