/** Network adapter for the public, read-only integrations.sh feed. */
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { CatalogFeed, CatalogUnavailable, type CatalogSource } from "../contracts/catalog.ts";

/** The published integrations.sh feed. */
const integrationsFeed = "https://integrations.sh/api.json";

/**
 * Fetch only the published feed; this never invokes the registry's discovery agent. The address is
 * the public feed unless the host names a mirror, and redirects are not followed.
 */
export const catalogSource = (
  client: HttpClient.HttpClient,
  feedUrl: string = integrationsFeed,
): CatalogSource => ({
  list: Effect.gen(function* () {
    const response = yield* client.get(feedUrl);
    if (response.status !== 200) return yield* new CatalogUnavailable();
    const feed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogFeed))(
      yield* response.text,
    );
    return feed.data;
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeout("30 seconds"),
    Effect.mapError(() => new CatalogUnavailable()),
  ),
});
