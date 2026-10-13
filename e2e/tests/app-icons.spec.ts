/** Apps declare their icons on defineApp; the build records them and the dashboard shows them. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { appsManifest } from "../support/apps-release.ts";

const Icons = Schema.Array(
  Schema.Struct({
    src: Schema.String,
    mimeType: Schema.optional(Schema.String),
    theme: Schema.optional(Schema.String),
  }),
);
const IconApp = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  requirements: Schema.Struct({ icons: Schema.optional(Icons) }),
});
const Inventory = Schema.Struct({ apps: Schema.Array(IconApp) });
const BuildFailed = Schema.Struct({
  _tag: Schema.Literal("DeploymentBuildFailed"),
  stage: Schema.String,
  message: Schema.String,
});

const svg = (fill: string) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${fill}"/></svg>`,
  ).toString("base64")}`;

/** An app declaring these icons beside its accounts. */
const source = (icons: unknown) => `import { defineApp, object, query, router } from "apps";
export default defineApp({ accounts: {}, icons: ${JSON.stringify(icons)} }, async () => ({
  tools: router({ status: query({ input: object({}) }, async () => "ready") }),
}));`;

layer(HostedLive, { excludeTestServices: true })("App icons", (it) => {
  it.effect(scenarios.appIcons.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deploy = (name: string, icons: unknown) =>
          api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name,
            files: [{ path: "index.ts", content: source(icons) }, appsManifest],
          });

        // A source the dashboard must never load fails the build at its declaration stage.
        const refused = yield* deploy(`Unsafe icon ${randomUUID().slice(0, 8)}`, [
          { src: "javascript:alert(1)", theme: "light" },
        ]);
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        const failure = yield* body(BuildFailed, refused);
        expect(failure.stage).toBe("declaration");
        expect(failure.message).toContain("The app's icons are invalid");
        expect(failure.message).toContain("icons[0].src must be a base64 data:image/svg+xml");

        const light = svg("#1d4ed8");
        const dark = svg("#facc15");
        const icons = [
          { src: light, mimeType: "image/svg+xml", theme: "light" },
          { src: dark, mimeType: "image/svg+xml", theme: "dark" },
        ];
        const name = `Icons ${randomUUID().slice(0, 8)}`;
        const deployed = yield* deploy(name, icons);
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(IconApp, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        // The build recorded the icons with the deployment: the app and the inventory carry them
        // at once, before anything evaluated the app or listed its tools.
        expect(app.requirements.icons).toEqual(icons);
        const read = yield* body(IconApp, yield* api.request(actors.owner, "GET", path));
        expect(read.requirements.icons).toEqual(icons);
        const inventory = yield* body(
          Inventory,
          yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
        );
        expect(inventory.apps.find((item) => item.id === app.id)?.requirements.icons).toEqual(
          icons,
        );

        // The dashboard loads the variant made for the current color scheme.
        yield* browser.login(actors.owner);
        /** The loaded source once it is the expected one, or whatever loaded instead. */
        const shown = (step: string, find: (page: Page) => Locator, expected: string) =>
          browser.use(step, (page) => {
            const image = find(page).locator('img[data-icon="app"]');
            const current = () =>
              image.evaluate((element) =>
                element instanceof HTMLImageElement && element.complete ? element.currentSrc : "",
              );
            return image
              .waitFor({ state: "visible" })
              .then(() => image.elementHandle())
              .then((handle) =>
                page.waitForFunction(
                  ([element, want]) =>
                    element instanceof HTMLImageElement &&
                    element.complete &&
                    element.currentSrc === want,
                  [handle, expected] as const,
                  { timeout: 10_000 },
                ),
              )
              .then(current, current);
          });
        const card = (page: Page) => page.getByRole("link", { name: `Open ${name}`, exact: true });
        yield* browser.use("Open the apps list", (page) =>
          page
            .emulateMedia({ colorScheme: "light" })
            .then(() => page.goto(`/org/${actors.organization.slug}/apps`)),
        );
        expect(yield* shown("The app card shows its light icon", card, light)).toBe(light);
        yield* browser.checkpoint("App card with its light icon");
        yield* browser.use("Use dark theme", (page) => page.emulateMedia({ colorScheme: "dark" }));
        expect(yield* shown("The app card shows its dark icon", card, dark)).toBe(dark);
        yield* browser.checkpoint("App card with its dark icon");
        yield* browser.use("Open the app", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}`),
        );
        const heading = (page: Page) =>
          page.locator("header", {
            has: page.getByRole("heading", { level: 1, name }),
          });
        expect(yield* shown("The app page heading shows its icon", heading, dark)).toBe(dark);
        yield* browser.checkpoint("App heading with its dark icon");
      }),
    ),
  );
});
