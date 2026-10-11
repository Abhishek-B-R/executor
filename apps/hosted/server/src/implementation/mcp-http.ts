import { CurrentAuthorization } from "../contracts/authorization.ts";
import { CurrentUsage } from "../contracts/product-analytics.ts";
import { requiresToolMetadata } from "@executor-js/authorization";
import { grantAuthorization } from "@executor-js/mcp-auth";
import { GroupDatabase } from "../contracts/groups.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import {
  restrictMcpBackend,
  deliveryRefusal,
  GrantForbidden,
  requestedMcpAddress,
  mcpResource,
  mcpResourceMetadataUrl,
  requestResourceOrigin,
  type McpAddress,
} from "@executor-js/mcp-auth";
import {
  defaultMcpLimits,
  makeMcp,
  refusedMcpRequest,
  type McpBackend,
  type McpOptions,
} from "@executor-js/mcp";
import { annotateSkillRead, executorIntro } from "@executor-js/app-templates/executor";
import { Cause, Context, Effect, Exit, Option, Result, Schema } from "effect";
import {
  ElicitationFailed,
  InvocationPrefetch,
  PrefetchHost,
  Profile as ProfileSchema,
  type AppId,
  type ProfileId,
} from "@executor-js/sdk/core";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  CurrentMcpGrant,
  McpAuthentication,
  McpUnauthorized,
  type McpAccess,
} from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationReference } from "../contracts/organization.ts";
import {
  CallStateCache,
  ConcurrentStatements,
  HostedExecutor,
  StatementBatch,
  statementGroup,
  type CallState,
} from "../contracts/executor.ts";
import { FoldReadAhead, readSelection, SelectionReadAhead, selectedAccounts } from "./access.ts";
import { resourceAuthorityForSelection } from "./resource-policy.ts";
import { BearerHashes } from "./bearer-access.ts";
import { hostedMcpBackend } from "./mcp.ts";

// A native MCP server retains its tool handlers. Authority is supplied only while
// dispatching the HTTP request, never while registering those handlers.
type HostedBackend = Effect.Success<typeof hostedMcpBackend>;
type RequestError =
  | GrantForbidden
  | Effect.Error<ReturnType<HostedBackend[keyof HostedBackend]>>
  | Effect.Error<ReturnType<McpAuthentication["Service"]["authenticate"]>>;
const unavailable = () => Effect.fail(new McpUnauthorized());
const sameProfile = Schema.toEquivalence(ProfileSchema);
/** Selections one session object remembers a profile for (CallStateCache); the oldest goes first. */
const callStateLimit = 256;
const RequestCaller = Context.Reference<string | undefined>("hosted/McpRequestCaller", {
  defaultValue: () => undefined,
});
// Programs belong to the caller across MCP sessions, so a request without one must not share a partition.
const requestCaller = Effect.flatMap(RequestCaller, (caller) =>
  caller === undefined
    ? Effect.die("MCP request has no authenticated caller")
    : Effect.succeed(caller),
);
const RequestBackend = Context.Reference<McpBackend<RequestError>>("hosted/McpRequestBackend", {
  defaultValue: () => ({
    listSkills: unavailable,
    readSkill: unavailable,
    listApps: unavailable,
    listTargets: unavailable,
    listTools: unavailable,
    searchableTools: unavailable,
    searchTools: unavailable,
    callTool: unavailable,
    resumeInvocation: unavailable,
    authorizeElicitation: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
    eventDefinitions: unavailable,
    findEventSubscription: unavailable,
    subscribeEvent: unavailable,
    unsubscribeEvent: unavailable,
  }),
});
const RequestApprovalUrl = Context.Reference<
  ((address: import("@executor-js/mcp/browser").BrowserApprovalAddress) => string) | undefined
>("hosted/McpApprovalUrl", { defaultValue: () => undefined });
const requestBackend: McpBackend<RequestError> = {
  listSkills: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.listSkills(input, options)),
  readSkill: (input) => Effect.flatMap(RequestBackend, (backend) => backend.readSkill(input)),
  authorizeElicitation: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.authorizeElicitation(input)),
  listApps: (input) => Effect.flatMap(RequestBackend, (backend) => backend.listApps(input)),
  listTargets: (input) => Effect.flatMap(RequestBackend, (backend) => backend.listTargets(input)),
  listTools: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.listTools(input, options)),
  searchableTools: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.searchableTools(input, options)),
  searchTools: (input) => Effect.flatMap(RequestBackend, (backend) => backend.searchTools(input)),
  callTool: (input, options) =>
    Effect.flatMap(RequestBackend, (backend) => backend.callTool(input, options)),
  resumeInvocation: (request, response, options) =>
    Effect.flatMap(RequestBackend, (backend) =>
      backend.resumeInvocation(request, response, options),
    ),
  eventDefinitions: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.eventDefinitions(input)),
  findEventSubscription: (key) =>
    Effect.flatMap(RequestBackend, (backend) => backend.findEventSubscription(key)),
  subscribeEvent: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.subscribeEvent(input)),
  unsubscribeEvent: (input) =>
    Effect.flatMap(RequestBackend, (backend) => backend.unsubscribeEvent(input)),
};

/** Build native MCP protocol state inside its host-owned scope, without a caller identity. */
export const makeHostedMcp = (
  beforeExecute?: McpOptions["beforeExecute"],
  limits: McpOptions["limits"] = defaultMcpLimits,
  sessions?: McpOptions["sessions"],
) =>
  makeMcp({
    backend: requestBackend,
    ...(beforeExecute === undefined ? {} : { beforeExecute }),
    ...(sessions === undefined ? {} : { sessions }),
    caller: requestCaller,
    instructions: executorIntro,
    limits,
    annotateSkillRead,
    browser: {
      url: (address) =>
        Effect.flatMap(RequestApprovalUrl, (url) =>
          url === undefined
            ? Effect.die("Browser approval URL requires an authenticated MCP request")
            : Effect.succeed(url(address)),
        ),
    },
  }).pipe(Effect.orDie);

/** An organization-pathed MCP URL names its organization; bare /mcp leaves the choice to the token. */
export const requestedMcpOrganization = (url: URL): OrganizationReference | undefined => {
  const match = /^\/org\/([^/]+)\/mcp$/.exec(url.pathname);
  if (match === null) return undefined;
  const reference = Schema.decodeUnknownOption(OrganizationReference)(
    decodeURIComponent(match[1] ?? ""),
  );
  return Option.getOrUndefined(reference);
};

/** A session belongs to a user/client/organization grant, never to a browser's active organization. */
export const mcpSessionKey = ({ userId, clientId, access, grant }: McpAccess) =>
  JSON.stringify([userId, clientId, access.organization, grant.id]);

/** Supply fresh authorized operations to an existing native MCP transport. */
export const dispatchHostedMcp = <E, R>(
  access: McpAccess,
  address: McpAddress,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const authentication = yield* McpAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scoped = (fresh: McpAccess) =>
      Effect.gen(function* () {
        // A grant serves only the MCP URL it was issued for, and says why it cannot serve this one.
        const refusal = deliveryRefusal(fresh.grant, address);
        if (refusal !== undefined) return yield* new GrantForbidden({ refusal });
        const backend = yield* hostedMcpBackend.pipe(
          Effect.provideService(CurrentOrganization, fresh.access),
          Effect.provideService(CurrentAuthorization, grantAuthorization(fresh.grant.policy)),
          Effect.provideService(CurrentUserId, fresh.userId),
          Effect.provideService(CurrentMcpGrant, fresh.grant.id),
        );
        return restrictMcpBackend<RequestError, never>(backend, Effect.succeed(fresh.grant));
      });
    // Clients print a refusal's body after their own prefix, so it keeps the typed cause.
    const scope = yield* Effect.result(scoped(access));
    if (Result.isFailure(scope)) return yield* refusedMcpRequest(scope.failure);
    const backend = scope.success;
    const services = yield* Effect.context<HostedExecutor | GroupDatabase>().pipe(
      Effect.map(Context.pick(HostedExecutor, GroupDatabase)),
    );
    // Discovery uses this HTTP request's authenticated identity. Resource policies
    // are still checked by the hosted backend. Never retain this adapter in the session.
    // Calls and elicitation can run after a wait, so recheck token/grant/membership
    // before executing or releasing them, including calls after an approved one.
    // A recheck names the organization this request resolved, by its ID; it never resolves the
    // URL's or X-Executor-Organization's slug again, so a slug renamed during the request cannot
    // move it to another organization. The same bearer keeps its user, client and grant.
    const headers = new Headers(request.headers);
    headers.delete("x-executor-organization");
    // The organization's opaque ID goes on the request's span and on each operation that rechecks
    // (`mcp.tool.call`, `mcp.tool.resume`), so their latency can be split by organization.
    const organization = { "executor.organization.id": access.access.organization };
    yield* Effect.annotateCurrentSpan(organization);
    const current = Effect.annotateCurrentSpan(organization).pipe(
      Effect.andThen(
        authentication.authenticate(headers, address.mode, access.access.organization),
      ),
      Effect.flatMap(scoped),
      Effect.provideContext(services),
    );
    // Made for this request's organization, whose ID the recheck keeps. If they cannot be made,
    // the call makes them itself; they never decide the call's outcome or the recheck's.
    const readAhead = (app: AppId, profile: ProfileId | undefined) =>
      Effect.flatten(HostedExecutor).pipe(
        Effect.flatMap((executor) => readSelection(executor, access.access.owner, app, profile)),
        Effect.provideContext(services),
        Effect.exit,
        Effect.map((read) => (Exit.isSuccess(read) ? read.value : undefined)),
      );
    /**
     * One round trip for a warm tool call (F-034). The recheck, then every read the call's checks
     * and the SDK make, leave in one write: the recheck first, in its own implicit transaction as
     * on main, then the reads in one read-only snapshot taken after it commits (StatementBatch).
     * The access fold and the SDK's account reads need the profile's accounts before the profile
     * is read, so they name those of the profile this session's last call read (CallStateCache);
     * the same batch reads the profile live. The cache holds no authorization and decides
     * nothing: the call uses the fold and the SDK's reads only where they were made for the live
     * profile, and otherwise sends the reads once more, after the recheck passed, with the live
     * profile: two round trips. Results are evaluated in main's order: the recheck's outcome
     * first, whatever the reads returned, then the call's own checks over the batch's reads
     * (checkedSelection, then the SDK's). A read that failed in storage discards the batch's reads
     * and the call reads on its own, in main's order.
     */
    const batchedCall = (
      batch: NonNullable<Effect.Success<typeof StatementBatch>>,
      cache: NonNullable<Effect.Success<typeof CallStateCache>>,
      input: Parameters<McpBackend<RequestError>["callTool"]>[0],
      profile: ProfileId,
      options: Parameters<McpBackend<RequestError>["callTool"]>[1],
    ) =>
      Effect.gen(function* () {
        const executor = yield* Effect.flatten(HostedExecutor).pipe(
          Effect.provideContext(services),
        );
        const owner = access.access.owner;
        const organization = access.access.organization;
        const key = JSON.stringify([mcpSessionKey(access), input.app, profile]);
        let recheck: Exit.Exit<
          Effect.Success<typeof current>,
          Effect.Error<typeof current>
        > = Exit.die("unreachable");
        const round = (known: CallState | undefined, rechecking: boolean) =>
          Effect.gen(function* () {
            const sdk = executor[PrefetchHost].invocation({
              app: input.app,
              owner,
              profile,
              known,
            });
            let fold: Effect.Success<typeof FoldReadAhead>;
            const leaves: Array<Effect.Effect<unknown>> = [
              ...(rechecking
                ? [
                    Effect.exit(current).pipe(
                      Effect.map((exit) => {
                        recheck = exit;
                      }),
                    ),
                  ]
                : []),
              ...sdk.leaves,
            ];
            if (known !== undefined) {
              const accounts = [...new Set(selectedAccounts(known.profile.accounts))];
              leaves.push(
                Effect.exit(
                  resourceAuthorityForSelection(organization, access.userId, input.app, accounts),
                ).pipe(
                  Effect.map((result) => {
                    fold = { organization, user: access.userId, app: input.app, accounts, result };
                  }),
                  Effect.provideContext(services),
                ),
              );
            }
            yield* batch(leaves, { outside: rechecking ? 1 : 0 });
            return { read: yield* sdk.take, fold };
          });
        const known = cache.get(key);
        let sent = yield* round(known, true);
        let rounds = 1;
        // The recheck decides first, as on main: its refusal or failure is the call's outcome,
        // whatever the reads returned.
        const authorized = yield* recheck;
        const live =
          sent.read.profile !== undefined && Result.isSuccess(sent.read.profile)
            ? sent.read.profile.success
            : undefined;
        if (live !== undefined && (known === undefined || !sameProfile(known.profile, live))) {
          sent = yield* round({ profile: live, hint: sent.read.hint }, false);
          rounds = 2;
        }
        const { read, fold } = sent;
        const latest =
          read.profile !== undefined && Result.isSuccess(read.profile)
            ? read.profile.success
            : undefined;
        cache.delete(key);
        if (latest !== undefined) {
          cache.set(key, { profile: latest, hint: read.hint });
          if (cache.size > callStateLimit) cache.delete(cache.keys().next().value!);
        }
        const failed =
          read.failed ||
          (fold !== undefined &&
            Exit.isFailure(fold.result) &&
            Cause.findErrorOption(fold.result.cause).pipe(
              Option.exists((error) => error._tag === "StorageError"),
            ));
        yield* Effect.annotateCurrentSpan({
          "executor.mcp.call.batches": rounds,
          "executor.mcp.call.batch_discarded": failed,
        });
        if (failed || read.app === undefined) return yield* authorized.callTool(input, options);
        return yield* authorized.callTool(input, options).pipe(
          Effect.provideService(SelectionReadAhead, {
            owner,
            app: input.app,
            profile,
            current: read.app,
            selected: read.profile,
          }),
          Effect.provideService(FoldReadAhead, fold),
          Effect.provideService(InvocationPrefetch, read.invocation),
        );
      });
    const authorized: McpBackend<RequestError> = {
      ...backend,
      listSkills: (input, options) =>
        current.pipe(Effect.flatMap((fresh) => fresh.listSkills(input, options))),
      readSkill: (input) => current.pipe(Effect.flatMap((fresh) => fresh.readSkill(input))),

      authorizeElicitation: (input) =>
        current.pipe(
          Effect.flatMap((fresh) => fresh.authorizeElicitation(input)),
          Effect.catchTags({
            McpUnauthorized: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
            McpForbidden: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
            GrantForbidden: () => Effect.fail(new ElicitationFailed({ reason: "forbidden" })),
            AuthenticationUnavailable: () =>
              Effect.fail(new ElicitationFailed({ reason: "transport" })),
          }),
        ),
      callTool: (input, options) =>
        Effect.gen(function* () {
          // Under a read-only rule the grant check evaluates the app before the selection check,
          // which then reads the app and profile again (`hostedMcpBackend`): reading ahead would
          // only add two statements. A grant that changed since this request authenticated is
          // decided there again.
          if (
            (yield* ConcurrentStatements) === undefined ||
            requiresToolMetadata(grantAuthorization(access.grant.policy).tools, input.app)
          )
            return yield* current.pipe(Effect.flatMap((fresh) => fresh.callTool(input, options)));
          const batch = yield* StatementBatch;
          const cache = yield* CallStateCache;
          if (batch !== undefined && cache !== undefined && input.profile !== undefined)
            return yield* batchedCall(batch, cache, input, input.profile, options);
          // The selection check's app and profile reads go out with the recheck. Nothing they
          // return is used unless the recheck passes, and the check itself runs after it.
          const [fresh, read] = yield* Effect.all([current, readAhead(input.app, input.profile)], {
            concurrency: "unbounded",
          });
          return yield* fresh
            .callTool(input, options)
            .pipe(Effect.provideService(SelectionReadAhead, read));
          // A call's statements wait only behind its own, never behind another call's.
        }).pipe(statementGroup),
      // Everything else this request runs (discovery listings, skill reads, resumes) stays
      // ungrouped: each statement takes a connection of its own, as before grouping. Those are
      // independent units that the request runs side by side and times out one by one (one app's
      // listing can be stopped while the others go on); sharing a connection would make each wait
      // behind the slowest. None of them issues statements at the same time, so a group of its
      // own would save no round trip.
      resumeInvocation: (pending, response, options) =>
        current.pipe(Effect.flatMap((fresh) => fresh.resumeInvocation(pending, response, options))),
      subscribeEvent: (input) =>
        current.pipe(Effect.flatMap((fresh) => fresh.subscribeEvent(input))),
    };
    return yield* handler.pipe(
      Effect.provideService(RequestBackend, authorized),
      Effect.provideService(RequestApprovalUrl, (address) => {
        const url = new URL(`/mcp/approve/${address.requestId}`, authentication.origin);
        url.searchParams.set("sessionId", address.sessionId);
        url.searchParams.set("grantId", access.grant.id);
        return url.toString();
      }),
      Effect.provideService(RequestCaller, mcpSessionKey(access)),
      Effect.provideService(CurrentUsage, { source: "mcp", client_id: access.clientId }),
    );
  });

/** The 401 that sends a client without a valid bearer to the MCP resource's metadata. */
export const mcpChallenge = Effect.gen(function* () {
  const auth = yield* McpAuthentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const address = requestedMcpAddress(new URL(request.url, auth.origin));
  if (address === undefined) return invalidAddress;
  return HttpServerResponse.empty({
    status: 401,
    headers: {
      "www-authenticate": `Bearer resource_metadata="${mcpResourceMetadataUrl(requestResourceOrigin(auth.resourceOrigins.mcp, request.headers.host), address)}", scope="mcp offline_access"`,
    },
  });
});

const invalidAddress = HttpServerResponse.jsonUnsafe(
  { error: "Unsupported elicitation_mode or connection." },
  { status: 400 },
);

/** Authenticate every MCP HTTP method through OAuth or PAT validation; never fall back to a browser cookie. */
export const authenticatedMcp = <E, R>(
  handle: (
    access: McpAccess,
    address: McpAddress,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthentication;
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Programmatic clients have no Origin. Untrusted browser pages cannot call MCP.
    if (request.headers.origin !== undefined && request.headers.origin !== auth.origin)
      return HttpServerResponse.empty({ status: 403 });
    const url = new URL(request.url, auth.origin);
    const address = requestedMcpAddress(url);
    if (address === undefined) return invalidAddress;
    // The request's tool calls recheck the same token; they reuse its hash (see BearerHashes).
    const hashes = new Map<string, string>();
    const access = yield* Effect.result(
      auth.authenticate(new Headers(request.headers), address.mode, requestedMcpOrganization(url)),
    ).pipe(Effect.provideService(BearerHashes, hashes));
    if (Result.isSuccess(access))
      return yield* handle(access.success, address).pipe(
        Effect.provideService(BearerHashes, hashes),
      );
    if (access.failure._tag === "McpUnauthorized") return yield* mcpChallenge;
    // Clients print a refusal's body after their own prefix, so it keeps the typed cause.
    return yield* refusedMcpRequest(access.failure);
  }).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")));

/** RFC 9728 resource metadata naming the authorization server's issuer. */
export const mcpProtectedResource = Effect.gen(function* () {
  const { issuer, resourceOrigins } = yield* McpAuthentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resourceOrigin = requestResourceOrigin(resourceOrigins.mcp, request.headers.host);
  const address = requestedMcpAddress(new URL(request.url, resourceOrigin));
  if (address === undefined) return invalidAddress;
  return HttpServerResponse.jsonUnsafe({
    resource: mcpResource(resourceOrigin, address),
    authorization_servers: [issuer],
    scopes_supported: ["mcp", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "Executor",
  });
});
/** RFC 8414 authorization-server metadata from Better Auth. */
export const mcpAuthorizationServer = Effect.flatMap(
  McpAuthentication,
  (auth) => auth.metadata,
).pipe(
  Effect.map(HttpServerResponse.jsonUnsafe),
  Effect.catchTag("AuthenticationUnavailable", () =>
    Effect.succeed(HttpServerResponse.empty({ status: 503 })),
  ),
);
