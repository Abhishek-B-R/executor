/**
 * An MCP tool call sends its checks and the reads they and the call need together, in one batch,
 * once its per-call recheck of the bearer token can run: the recheck first, then the access
 * check and the call's reads of the app, profile and accounts, with the profile recheck, in one
 * snapshot taken after the token recheck. Each batch is one database round trip from Cloud's
 * session object.
 *
 * Batching changes no outcome. Nothing read is used until the token recheck passes: a call whose
 * token is revoked while that recheck waits is refused for its token, as before, even when its
 * app was deleted first, so the reads made beside the recheck were refused too. A change saved
 * while any of the call's checks waits takes effect on the call: a profile disabled, an account
 * reconnected, or another account selected. The access check held is the call's own, not
 * discovery's. A batch with a read that fails for storage is discarded: the call reads again on
 * its own, in order, and runs.
 * The self-host test entry point holds those two statements, so the scenario runs its own
 * development server, with its own trace collector.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Layer, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, SessionClients } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { Profile } from "../support/profiles.ts";
import { throttlingCollector } from "../support/throttling-collector.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Read ahead fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async ctx => ({
  tools: router({
    token: query({ input: object({}), output: string() }, async () => ctx.accounts.service.fields.token),
  }),
}));`;
/** An app without accounts, called through a profile that selects none. */
const freeSource = `import { defineApp, object, string, query, router } from "apps";
export default defineApp({ accounts: {} }, { tools: router({
  ping: query({ input: object({}), output: string() }, async () => "pong"),
}) });`;

/** The self-host test host's statement hold; see `apps/hosted/testing/statement-hold-fixture.ts`. */
const statementHold = "/api/devtools/statement-hold";
const Held = Schema.Struct({ held: Schema.Boolean });
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));
const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Execution = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
});

/** One statement of the tool call, with the spans it ran under. */
interface Statement {
  readonly text: string;
  readonly under: ReadonlyArray<string>;
  readonly start: number;
  readonly end: number;
}
/** A `sql.pipeline` span, recorded among the statements: one batch the call sent. */
const batchMarker = "sql.pipeline";
const isBatch = (statement: Statement) => statement.text === batchMarker;
const isPatCheck = (statement: Statement) => statement.text.includes("from apikey where key");
const isAccessCheck = (statement: Statement) =>
  statement.text.includes("left join hosted_app_access p on p.id =");
/** The access check's reads of the app and profile, made outside the SDK's tool call. */
const isSelectionRead = (statement: Statement) =>
  statement.under.includes("FumaDB.SqlQuery.findFirst") &&
  !statement.under.includes("sdk.tools.call");
/** The call's own reads of the app, profile and accounts, and its profile recheck. */
const isCallRead = (statement: Statement) => statement.under.includes("sdk.invocation.snapshot");

layer(HostedLive, { excludeTestServices: true })("Tool call read ahead", (it) => {
  it.effect(scenarios.toolCallReadAhead.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          evidence = yield* Evidence,
          collector = yield* throttlingCollector;
        // Only the test entry point mounts the statement hold.
        const origin = yield* startDevelopmentServer(target, {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
        });
        const development = { ...target, metadata: { ...target.metadata, origin } };
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, development),
        );
        const mcp = yield* McpClient.pipe(
          Effect.provide(Layer.fresh(McpClient.layer)),
          Effect.provideService(Target, development),
        );
        const owner = yield* api.session(),
          headers = { origin };
        const send = (
          method: "GET" | "POST" | "PATCH" | "DELETE",
          path: string,
          payload?: unknown,
        ) => api.request(owner, method, `${origin}${path}`, payload, headers);
        expect((yield* send("POST", "/api/devtools/operator", {})).status).toBe(200);
        const directory = yield* body(Users, yield* send("GET", "/api/auth/admin/list-users"));
        const developer = directory.users.find((user) => user.email === "agent-agent@example.test");
        if (!developer) return yield* Effect.die("Development owner is missing");
        expect(
          (yield* send("POST", "/api/auth/admin/impersonate-user", { userId: developer.id }))
            .status,
        ).toBe(200);
        const organization = (yield* body(
          Organizations,
          yield* send("GET", "/api/auth/organization/list"),
        ))[0];
        if (!organization) return yield* Effect.die("Development organization is missing");
        const prefix = `/api/organizations/${organization.id}`;
        // A failed assertion must not leave a statement held.
        yield* Effect.addFinalizer(() => send("DELETE", statementHold).pipe(Effect.orDie));

        const deployed = yield* send("POST", `${prefix}/apps/deploy`, {
          name: `Read ahead ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() => send("DELETE", path).pipe(Effect.orDie));
        const profile = yield* body(
          Profile,
          yield* send("POST", `${path}/profiles`, { accounts: {}, idempotencyKey: randomUUID() }),
        );
        const connect = (
          account?: string,
          token = account === undefined ? "synthetic-before" : "synthetic-after",
        ) =>
          Effect.gen(function* () {
            const pending = yield* body(
              Resource,
              yield* send("POST", `${path}/connections`, {
                requirement: "service",
                profile: profile.id,
                ...(account === undefined ? {} : { account }),
              }),
            );
            return yield* body(
              Resource,
              yield* send("POST", `${prefix}/connections/${pending.id}/submit`, {
                method: "key",
                label: "Synthetic",
                fields: { token },
              }),
            );
          });
        const account = (yield* connect()).id;
        yield* Effect.addFinalizer(() =>
          send("DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
        );
        const select = (selected: string) =>
          Effect.gen(function* () {
            const saved = yield* body(
              Profile,
              yield* send("GET", `${path}/profiles/${profile.id}`),
            );
            const changed = yield* send("PATCH", `${path}/profiles/${profile.id}`, {
              expectedRevision: saved.revision,
              accounts: { service: selected },
            });
            expect(changed.status, JSON.stringify(changed.body)).toBe(200);
          });
        yield* select(account);
        const disable = Effect.gen(function* () {
          const saved = yield* body(Profile, yield* send("GET", `${path}/profiles/${profile.id}`));
          const disabled = yield* send("PATCH", `${path}/profiles/${profile.id}/enabled`, {
            expectedRevision: saved.revision,
            enabled: false,
          });
          expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
        });
        const enable = Effect.gen(function* () {
          const saved = yield* body(Profile, yield* send("GET", `${path}/profiles/${profile.id}`));
          expect(
            (yield* send("PATCH", `${path}/profiles/${profile.id}/enabled`, {
              expectedRevision: saved.revision,
              enabled: true,
            })).status,
          ).toBe(200);
        });

        const token = (name: string) =>
          Effect.gen(function* () {
            const created = yield* send("POST", "/api/auth/api-key/create", { name });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const key = yield* body(Token, created);
            yield* Effect.addFinalizer(() =>
              send("POST", "/api/auth/api-key/delete", { keyId: key.id }).pipe(Effect.ignore),
            );
            return key;
          });
        const code = `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].token({})`;
        const executeWith = (client: Effect.Success<ReturnType<typeof mcp.connect>>, run = code) =>
          client
            .use("Call the profile's tool through execute", (client, signal) =>
              client.callTool({ name: "execute", arguments: { code: run } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Execution)(result.structuredContent),
              ),
              Effect.map(({ execution }) => execution),
            );
        /** Arm the hold, which releases any statement held before, for the next statement `arm` names. */
        const arm = (statement: unknown) =>
          Effect.gen(function* () {
            expect((yield* send("POST", statementHold, statement)).status).toBe(200);
          });
        /** Wait until the armed statement is held. */
        const reached = send("GET", statementHold).pipe(
          Effect.flatMap((response) => body(Held, response)),
          Effect.flatMap((state) =>
            state.held ? Effect.void : Effect.fail(new Error("The statement was not held")),
          ),
          Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
        );
        /** Hold the statement `statement` names, change saved state meanwhile, then release it. */
        const held = <A, E, R, E2, R2>(
          statement: unknown,
          call: Effect.Effect<A, E, R>,
          meanwhile: Effect.Effect<unknown, E2, R2>,
        ) =>
          Effect.gen(function* () {
            yield* arm(statement);
            const fiber = yield* Effect.forkChild(call);
            yield* reached;
            yield* meanwhile;
            yield* send("DELETE", statementHold);
            return yield* Fiber.join(fiber);
          });
        /** The SQL statements the last MCP request's last tool call made, in start order. */
        const statements = Effect.gen(function* () {
          const request = (yield* evidence.requests)
            .filter((request) => request.path === "/mcp")
            .at(-1);
          if (request === undefined) return yield* Effect.die("MCP request evidence missing");
          return yield* collector.query(request.traceId).pipe(
            Effect.flatMap((result) => {
              const byId = new Map(result.data.map(({ span }) => [span.spanId, span]));
              // The request's server span ends after every tool call the request ran, so it
              // leaves in the same export as the last one or a later one. Until it arrives, the
              // latest tool call here may be an earlier call of the same request.
              const served = result.data.some(
                ({ span }) =>
                  span.operationName.startsWith("http.server") && span.tags["url.path"] === "/mcp",
              );
              if (!served)
                return Effect.fail(new Error("The MCP request's server span must reach Motel"));
              const root = result.data
                .filter(({ span }) => span.operationName === "mcp.tool.call")
                .toSorted((a, b) => Date.parse(a.span.startTime) - Date.parse(b.span.startTime))
                .at(-1);
              if (root === undefined)
                return Effect.fail(new Error("The tool call must reach Motel"));
              const found: Statement[] = [];
              for (const { span } of result.data) {
                if (span.operationName !== "sql.execute" && span.operationName !== "sql.pipeline")
                  continue;
                const under: string[] = [];
                let parent = span.parentSpanId;
                let inside = false;
                while (parent !== null) {
                  if (parent === root.span.spanId) {
                    inside = true;
                    break;
                  }
                  const next = byId.get(parent);
                  if (next === undefined) break;
                  under.push(next.operationName);
                  parent = next.parentSpanId;
                }
                if (!inside || under.some((name) => name.startsWith("runtime."))) continue;
                const start = Date.parse(span.startTime);
                found.push({
                  text:
                    span.operationName === "sql.pipeline"
                      ? batchMarker
                      : String(span.tags["db.query.text"] ?? "").replace(/\s+/g, " "),
                  under,
                  start,
                  end: start + span.durationMs,
                });
              }
              return found.some(isPatCheck)
                ? Effect.succeed(found.toSorted((a, b) => a.start - b.start))
                : Effect.fail(new Error("The tool call's statements must reach Motel"));
            }),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
          );
        });

        const key = yield* token("Read ahead");
        const client = yield* mcp.connect(key.key, "pat", { organization: organization.id });
        const execute = executeWith(client);
        // Call until the session has read the live profile: the server's own reconcile can update
        // a profile just after it is saved, which the next call reads as a change.
        for (let attempt = 1; ; attempt++) {
          expect(yield* execute).toEqual({ ok: true, value: "synthetic-before" });
          if ((yield* statements).filter(isBatch).length === 1) break;
          expect(attempt, "A call that sends one batch").toBeLessThan(3);
        }

        yield* evidence.step(
          "The call's checks and reads leave together once its token recheck can run",
          Effect.gen(function* () {
            const ran = yield* held({ authentication: "tool-call" }, execute, Effect.void);
            expect(ran).toEqual({ ok: true, value: "synthetic-before" });
            const made = yield* statements;
            yield* evidence.json("read-ahead-statements.json", made);
            const recheck = made.find(isPatCheck);
            const batches = made.filter(isBatch);
            expect(batches.length, "One batch: the session's previous call read the profile").toBe(
              1,
            );
            // The held recheck's statement starts only once released, after a request from here;
            // the batch waits for it, so nothing left before the recheck could.
            expect(batches[0]?.start ?? 0).toBeGreaterThanOrEqual(recheck?.start ?? Infinity);
            expect(made.filter(isSelectionRead).length, "The app and profile reads").toBe(2);
            expect(made.filter(isAccessCheck).length, "One access check").toBe(1);
            expect(
              made.filter(isCallRead).length,
              "The call used the batch's reads instead of reading again",
            ).toBe(0);
          }),
        );

        yield* evidence.step(
          "A token revoked while its recheck waits is refused for its token, though what was read beside it was refused too",
          Effect.gen(function* () {
            // A second app with a profile, which one execution discovers and then calls after a
            // first call. It is deleted while that first call's recheck is held, so the second
            // call's app and profile reads, made beside its own held recheck, are both refused.
            const freeDeployed = yield* send("POST", `${prefix}/apps/deploy`, {
              name: `Read ahead free ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content: freeSource }, appsManifest],
            });
            expect(freeDeployed.status, JSON.stringify(freeDeployed.body)).toBe(200);
            const free = yield* body(App, freeDeployed);
            const freePath = `${prefix}/apps/${free.id}`;
            yield* Effect.addFinalizer(() => send("DELETE", freePath).pipe(Effect.ignore));
            const freeProfile = yield* body(
              Profile,
              yield* send("POST", `${freePath}/profiles`, {
                accounts: {},
                idempotencyKey: randomUUID(),
              }),
            );
            const revoked = yield* token("Read ahead revoked");
            const doomed = yield* mcp.connect(revoked.key, "pat-revoked", {
              organization: organization.id,
            });
            const freeCall = `tools[${JSON.stringify(free.slug)}].profiles[${JSON.stringify(freeProfile.id)}].ping({})`;
            expect(yield* executeWith(doomed, `return await ${freeCall}`)).toEqual({
              ok: true,
              value: "pong",
            });
            const both = `const first = await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(profile.id)}].token({});
return [first, await ${freeCall}];`;
            const refused = yield* held(
              { authentication: "tool-call" },
              executeWith(doomed, both),
              Effect.gen(function* () {
                // The first call's recheck is held, after discovery: delete the second app.
                expect((yield* send("DELETE", freePath)).status).toBe(200);
                // Release the first call and hold the second call's recheck, then revoke.
                yield* arm({ authentication: "tool-call" });
                yield* reached;
                expect(
                  (yield* send("POST", "/api/auth/api-key/delete", { keyId: revoked.id })).status,
                ).toBe(200);
              }),
            );
            yield* evidence.json("read-ahead-revoked.json", refused);
            expect(refused, "Refused for its token, not for its deleted app").toEqual({
              ok: false,
              error: { kind: "ToolFailure", message: "McpUnauthorized" },
            });
            const made = yield* statements;
            yield* evidence.json("read-ahead-revoked-statements.json", made);
            expect(
              made.filter(isSelectionRead).length,
              "The deleted app's app and profile reads went out beside the recheck",
            ).toBe(2);
            expect(made.filter(isBatch).length, "Nothing sent after a failed recheck").toBe(1);
            expect(made.some(isCallRead), "No state read for the call after a failed recheck").toBe(
              false,
            );
          }),
        );

        yield* evidence.step(
          "A change saved while the call's access check waits takes effect on the call",
          Effect.gen(function* () {
            const refused = yield* held({ app: app.id, toolCall: true }, execute, disable);
            yield* enable;
            yield* evidence.json("read-ahead-disabled.json", refused);
            expect(refused.ok, "A profile disabled while the access check waits").toBe(false);
            expect(refused.error).toMatchObject({ response: { status: 409 } });
            const reconnected = yield* held(
              { app: app.id, toolCall: true },
              execute,
              Effect.gen(function* () {
                expect((yield* connect(account)).id).toBe(account);
              }),
            );
            expect(reconnected, "An account reconnected while the access check waits").toEqual({
              ok: true,
              value: "synthetic-after",
            });
          }),
        );

        yield* evidence.step(
          "Another account selected while the call's access check waits refuses the call for its profile",
          Effect.gen(function* () {
            // The access check read the profile with the first account; the call's own reads see
            // the second. Every MCP call names the profile revision discovery listed, so the call
            // is refused for the changed profile before anything read ahead for the first
            // account could stand in, as it was before reads were sent together.
            const other = (yield* connect(undefined, "synthetic-other")).id;
            yield* Effect.addFinalizer(() =>
              send("DELETE", `${prefix}/accounts/${other}`).pipe(Effect.orDie),
            );
            yield* select(account);
            expect(yield* execute).toEqual({ ok: true, value: "synthetic-after" });
            const switched = yield* held({ app: app.id, toolCall: true }, execute, select(other));
            yield* evidence.json("read-ahead-switched.json", switched);
            expect(switched.ok, "A selection changed while the call's access check waits").toBe(
              false,
            );
            expect(switched.error).toMatchObject({
              response: { code: "ProfileConflict", status: 409 },
            });
            // The next call reads the new selection.
            expect(yield* execute).toEqual({ ok: true, value: "synthetic-other" });
          }),
        );

        yield* evidence.step(
          "A read of the accounts made beside the profile recheck that fails for storage is made again in order",
          Effect.gen(function* () {
            // As a connection dropped between two replies of one write would: the read made ahead
            // stands in for nothing, and the call reads the accounts itself.
            yield* arm({ fail: "tool-call-accounts" });
            const ran = yield* execute;
            yield* reached;
            yield* send("DELETE", statementHold);
            yield* evidence.json("read-ahead-storage-failure.json", ran);
            expect(ran, "The call reads its accounts again and runs").toEqual({
              ok: true,
              value: "synthetic-other",
            });
            const made = yield* statements;
            yield* evidence.json("read-ahead-storage-failure-statements.json", made);
            expect(
              made.filter((statement) => statement.text.includes('FROM "executor_accounts"'))
                .length,
              "The accounts read again, after the failed read ahead",
            ).toBe(1);
          }),
        );

        yield* evidence.step(
          "A selection changed again between a call's two rounds is checked for the accounts it then selects",
          Effect.gen(function* () {
            // A call whose first round reads a profile its session has not seen makes a second
            // round, with the access check for the accounts that profile selects. When the
            // selection changes again before that round, its access check was made for accounts
            // the profile no longer selects, so the call checks the ones it does, live: they pass,
            // and the call is refused for its changed profile, as it is without batches. Using
            // the second round's check would refuse it for an account that check never covered.
            // The account the previous step selected; connecting another account selects it.
            const other = (yield* body(
              Profile,
              yield* send("GET", `${path}/profiles/${profile.id}`),
            )).accounts.service;
            const third = (yield* connect(undefined, "synthetic-third")).id;
            yield* Effect.addFinalizer(() =>
              send("DELETE", `${prefix}/accounts/${third}`).pipe(Effect.orDie),
            );
            yield* select(account);
            expect(yield* execute).toEqual({ ok: true, value: "synthetic-after" });
            expect(other, "The previous step's account").not.toBe(account);
            yield* select(String(other));
            const changed = yield* held(
              { app: app.id, toolCall: true },
              execute,
              Effect.gen(function* () {
                // Release the first round and hold the second round's access check.
                yield* arm({ app: app.id, toolCall: true });
                yield* reached;
                yield* select(third);
              }),
            );
            yield* evidence.json("read-ahead-changed-between-rounds.json", changed);
            expect(changed.ok, "A selection changed between the call's rounds").toBe(false);
            expect(changed.error, "Refused for its profile, not for an account").toMatchObject({
              response: { code: "ProfileConflict", status: 409 },
            });
            const made = yield* statements;
            yield* evidence.json("read-ahead-changed-between-rounds-statements.json", made);
            expect(made.filter(isBatch).length, "Two rounds").toBe(2);
            expect(
              made.filter(isAccessCheck).length,
              "Both rounds' access checks, then a live one for the accounts now selected",
            ).toBe(3);
            expect(yield* execute).toEqual({ ok: true, value: "synthetic-third" });
          }),
        );
      }),
    ),
  );
});
