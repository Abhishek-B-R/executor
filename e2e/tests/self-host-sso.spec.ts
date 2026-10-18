/**
 * Self-host SSO against an OpenID provider whose ID token carries `sub` and `email` but not
 * `email_verified`, which it asserts only at UserInfo, as Okta's org authorization server does.
 * OIDC allows this for the authorization code flow. A UserInfo answer for another subject must not
 * verify the email.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startControlledSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { selfHostSsoIdp } from "../support/sso.ts";
import { scenarios } from "../test-plan.ts";

const Session = Schema.NullOr(
  Schema.Struct({ user: Schema.Struct({ email: Schema.String, emailVerified: Schema.Boolean }) }),
);

layer(TestLive, { excludeTestServices: true })("Self-host SSO", (it) => {
  it.effect(scenarios.selfHostSsoUserinfoClaims.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          target = yield* Target;
        const instance = yield* startControlledSelfHost(target);
        const origin = instance.metadata.origin;
        const idp = yield* selfHostSsoIdp(origin);
        // The operator turns SSO on once the instance's origin is known.
        yield* Effect.gen(function* () {
          yield* serverControl("stop");
          yield* serverControl("environment", 200, {
            SSO_DISCOVERY_URL: idp.discoveryUrl,
            SSO_CLIENT_ID: "synthetic-sso-client",
            SSO_CLIENT_SECRET: "synthetic-sso-secret",
            SSO_ALLOWED_DOMAINS: "sso.example.test",
            NODE_EXTRA_CA_CERTS: idp.certificate,
          });
          yield* serverControl("start");
        }).pipe(Effect.provideService(Target, instance));
        expect(
          yield* browser.use("Set up the instance", (page) =>
            page
              .context()
              .request.post(`${origin}/api/auth/self-host/setup`, {
                headers: { origin },
                data: {
                  name: "Synthetic Owner",
                  email: "owner@sso.example.test",
                  password: "Synthetic-e2e-password-2026",
                  organizationName: "Synthetic SSO",
                },
              })
              .then((response) => response.status()),
          ),
        ).toBe(200);

        const session = browser
          .use("Read the session", (page) =>
            page
              .context()
              .request.get(`${origin}/api/auth/get-session`)
              .then((response) => response.json()),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session)));
        const continueWithSso = (title: string) =>
          Effect.gen(function* () {
            yield* browser.use(`${title}: sign out`, (page) => page.context().clearCookies());
            yield* browser.use(`${title}: open sign-in`, (page) => page.goto(`${origin}/login`));
            yield* browser.use(`${title}: continue with SSO`, (page) =>
              page.getByRole("button", { name: "Continue with SSO", exact: true }).click(),
            );
          });

        yield* idp.configure("other-subject@sso.example.test", "userinfo-other-subject");
        yield* continueWithSso("UserInfo for another subject");
        yield* browser.use("Sign-in returns from the provider", (page) =>
          page.waitForURL(`${origin}/api/auth/callback/sso?**`),
        );
        yield* browser.checkpoint("SSO refused when UserInfo names another subject");
        expect(yield* session).toBeNull();

        yield* idp.configure("member@sso.example.test", "userinfo-verified");
        yield* continueWithSso("Email verified only at UserInfo");
        yield* browser.use("The member leaves sign-in", (page) =>
          page.waitForURL(
            (url) =>
              url.origin === origin &&
              !url.pathname.startsWith("/login") &&
              !url.pathname.startsWith("/api/"),
          ),
        );
        expect(yield* session).toEqual({
          user: expect.objectContaining({ email: "member@sso.example.test", emailVerified: true }),
        });
        yield* browser.checkpoint("SSO member admitted from UserInfo's email_verified");
      }),
    ),
  );
});
