/**
 * The published catalog is fetched once and kept: concurrent and repeated reads, logo domains and
 * installs share that fetch. Dashboard pages that only decorate apps with logos read the small
 * icon list; only the add-app page downloads the whole catalog. Moving the running product's clock
 * shows the kept copy's lifetime: a stale copy answers while one refresh runs beside it, survives
 * a failed refresh, is retried only after a backoff, and is never served past its maximum age.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schedule, Schema } from "effect";
import type { Page } from "playwright";
import { Api, body, SessionClients } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { catalogFixture, catalogRevision, catalogUpstream } from "../support/catalog-upstream.ts";
import { App, Organization } from "../support/contracts.ts";
import { startControlledSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { batchedReads, batchPath, type BatchedRead } from "../support/read-batches.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Organizations = Schema.NonEmptyArray(Organization);
const Entries = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));
const Rejected = Schema.Struct({
  _tag: Schema.Literal("CatalogImportFailed"),
  code: Schema.String,
});
/** A 1×1 transparent PNG, so logo requests never leave the test machine. */
const logo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** The kept copy's documented lifetime: fresh for 10 minutes, kept 24 hours, retried after 1. */
const minute = 60_000;
const freshness = { fresh: 10 * minute, maxStale: 24 * 60 * minute, retry: minute };

type Read = "catalog" | "icons";
/** Direct and batched reads of the full catalog and of its icon list. */
const classifyPath = (pathname: string): Read | undefined =>
  pathname === "/api/catalog" || /^\/api\/organizations\/[^/]+\/catalog$/.test(pathname)
    ? "catalog"
    : pathname === "/api/catalog/icons"
      ? "icons"
      : undefined;
const classifyRead = (read: BatchedRead): Read | undefined =>
  (read.group === "catalog" && read.endpoint === "list") ||
  (read.group === "organization" && read.endpoint === "catalog")
    ? "catalog"
    : read.group === "catalog" && read.endpoint === "icons"
      ? "icons"
      : undefined;

layer(TestLive, { excludeTestServices: true })("Catalog freshness", (it) => {
  it.effect(scenarios.catalogFreshness.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const browser = yield* Browser;
        const feed = yield* catalogUpstream();
        const product = yield* startControlledSelfHost(target, { EXECUTOR_CATALOG_URL: feed.url });
        const origin = product.metadata.origin;
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, product),
        );
        const advanceClock = (milliseconds: number) =>
          serverControl("clock/advance", 200, { milliseconds }).pipe(
            Effect.provideService(Target, product),
          );
        const owner = yield* api.session();
        expect(
          (yield* api.request(owner, "POST", "/api/auth/self-host/setup", {
            name: "Catalog Owner",
            email: "catalog-owner@example.test",
            password: "Synthetic-catalog-password-123!",
            organizationName: "Catalog lab",
          })).status,
        ).toBe(200);
        const [organization] = yield* body(
          Organizations,
          yield* api.request(owner, "GET", "/api/auth/organization/list"),
        );
        const prefix = `/api/organizations/${organization.id}`;

        // Reads that start together share one fetch of the feed.
        const responses = yield* Effect.all(
          [
            ...Array.from({ length: 4 }, () => api.request(owner, "GET", "/api/catalog")),
            api.request(owner, "GET", "/api/catalog/icons"),
            api.request(owner, "GET", `${prefix}/catalog`),
          ],
          { concurrency: "unbounded" },
        );
        for (const response of responses) expect(response.status).toBe(200);
        const [listed] = responses;
        const entries = yield* body(Entries, listed);
        for (const entry of Object.values(catalogFixture))
          expect(entries.map(({ id }) => id)).toContain(entry.id);
        expect(yield* feed.fetches, "concurrent reads share one fetch").toBe(1);

        // Only names with one registrable domain get a logo; the full entries never travel.
        const icons = yield* api.request(owner, "GET", "/api/catalog/icons");
        expect(icons.body).toEqual([["acme mail", "acme-mail.example"]]);

        // Later reads and installs within the freshness window reuse the kept catalog.
        expect((yield* api.request(owner, "GET", "/api/catalog")).status).toBe(200);
        const install = (entry: string) =>
          api
            .request(owner, "POST", `${prefix}/apps/install`, { entry, name: `Install ${entry}` })
            .pipe(
              Effect.tap((response) =>
                Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(422)),
              ),
              Effect.flatMap((response) => body(Rejected, response)),
            );
        expect((yield* install(catalogFixture.mailGraphql.id)).code).toBe("agent_setup_required");
        expect((yield* install("fixture/not-listed")).code).toBe("entry_missing");
        expect(yield* feed.fetches, "reads and installs reuse the kept catalog").toBe(1);

        const deployed = yield* api.request(owner, "POST", `${prefix}/apps/deploy`, {
          name: catalogFixture.mail.name,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, router } from "apps";
export default defineApp({ accounts: {} }, async () => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
}));
`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);

        const reads = { catalog: 0, icons: 0 };
        const logos: string[] = [];
        const observe = (page: Page) => {
          page.on("request", (request) => {
            const url = new URL(request.url());
            if (url.origin !== origin) return;
            const kinds =
              request.method() === "POST" && url.pathname === batchPath
                ? batchedReads(request.postData()).flatMap((read) => classifyRead(read) ?? [])
                : request.method() === "GET"
                  ? [classifyPath(url.pathname)].flatMap((kind) => kind ?? [])
                  : [];
            for (const kind of kinds) reads[kind] += 1;
          });
          return page.route("https://integrations.sh/logo/**", (route) => {
            logos.push(route.request().url());
            return route.fulfill({ status: 200, contentType: "image/png", body: logo });
          });
        };
        const appLogo = `https://integrations.sh/logo/acme-mail.example?sz=34`;

        yield* browser.login(owner);
        yield* browser.use("Observe catalog reads and serve logos locally", observe);
        yield* browser.use("Open Apps", (page) =>
          page.goto(`${origin}/org/${organization.slug}/apps`),
        );
        yield* browser.use("The app shows its catalog logo", (page) =>
          page
            .getByRole("link", { name: new RegExp(`^Open ${catalogFixture.mail.name}`) })
            .locator(`img[src="${appLogo}"]`)
            .waitFor(),
        );
        yield* browser.use("Open the app", (page) =>
          page.goto(`${origin}/org/${organization.slug}/apps/${app.id}`),
        );
        yield* browser.use("The app page shows its catalog logo", (page) =>
          page
            .locator(`img[src^="https://integrations.sh/logo/acme-mail.example"]`)
            .first()
            .waitFor(),
        );
        yield* browser.use("Open Accounts", (page) =>
          page.goto(`${origin}/org/${organization.slug}/accounts`),
        );
        yield* browser.use("Accounts has loaded", (page) =>
          page.getByText("Saved sign-ins, available to your apps.", { exact: true }).waitFor(),
        );
        expect(reads.icons, "logo pages read the icon list").toBeGreaterThan(0);
        expect(reads.catalog, "logo pages never download the full catalog").toBe(0);
        expect(logos).toContain(appLogo);

        yield* browser.use("Open Add app", (page) =>
          page.goto(`${origin}/org/${organization.slug}/apps/add`),
        );
        yield* browser.use("Search the catalog", (page) =>
          page.getByPlaceholder("Search apps…").fill("twin"),
        );
        yield* browser.use("The catalog lists the feed's entries", (page) =>
          page.getByRole("button", { name: /Twin/ }).first().waitFor(),
        );
        expect(reads.catalog, "the add-app page reads the full catalog").toBeGreaterThan(0);
        expect(yield* feed.fetches, "every page shares the kept catalog").toBe(1);

        const catalogIds = api.request(owner, "GET", "/api/catalog").pipe(
          Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
          Effect.flatMap((response) => body(Entries, response)),
          Effect.map((entries) => entries.map(({ id }) => id)),
        );
        const poll = { schedule: Schedule.spaced("100 millis"), times: 100 } as const;
        /** Reads until the catalog lists `revision`, which only a completed refresh brings. */
        const awaitRevision = (revision: number) =>
          catalogIds.pipe(
            Effect.filterOrFail(
              (ids) => ids.includes(catalogRevision(revision).id),
              () => `No refresh brought feed revision ${revision}`,
            ),
            Effect.retry(poll),
          );
        /** Waits until the feed has answered `count` fetches, then checks none other started. */
        const awaitAnswered = (count: number) =>
          Effect.gen(function* () {
            yield* feed.answered.pipe(
              Effect.filterOrFail(
                (answered) => answered >= count,
                () => `The feed never answered fetch ${count}`,
              ),
              Effect.retry(poll),
            );
            expect(yield* feed.fetches).toBe(count);
          });
        const pastFresh = freshness.fresh + minute;

        // Once stale, a read answers from the kept copy at once and one refresh runs beside it.
        yield* feed.publish([...Object.values(catalogFixture), catalogRevision(2)]);
        yield* advanceClock(pastFresh);
        expect(yield* catalogIds, "a stale read answers from the kept copy").not.toContain(
          catalogRevision(2).id,
        );
        yield* awaitRevision(2);
        yield* awaitAnswered(2);

        // A refresh that fails keeps the stale copy in service.
        yield* feed.fail;
        yield* advanceClock(pastFresh);
        expect(yield* catalogIds).toContain(catalogRevision(2).id);
        yield* awaitAnswered(3);
        // Reads within the retry backoff do not fetch again, and keep answering from the copy.
        for (let read = 0; read < 3; read += 1)
          expect(yield* catalogIds, "a failed refresh keeps the stale copy").toContain(
            catalogRevision(2).id,
          );
        yield* Effect.sleep("1 second");
        expect(yield* feed.fetches, "the backoff holds back another refresh").toBe(3);

        // After the backoff, a read retries the refresh.
        yield* feed.publish([...Object.values(catalogFixture), catalogRevision(3)]);
        yield* advanceClock(freshness.retry + 1_000);
        expect(yield* catalogIds).toContain(catalogRevision(2).id);
        yield* awaitRevision(3);
        yield* awaitAnswered(4);

        // Past the maximum age, a read waits for the feed instead of serving the old copy.
        yield* feed.fail;
        yield* advanceClock(freshness.maxStale + minute);
        const expired = yield* api.request(owner, "GET", "/api/catalog");
        expect(expired.status, "an expired copy is never served").toBe(502);
        expect(yield* feed.fetches).toBe(5);
        yield* feed.publish([...Object.values(catalogFixture), catalogRevision(4)]);
        expect(yield* catalogIds, "the read waits for the feed").toContain(catalogRevision(4).id);
        expect(yield* feed.fetches).toBe(6);
      }),
    ),
  );
});
