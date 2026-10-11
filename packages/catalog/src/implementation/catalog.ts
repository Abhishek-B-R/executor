/** Resolve catalog choices into ordinary app source; installation belongs to the caller. */
import { catalogStage } from "./diagnostics.ts";
import { Effect } from "effect";
import type { Catalog, CatalogBackground, CatalogHost, KeptCatalog } from "../contracts/catalog.ts";
import { keepCatalog } from "./kept.ts";
import { catalogSource } from "./source.ts";

/**
 * Read a kept catalog, integrations.sh by default. Construction performs no I/O and is cheap, so a
 * host may build one per request around the `kept` copy it shares across requests, with that
 * request's `background`. The host supplies the egress it fetches with and its OAuth client
 * settings. Source generators load with the first preparation, which keeps them out of hosted
 * startup.
 */
export const createCatalog = (
  host: CatalogHost,
  options: { readonly kept?: KeptCatalog; readonly background?: CatalogBackground } = {},
): Catalog => {
  const kept = options.kept ?? keepCatalog(catalogSource(host.egress.client, host.feedUrl));
  const snapshot = kept.read(options.background).pipe(catalogStage("lookup"));
  const list = Effect.map(snapshot, ({ entries }) => entries);
  return {
    list,
    icons: Effect.map(snapshot, ({ icons }) => icons),
    custom: (input) =>
      Effect.promise(() => import("./prepare.ts")).pipe(
        Effect.flatMap(({ generateCustomApp }) => generateCustomApp(input, host)),
      ),
    prepare: (input) =>
      Effect.promise(() => import("./prepare.ts")).pipe(
        Effect.flatMap(({ prepareEntry }) => prepareEntry(list, host, input)),
        catalogStage("prepare"),
      ),
  };
};
