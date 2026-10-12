/**
 * An OpenAPI app whose document is larger than the biggest imported vendor API's builds within
 * the compiler's memory, and its tools call the API. The document is an indented JSON file, as
 * imported apps wrote it, so it is the size whose build exceeded the hosted compiler's memory.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";
import { largeOpenapiDocument } from "../support/large-openapi.ts";

const index = `import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import configuration from "./openapi.json";
export default defineApp({ accounts: {} }, async ({ cache, fetch, signal }) => ({
  tools: liveOpenapiRouter({ ...configuration, cache, fetch, ...(signal === undefined ? {} : { signal }) }),
}));`;

layer(HostedLive, { excludeTestServices: true })("Large OpenAPI app", (it) => {
  it.effect(scenarios.largeOpenapiApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const origin = (yield* Target).metadata.origin;
        const configuration = JSON.stringify(
          {
            source: { document: largeOpenapiDocument(origin, 377) },
            allowedOrigin: origin,
            securitySchemes: {},
            methods: {},
            oauth: [],
          },
          null,
          2,
        );
        yield* evidence.json("large-openapi-source.json", { bytes: configuration.length });
        expect(configuration.length).toBeGreaterThan(11_000_000);

        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Large OpenAPI ${randomUUID().slice(0, 8)}`,
          files: [
            { path: "index.ts", content: index },
            { path: "openapi.json", content: configuration },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body).slice(0, 2000)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        // The call compiles the whole document, then sends the one operation the product answers.
        const called = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "service.health",
          kind: "query",
          input: {},
        });
        yield* evidence.json("large-openapi-call.json", {
          status: called.status,
          body: called.body,
        });
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(
          yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.Literal("ok") }))(
            called.body,
          ),
        ).toEqual({ status: "ok" });
      }),
    ),
  );
});
