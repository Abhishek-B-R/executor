import { Cause, Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { HttpServerError } from "effect/http/HttpServerError";

/**
 * Cloudflare refuses a call to a Worker or Durable Object once its request has entered the
 * Workers runtime too many times (at most 32 Worker invocations per request). A client calling
 * from deep inside its own Worker chain, often one that calls itself, reaches that limit at the
 * gateway's call to the session object. The object never ran, and the same request from the same
 * depth is refused again, so the client is told why instead of getting an empty 500.
 */
export const refuseTooDeep = <E, R>(
  forward: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  forward.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      if (
        Cause.hasInterrupts(cause) ||
        !(error instanceof Error) ||
        !error.message.startsWith("Subrequest depth limit exceeded.")
      )
        return Effect.failCause(cause);
      return Effect.annotateCurrentSpan("executor.mcp.refused", "subrequest-depth").pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32000,
                message:
                  "Subrequest depth limit exceeded: this request reached Executor after passing through Cloudflare Workers too many times, so Cloudflare refused Executor's next step. The Worker or Durable Object that called Executor is nested too deeply, often because it calls itself or other Workers recursively. Call Executor from a shallower point in that chain",
              },
            },
            { status: 508, headers: { "cache-control": "no-store" } },
          ),
        ),
      );
    }),
  );

const Initialize = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.Literal("initialize"),
  id: Schema.Union([Schema.String, Schema.Number]),
});

/** Only a new session handshake is safe to repeat after an ambiguous connection loss. */
export const forwardMcpRequest = (
  request: HttpServerRequest.HttpServerRequest,
  forward: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>,
) =>
  Effect.gen(function* () {
    if (
      request.method !== "POST" ||
      request.headers["mcp-session-id"] !== undefined ||
      !/^\/(?:org\/[^/]+\/)?mcp$/.test(new URL(request.url, "https://mcp.internal").pathname)
    )
      return yield* forward(request);
    const web = yield* HttpServerRequest.toWeb(request);
    const attempt = Effect.suspend(() =>
      forward(HttpServerRequest.fromWeb(new Request(web.clone(), { headers: request.headers }))),
    );
    return yield* attempt.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const error = Cause.squash(cause);
          if (
            Cause.hasInterrupts(cause) ||
            !(error instanceof Error) ||
            error.message !==
              "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request."
          )
            return yield* Effect.failCause(cause);
          const initialize = yield* Effect.tryPromise(() => web.clone().json()).pipe(
            Effect.map(Schema.is(Initialize)),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (!initialize) return yield* Effect.failCause(cause);
          yield* Effect.logWarning("MCP initialization reconnecting after inactive Durable Object");
          // Rebuild the body and acquire a fresh stub. A second failure propagates unchanged.
          return yield* attempt;
        }),
      ),
    );
  });
