/** Add app never waits for the remote public registry to render, and reuses a fresh listing. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Api, body, SessionClients } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { registryPublication, registryUpstream } from "../support/registry-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Organizations = Schema.NonEmptyArray(Schema.Struct({ slug: Schema.String }));
const listing = "/api/registry/apps";

layer(TestLive, { excludeTestServices: true })("Add app and the public registry", (it) => {
  it.effect(scenarios.addAppRegistry.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          target = yield* Target;
        const registry = yield* registryUpstream;
        const origin = yield* startFreshSelfHost(target, {
          EXECUTOR_REGISTRY_URL: registry.origin,
        });
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session();
        const account = { email: "registry-owner@example.test", password: "Synthetic-1234!" };
        expect(
          (yield* api.request(owner, "POST", "/api/auth/self-host/setup", {
            ...account,
            name: "Registry Owner",
            organizationName: "Registry lab",
          })).status,
        ).toBe(200);
        expect((yield* api.request(owner, "POST", "/api/auth/sign-in/email", account)).status).toBe(
          200,
        );
        const [organization] = yield* body(
          Organizations,
          yield* api.request(owner, "GET", "/api/auth/organization/list"),
        );
        yield* browser.login(owner);
        const addApp = `${origin}/org/${organization.slug}/apps/add`;

        const { held } = yield* registry.hold;
        const document = yield* browser.use(
          "Read the whole Add app document while the registry does not answer",
          (page) =>
            page.request
              .get(addApp)
              .then((response) =>
                response.text().then((html) => ({ status: response.status(), html })),
              ),
        );
        expect(document.status).toBe(200);
        expect(document.html).toContain("Find a published app or connect a service.");
        expect(yield* registry.paths, "rendering the page read nothing from the registry").toEqual(
          [],
        );

        yield* browser.use("Open Add app", (page) => page.goto(addApp));
        yield* browser.use("Search while the listing loads", (page) =>
          page.getByPlaceholder("Search apps…").fill("example"),
        );
        yield* held;
        yield* browser.checkpoint("Add app while the public registry has not answered");
        yield* registry.release;
        yield* browser.use("The public listing appears after the registry answers", (page) =>
          page.getByText(registryPublication.name, { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("The search typed before the listing loaded is kept", (page) =>
            page.getByPlaceholder("Search apps…").inputValue(),
          ),
        ).toBe("example");

        yield* browser.use("Open Add app again", (page) => page.reload());
        yield* browser.use("The listing is shown again", (page) =>
          page.getByText(registryPublication.name, { exact: true }).waitFor(),
        );
        expect(
          (yield* registry.paths).filter((path) => path === listing),
          "a fresh listing is reused instead of read again",
        ).toEqual([listing]);
      }),
    ),
  );
});
