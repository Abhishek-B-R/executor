/**
 * An MCP tool call sends its checks and every read it makes for them together, in one batch: the
 * bearer recheck first, then the access check, the app, profile and accounts, the profile recheck
 * and the grants of OAuth accounts, in one snapshot. The access check and the account reads need
 * the profile's accounts before the profile is read, so they name those of the profile the
 * session's last call read; the same batch reads the profile live, and a call whose profile
 * changed since sends the reads once more with the live one. Every check still runs on every call
 * against live rows; the batch decides nothing a separate read would not.
 *
 * Self-host runs the batch under the PGlite client's lock, as Cloud runs it in one socket write
 * (see `cloud-tool-call-batch.spec.ts`). Each batch is one `sql.pipeline` span.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile, Profile, selectProfileAccounts } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const keySource = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Batch fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async ctx => ({
  tools: router({
    token: query({ input: object({}), output: string() }, async () => ctx.accounts.service.fields.token),
  }),
}));`;

const oauthSource = (
  discover: string,
) => `import { defineApp, defineProvider, oauth2, object, string, query, router } from "apps";
const service = defineProvider({ name: "OAuth batch fixture", auth: {
  oauth: oauth2({ discover: ${JSON.stringify(discover)} })
} });
export default defineApp({ accounts: { service } }, async ctx => ({
  tools: router({
    token: query({ input: object({}), output: string() }, async () => ctx.accounts.service.fields.access_token),
  }),
}));`;

const accountlessSource = `import { defineApp, object, string, query, router } from "apps";
export default defineApp({ accounts: {} }, {
  tools: router({ token: query({ input: object({}), output: string() }, async () => "synthetic-accountless") }),
});`;

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
});

/** What one MCP tool call did before its app ran. */
interface CallTrace {
  /** `sql.pipeline` spans: each batch the call sent. */
  readonly batches: number;
  /** `sql.execute` spans outside the app's runtime. */
  readonly statements: number;
  /** Grant reads the resolve loop made itself, after the batch. */
  readonly liveGrantReads: number;
  readonly texts: ReadonlyArray<string>;
}

layer(HostedLive, { excludeTestServices: true })("Tool call batch", (it) => {
  it.effect(scenarios.toolCallBatch.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          mcp = yield* McpClient,
          http = yield* HttpClient.HttpClient,
          issuer = yield* oauthSetupIssuer;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            accounts,
            (account) => api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`),
            { discard: true },
          ).pipe(Effect.orDie),
        );
        const deploy = (name: string, source: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content: source }, appsManifest],
            });
            expect(deployed.status).toBe(200);
            const app = yield* body(App, deployed);
            const path = `${prefix}/apps/${app.id}`;
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
            );
            return { app, path, profile: yield* createProfile(actors.owner, path) };
          });
        const connection = (path: string, profile: string) =>
          api
            .request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile,
            })
            .pipe(Effect.flatMap((pending) => body(Resource, pending)));
        const keyAccount = (path: string, profile: string, token: string) =>
          Effect.gen(function* () {
            const pending = yield* connection(path, profile);
            const saved = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${pending.id}/submit`,
                {
                  method: "key",
                  label: "Synthetic",
                  fields: { token },
                },
              ),
            );
            accounts.push(saved.id);
            return saved.id;
          });
        // Saving a profile wakes its setup after the response, and setup writes the profile again
        // when it finishes. A call made before that write reads it as a changed profile and sends
        // its reads once more, so each change is settled before a call: reconciled at the current
        // revision, after which nothing writes the profile.
        const settled = Schema.Struct({
          revision: Schema.Number,
          status: Schema.String,
          reconciledRevision: Schema.NullOr(Schema.Number),
        });
        const settling: Record<string, Array<typeof settled.Type>> = {};
        const settle = (path: string, profile: string, status: "ready" | "disabled") => {
          const attempts: Array<typeof settled.Type> = [];
          return Effect.gen(function* () {
            for (;;) {
              const reconciled = yield* api.request(
                actors.owner,
                "POST",
                `${path}/profiles/${profile}/reconcile`,
              );
              expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);
              const current = yield* body(settled, reconciled);
              attempts.push(current);
              if (current.status === status && current.reconciledRevision === current.revision)
                return;
              yield* Effect.sleep("100 millis");
            }
          }).pipe(
            Effect.timeout("30 seconds"),
            Effect.ensuring(
              Effect.suspend(() => {
                (settling[profile] ??= []).push(...attempts);
                return evidence.json("batch-settled.json", settling);
              }),
            ),
          );
        };
        const select = (path: string, profile: string, account: string) =>
          Effect.gen(function* () {
            expect(
              (yield* selectProfileAccounts(actors.owner, path, profile, { service: account }))
                .status,
            ).toBe(200);
            yield* settle(path, profile, "ready");
          });
        const setEnabled = (path: string, profile: string, enabled: boolean) =>
          Effect.gen(function* () {
            const saved = yield* body(
              Profile,
              yield* api.request(actors.owner, "GET", `${path}/profiles/${profile}`),
            );
            const changed = yield* api.request(
              actors.owner,
              "PATCH",
              `${path}/profiles/${profile}/enabled`,
              { expectedRevision: saved.revision, enabled },
            );
            expect(changed.status, JSON.stringify(changed.body)).toBe(200);
            yield* settle(path, profile, enabled ? "ready" : "disabled");
          });

        const key = yield* deploy("Batch key", keySource);
        yield* select(
          key.path,
          key.profile.id,
          yield* keyAccount(key.path, key.profile.id, "synthetic-first"),
        );

        /** An app whose profile selects one OAuth account, signed in through the issuer. */
        const oauthApp = (name: string) =>
          Effect.gen(function* () {
            const deployed = yield* deploy(name, oauthSource(`${issuer.origin}/mcp`));
            const pending = yield* connection(deployed.path, deployed.profile.id);
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${pending.id}/oauth/start`,
              { method: "oauth", label: "Synthetic OAuth" },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const { authorizationUrl } = yield* body(SignIn, started);
            const callbackUrl = yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
                expect(consent.status).toBe(302);
                const location = consent.headers.location;
                if (location === undefined)
                  return yield* Effect.die("Issuer did not return a callback");
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${pending.id}/oauth/complete`,
              { callbackUrl },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            const account = (yield* body(Resource, completed)).id;
            accounts.push(account);
            yield* select(deployed.path, deployed.profile.id, account);
            return deployed;
          });
        const oauth = yield* oauthApp("Batch OAuth");
        const accountless = yield* deploy("Batch accountless", accountlessSource);
        yield* settle(accountless.path, accountless.profile.id, "ready");

        const token = (name: string) =>
          Effect.gen(function* () {
            const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
              name,
            });
            expect(created.status).toBe(200);
            const pat = yield* body(Token, created);
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: pat.id })
                .pipe(Effect.orDie),
            );
            return pat;
          });
        const first = yield* mcp.connect((yield* token("Batch")).key, "batch", { organization });
        const second = yield* mcp.connect((yield* token("Batch sibling")).key, "batch-sibling", {
          organization,
        });
        type Client = typeof first;

        /** Run one execute that calls the target's tool through its profile; return what it did. */
        const call = (
          client: Client,
          target: { readonly app: typeof App.Type; readonly profile: typeof Profile.Type },
          operation: string,
        ) =>
          Effect.gen(function* () {
            const code = `return await tools[${JSON.stringify(target.app.slug)}].profiles[${JSON.stringify(target.profile.id)}].token({})`;
            const result = yield* client.use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
            const { execution } = yield* Schema.decodeUnknownEffect(Execution)(
              result.structuredContent,
            );
            const request = (yield* evidence.requests)
              .filter((request) => request.path === "/mcp")
              .at(-1);
            if (request === undefined) return yield* Effect.die("MCP request evidence missing");
            const trace = yield* traceOf(request.traceId);
            return { execution, trace };
          });
        /** The last MCP tool call of a trace, once its whole trace has reached Motel. */
        const traceOf = (traceId: string) =>
          telemetry.query(traceId).pipe(
            Effect.flatMap((result) => {
              const root = result.data
                .filter((entry) => entry.span.operationName === "mcp.tool.call")
                .toSorted((a, b) => Date.parse(a.span.startTime) - Date.parse(b.span.startTime))
                .at(-1);
              const complete = result.data.some(
                (entry) => entry.span.tags["http.response.status_code"] === "200",
              );
              if (root === undefined || !complete)
                return Effect.fail(new Error("The completed server trace must reach Motel"));
              const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
              /** The span names between a span and the tool call, or undefined outside it. */
              const path = (spanId: string | null) => {
                const names: string[] = [];
                const visited = new Set<string>();
                let parent = spanId;
                while (parent !== null && !visited.has(parent)) {
                  if (parent === root.span.spanId) return names;
                  visited.add(parent);
                  const span = byId.get(parent);
                  names.push(span?.operationName ?? "");
                  parent = span?.parentSpanId ?? null;
                }
                return undefined;
              };
              const inside = result.data.filter(({ span }) => {
                const names = path(span.parentSpanId);
                return names !== undefined && !names.some((name) => name.startsWith("runtime."));
              });
              const statements = inside.filter(({ span }) => span.operationName === "sql.execute");
              const texts = statements.map(({ span }) =>
                String(span.tags["db.query.text"] ?? "")
                  .replace(/\s+/g, " ")
                  .slice(0, 80),
              );
              return statements.length === 0
                ? Effect.fail(new Error("The tool call's statements must reach Motel"))
                : Effect.succeed({
                    batches: inside.filter(({ span }) => span.operationName === "sql.pipeline")
                      .length,
                    statements: statements.length,
                    liveGrantReads: statements.filter(
                      ({ span }) =>
                        String(span.tags["db.query.text"] ?? "").includes(
                          "executor_oauth_grants",
                        ) && (path(span.parentSpanId) ?? []).includes("sdk.accounts.resolve"),
                    ).length,
                    texts,
                  } satisfies CallTrace);
            }),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
            Effect.timeout("25 seconds"),
          );
        const recorded: Record<string, CallTrace> = {};
        const expectCall = (
          label: string,
          made: { readonly execution: typeof Execution.Type.execution; readonly trace: CallTrace },
          expected: {
            readonly value: string;
            readonly batches: number;
            readonly statements?: number;
          },
        ) =>
          Effect.sync(() => {
            recorded[label] = made.trace;
            expect(made.execution, label).toEqual({ ok: true, value: expected.value });
            expect(made.trace.batches, `${label}: batches`).toBe(expected.batches);
            if (expected.statements !== undefined)
              expect(made.trace.statements, `${label}: statements`).toBe(expected.statements);
          });

        yield* evidence.step(
          "A session's first call for a profile reads it, then sends its reads with it; later calls send one batch",
          Effect.gen(function* () {
            // First calls: the recheck with the app and profile, then the rest with the profile
            // read: as many statements as reading one after another.
            yield* expectCall("key, first", yield* call(first, key, "Key account, first call"), {
              value: "synthetic-first",
              batches: 2,
              statements: 8,
            });
            yield* expectCall("key, warm", yield* call(first, key, "Key account, warm call"), {
              value: "synthetic-first",
              batches: 1,
              // Recheck, app, profile, accounts, profile recheck, access check; no grant read.
              statements: 6,
            });
            const oauthFirst = yield* call(first, oauth, "OAuth account, first call");
            recorded["oauth, first"] = oauthFirst.trace;
            expect(oauthFirst.trace.batches, "OAuth account, first call").toBe(2);
            expect(oauthFirst.trace.statements, "OAuth account, first call").toBe(9);
            const oauthWarm = yield* call(first, oauth, "OAuth account, warm call");
            recorded["oauth, warm"] = oauthWarm.trace;
            expect(oauthWarm.trace.batches, "OAuth account, warm call").toBe(1);
            // The key account's six and its grant, read in the batch rather than after it.
            expect(oauthWarm.trace.statements).toBe(7);
            expect(oauthWarm.trace.liveGrantReads).toBe(0);
            yield* expectCall(
              "accountless, first",
              yield* call(first, accountless, "No accounts, first call"),
              { value: "synthetic-accountless", batches: 2, statements: 7 },
            );
            yield* expectCall(
              "accountless, warm",
              yield* call(first, accountless, "No accounts, warm call"),
              { value: "synthetic-accountless", batches: 1, statements: 5 },
            );
          }),
        );

        yield* evidence.step(
          "Another account selected between calls is read with the live profile, in one more batch",
          Effect.gen(function* () {
            const other = yield* keyAccount(key.path, key.profile.id, "synthetic-other");
            yield* select(key.path, key.profile.id, other);
            yield* expectCall("key, switched", yield* call(first, key, "Call after a switch"), {
              value: "synthetic-other",
              batches: 2,
            });
            yield* expectCall(
              "key, warm after a switch",
              yield* call(first, key, "Warm after a switch"),
              {
                value: "synthetic-other",
                batches: 1,
                statements: 6,
              },
            );
          }),
        );

        yield* evidence.step(
          "A disabled profile refuses the call, and the call after it is enabled reads it again",
          Effect.gen(function* () {
            yield* setEnabled(key.path, key.profile.id, false);
            const code = `return await tools[${JSON.stringify(key.app.slug)}].profiles[${JSON.stringify(key.profile.id)}].token({})`;
            const refused = yield* first
              .use("Call a disabled profile", (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Execution)(result.structuredContent),
                ),
              );
            yield* evidence.json("batch-disabled.json", refused);
            expect(refused.execution.ok, "A disabled profile").toBe(false);
            yield* setEnabled(key.path, key.profile.id, true);
            yield* expectCall("key, enabled", yield* call(first, key, "Call once enabled"), {
              value: "synthetic-other",
              batches: 2,
            });
            yield* expectCall(
              "key, warm once enabled",
              yield* call(first, key, "Warm once enabled"),
              {
                value: "synthetic-other",
                batches: 1,
                statements: 6,
              },
            );
          }),
        );

        yield* evidence.step(
          "A call whose batch read a grant another session is renewing waits for that renewal and uses its token",
          Effect.gen(function* () {
            // Its grants last 31 s, so each is inside the 30 s renewal window after a second.
            yield* issuer.configure({ refreshTokens: true, expiresIn: 31, refreshedExpiresIn: 31 });
            const renewing = yield* oauthApp("Batch OAuth renewal");
            // The sibling session is warm: its batch reads the account's grant. Its first call for
            // the profile reads it, then sends its reads with it.
            for (const [label, batches] of [
              ["Sibling session, first call", 2],
              ["Sibling session, warm call", 1],
            ] as const) {
              const made = yield* call(second, renewing, label);
              recorded[label] = made.trace;
              expect(made.execution.ok, label).toBe(true);
              expect(made.trace.batches, label).toBe(batches);
            }
            // Hold the next renewal after the service issued its tokens, and let the current grant
            // reach its renewal window.
            yield* issuer.configure({ hold: "refresh-issued" });
            yield* Effect.sleep("1500 millis");
            const before = yield* issuer.metrics;
            const renewal = yield* Effect.forkChild(call(first, renewing, "Renew the grant"));
            yield* issuer.metrics.pipe(
              Effect.flatMap((metrics) =>
                metrics.held > before.held
                  ? Effect.void
                  : Effect.fail(new Error("The renewal has not reached the service")),
              ),
              Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
            );
            // The renewal holds the grant's claim. The sibling's batch reads the claimed row.
            const waiting = yield* Effect.forkChild(
              call(second, renewing, "Call during the renewal"),
            );
            yield* Effect.sleep("1500 millis");
            yield* issuer.configure({ hold: null });
            yield* issuer.release;
            const renewed = yield* Fiber.join(renewal);
            const waited = yield* Fiber.join(waiting);
            const after = yield* issuer.metrics;
            recorded["oauth, renewing"] = renewed.trace;
            recorded["oauth, waited"] = waited.trace;
            yield* evidence.json("batch-renewal.json", {
              renewed: renewed.execution,
              waited: waited.execution,
              refreshes: after.refreshesIssued - before.refreshesIssued,
            });
            expect(after.refreshesIssued - before.refreshesIssued, "One renewal").toBe(1);
            expect(renewed.execution).toEqual({
              ok: true,
              value: `synthetic-refreshed-token-${after.refreshes}`,
            });
            expect(waited.execution, "The waiting call uses the renewed token").toEqual(
              renewed.execution,
            );
            expect(waited.trace.batches, "The waiting call sent one batch").toBe(1);
            expect(
              waited.trace.liveGrantReads,
              "It read the grant again after the claim it read in its batch",
            ).toBeGreaterThan(0);
          }),
        );
        yield* evidence.json("tool-call-batch.json", recorded);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
