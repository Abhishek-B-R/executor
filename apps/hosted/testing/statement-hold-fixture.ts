/**
 * Test host only: holds the next statement that checks a caller's access to one app, or the next
 * personal access token check an MCP tool call makes, until the scenario releases it, so a
 * scenario can change saved state while that check waits. It can instead fail the next read of
 * account rows an MCP tool call makes, as a dropped connection would, so a scenario can see what
 * the call does with a read that failed for storage. PostgreSQL reads take no row locks, so
 * no lock on rows a scenario created can hold them; the test host holds the statement before it
 * reaches the database instead. Production entry points never provide it.
 */
import { Deferred, Effect, Layer, Option, Schema, type Tracer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient, SqlError, type Statement } from "effect/sql";

/** The join every check of a caller's access to one app makes, with the app as its parameter. */
const appAccess = "left join hosted_app_access p on p.id =";
/** The personal access token lookup every bearer check of a PAT makes. */
const patCheck = "from apikey where key =";
/** How the SDK's storage names the table of saved accounts in a read of its rows. */
const accountRows = /^SELECT .* FROM "executor_accounts"/s;
/** The span of one MCP tool call; a request's own authentication runs outside it. */
const toolCall = "mcp.tool.call";
const path = "/api/devtools/statement-hold";
const Arm = Schema.Union([
  // `toolCall` holds only a check made inside an MCP tool call, not one made by discovery.
  Schema.Struct({ app: Schema.NonEmptyString, toolCall: Schema.optional(Schema.Literal(true)) }),
  Schema.Struct({ authentication: Schema.Literal("tool-call") }),
  // Fails the next read of account rows inside a tool call instead of holding it.
  Schema.Struct({ fail: Schema.Literal("tool-call-accounts") }),
]);

const isTemplate = (value: unknown): value is TemplateStringsArray =>
  Array.isArray(value) && "raw" in value;

/** Whether the current span is, or descends from, an MCP tool call. */
const inToolCall = Effect.map(Effect.currentParentSpan, (span) => {
  let current: Tracer.AnySpan | undefined = span;
  while (current !== undefined && current._tag === "Span") {
    if (current.name === toolCall) return true;
    current = Option.getOrUndefined(current.parent);
  }
  return false;
}).pipe(Effect.orElseSucceed(() => false));

interface Hold {
  /** The app whose access check to hold, or the next PAT check inside a tool call. */
  readonly app: string | undefined;
  /** Hold the app's check only inside a tool call. */
  readonly toolCall: boolean;
  /** Fail the next read of account rows inside a tool call; nothing is held. */
  readonly failAccounts: boolean;
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

export const statementHoldFixture = Effect.gen(function* () {
  /** Armed until a statement reaches it; current until the scenario releases it. */
  let armed: Hold | undefined;
  let current: Hold | undefined;
  const release = Effect.suspend(() => {
    const hold = current;
    armed = current = undefined;
    return hold === undefined ? Effect.void : Deferred.succeed(hold.release, undefined);
  });
  const held = (hold: Hold, run: Effect.Effect<unknown, unknown, unknown>) =>
    Deferred.succeed(hold.reached, undefined).pipe(
      Effect.andThen(Deferred.await(hold.release)),
      Effect.andThen(run),
    );
  const sql = (client: SqlClient.SqlClient): SqlClient.SqlClient =>
    new Proxy(client, {
      apply: (target, self, args: [unknown, ...unknown[]]) => {
        const [strings, ...params] = args;
        const hold = armed;
        if (hold === undefined || !isTemplate(strings)) return Reflect.apply(target, self, args);
        if (hold.failAccounts) {
          const statement: Statement.Statement<unknown> = Reflect.apply(target, self, args);
          if (!accountRows.test(statement.compile()[0])) return statement;
          return Effect.flatMap(inToolCall, (inside) => {
            if (!inside || armed !== hold) return statement;
            // Reported as reached, so a scenario can tell the failure was injected.
            armed = undefined;
            return Effect.andThen(
              Deferred.succeed(hold.reached, undefined),
              Effect.fail(
                new SqlError.SqlError({
                  reason: new SqlError.ConnectionError({
                    cause: new Error("Connection closed"),
                    message: "Statement failure fixture: connection closed",
                    operation: "query",
                  }),
                }),
              ),
            );
          });
        }
        const text = strings.join("?");
        if (hold.app !== undefined) {
          if (!text.includes(appAccess) || !params.includes(hold.app))
            return Reflect.apply(target, self, args);
          if (hold.toolCall)
            return Effect.flatMap(inToolCall, (inside) => {
              if (!inside || armed !== hold) return target(strings, ...params);
              armed = undefined;
              return held(hold, target(strings, ...params));
            });
          armed = undefined;
          return held(hold, target(strings, ...params));
        }
        if (!text.includes(patCheck)) return Reflect.apply(target, self, args);
        // A request authenticates before its tool calls; only a tool call's own check is held.
        return Effect.flatMap(inToolCall, (inside) => {
          if (!inside || armed !== hold) return target(strings, ...params);
          armed = undefined;
          return held(hold, target(strings, ...params));
        });
      },
    });
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      path,
      Effect.gen(function* () {
        const arm = yield* HttpServerRequest.schemaBodyJson(Arm);
        yield* release;
        armed = current = {
          app: "app" in arm ? arm.app : undefined,
          toolCall: "app" in arm && arm.toolCall === true,
          failAccounts: "fail" in arm,
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        return HttpServerResponse.jsonUnsafe({ armed: true });
      }).pipe(Effect.orDie),
    ),
    HttpRouter.add(
      "GET",
      path,
      Effect.gen(function* () {
        const hold = current;
        return HttpServerResponse.jsonUnsafe({
          held: hold !== undefined && (yield* Deferred.isDone(hold.reached)),
        });
      }),
    ),
    HttpRouter.add(
      "DELETE",
      path,
      Effect.as(release, HttpServerResponse.jsonUnsafe({ released: true })),
    ),
  );
  return {
    /** Compose the product with its SQL client gated by the hold. */
    provide: <A, E, R>(product: Effect.Effect<A, E, R>) =>
      product.pipe(Effect.updateService(SqlClient.SqlClient, sql)),
    routes,
  };
});
