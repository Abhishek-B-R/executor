/** Network adapter for the official app feed: an index of vetted apps and each app's source. */
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { isTextFile } from "@executor-js/sdk";
import {
  CatalogEntry,
  CatalogFeed,
  CatalogFeedSource,
  CatalogImportFailed,
  CatalogUnavailable,
  PreparedApp,
  type CatalogIcon,
  type CatalogSource,
} from "../contracts/catalog.ts";

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

/** Icons load in the user's browser, so only web and inline image addresses are kept. */
const iconUrl = (src: string, base: string) => {
  if (!URL.canParse(src, base)) return undefined;
  const url = new URL(src, base);
  return ["https:", "http:"].includes(url.protocol) || url.href.startsWith("data:image/")
    ? url.href
    : undefined;
};

const resolveIcons = (icons: readonly CatalogIcon[], base: string) =>
  icons.flatMap((icon) => {
    const src = iconUrl(icon.src, base);
    return src === undefined ? [] : [{ ...icon, src }];
  });

/**
 * Read the feed at `feedUrl`, its `index.json`. Redirects are not followed. Listing reads only the
 * index; preparing reads it again and then the chosen app's source document.
 */
export const catalogSource = (client: HttpClient.HttpClient, feedUrl: string): CatalogSource => {
  const read = <A>(url: string, schema: Schema.Decoder<A>) =>
    Effect.gen(function* () {
      const response = yield* client.get(url);
      if (response.status !== 200) return yield* new CatalogUnavailable();
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(yield* response.text);
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("30 seconds"),
      Effect.mapError(() => new CatalogUnavailable()),
    );
  const index = read(feedUrl, CatalogFeed);
  return {
    list: index.pipe(
      Effect.map((feed) =>
        feed.apps.map(({ source: _source, ...entry }) =>
          CatalogEntry.make({ ...entry, icons: resolveIcons(entry.icons, feedUrl) }),
        ),
      ),
    ),
    prepare: (id) =>
      Effect.gen(function* () {
        const entry = (yield* index).apps.find((entry) => entry.id === id);
        if (entry === undefined)
          return yield* new CatalogImportFailed({
            code: "entry_missing",
            reason: "This entry is no longer in the catalog. Refresh and choose another app.",
          });
        // Only a matched catalog identifier is recorded, never an arbitrary lookup input.
        yield* Effect.annotateCurrentSpan({ "catalog.entry.id": entry.id });
        const reference = new URL(entry.source, feedUrl).href;
        const source = yield* read(reference, CatalogFeedSource);
        const manifest = Option.fromNullishOr(
          source.files.find((file) => file.path === "package.json"),
        ).pipe(
          Option.filter(isTextFile),
          Option.flatMap((file) => decodeManifest(file.content)),
        );
        if (
          source.package !== entry.package ||
          !Option.exists(manifest, ({ name }) => name === entry.package)
        )
          return yield* new CatalogImportFailed({
            code: "invalid_source",
            reason: "This app's published source does not match its catalog entry.",
          });
        return PreparedApp.make({
          files: source.files,
          origin: { reference, name: entry.package, commit: null },
        });
      }),
  };
};

/** A host without a feed lists no feed apps. */
export const emptySource: CatalogSource = {
  list: Effect.succeed([]),
  prepare: () =>
    Effect.fail(
      new CatalogImportFailed({
        code: "entry_missing",
        reason: "This entry is no longer in the catalog. Refresh and choose another app.",
      }),
    ),
};
