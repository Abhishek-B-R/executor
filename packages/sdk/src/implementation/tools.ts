import { ProviderError } from "apps/contracts";
import { appProviderFailure } from "./provider-error.ts";
import { invocationAccount } from "./provider.ts";
import type { FirstPartyOAuthClient } from "../contracts/oauth.ts";
/** Snapshot the configured app, then execute with its selected credentials. */
import {
  Cause,
  Clock,
  type Crypto,
  Effect,
  ErrorReporter,
  Exit,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { recordedCause } from "@executor-js/telemetry/recorded-failure";
import {
  type WorkflowHostControls,
  HostToolApprovalRequired,
  ToolResultObservation,
  type HostAccount,
  type HostAccounts,
} from "apps/contracts";
import {
  AccountRequired,
  AccountSelectionInvalid,
  AppNotFound,
  AppNotDeployed,
} from "../contracts/apps.ts";
import { AccountNotFound } from "../contracts/account.ts";
import { DeploymentNotFound } from "../contracts/deployment.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import type { Executor } from "../contracts/executor.ts";
import { AppCodeEntered, type Runtime } from "../contracts/runtime.ts";
import {
  Cursor,
  ToolName,
  Json,
  JsonObject,
  RequestInvalid,
  StorageError,
  CredentialsError,
  type AccountId,
  type AppId,
  type DeploymentId,
} from "../contracts/shared.ts";
import type { Account } from "../contracts/account.ts";
import { OAuthReconnectRequired } from "../contracts/oauth.ts";
import { GrantReadAhead, type GrantRow, type makeOAuth } from "./oauth.ts";
import {
  AppEvaluationFailed,
  appFailure,
  appFailureText,
  type CallFailure,
  evaluationFailure,
  InputInvalid,
  AppProviderFailed,
  mayHaveWritten,
  operationMcpFailure,
  type RenewalFailure,
  ToolCallFailed,
  ToolNotFound,
  ToolKindMismatch,
  type ToolKind,
  ToolBlocked,
  ToolApprovalRequired,
  ToolPolicyFailed,
  ToolElicitationFailed,
  ToolInvocation,
  ToolInputs,
  type ToolInvocationOptions,
  type ToolListOptions,
  type ToolResumeResult,
  type Tool,
  type ToolSummary,
} from "../contracts/tools.ts";
import type { ExecutorDatabase } from "./storage.ts";
import { type Credentials, StoredApp, StoredDeployment } from "../contracts/storage.ts";
import { makeToolApprovals } from "./tool-approvals.ts";
import { gotApp, storedDeployment } from "./apps.ts";
import { database, query, type Query } from "./database.ts";
import { storedProfile } from "./profiles.ts";
import {
  CurrentProfile,
  InvocationPrefetch,
  type PrefetchedInvocation,
  type PrefetchHost,
  InvocationSelection,
  Profile as ProfileSchema,
  type Profile,
  ProfileConflict,
  ProfileNotFound,
} from "../contracts/profiles.ts";
import type { OwnerId, ProfileId } from "../contracts/shared.ts";
import {
  answered,
  readSelectionAccounts,
  selectionAccountIds,
  type SelectionAccountsRead,
  validateSelection,
} from "./selection.ts";
import type { Listings, ToolListing } from "./listings.ts";
import { ownsDatabase } from "../contracts/apps.ts";

/** The configured app with its active deployment, in one statement. */
const readApp = (db: Query, app: AppId) =>
  query(() =>
    db.findFirst("apps", {
      join: (b) => b.deployment(),
      where: (b) => b("id", "=", app),
    }),
  );

/**
 * The reads {@link snapshot} makes, made ahead and at once. The profile read stands in only when
 * it was made under the owner the app read returns, and the account read only when it named the
 * accounts the profile read returns; otherwise the snapshot reads again, in order. A read that
 * failed for storage stands in for nothing (see `answered`).
 */
interface SnapshotReads {
  readonly app: Result.Result<Effect.Success<ReturnType<typeof readApp>>, StorageError>;
  readonly profile:
    | {
        readonly owner: OwnerId;
        readonly read: Result.Result<Profile, Effect.Error<ReturnType<typeof storedProfile>>>;
      }
    | undefined;
  readonly accounts: SelectionAccountsRead;
}

/**
 * Resolve the app, pinned deployment, profile and account selection before invoking authored code.
 *
 * These reads deliberately run outside a transaction. A transaction costs two extra round trips and
 * pins a pooled server connection (a Hyperdrive origin connection in Cloud) for as long as the
 * caller takes between statements. On Postgres at READ COMMITTED it gave no cross-statement
 * snapshot anyway. On PGlite it was atomic with respect to writers, because a transaction reserves
 * the only connection; that atomicity is dropped on purpose. A write that lands between two reads
 * cannot widen access: every cross-read disagreement fails closed (AppNotDeployed,
 * DeploymentNotFound, ProfileConflict, AccountNotFound, AccountSelectionInvalid or
 * AccountRequired), and account credentials are resolved from the returned selection afterwards.
 */
export function snapshot(
  db: Query,
  input: {
    app: AppId;
    deployment?: DeploymentId | undefined;
    profile?: ProfileId | undefined;
    expectedProfileRevision?: number | undefined;
  },
  savedAccounts?: import("../contracts/apps.ts").SelectedAccounts,
  savedProfileRevision?: number,
  cleanup = false,
  ahead?: SnapshotReads,
) {
  return Effect.gen(function* () {
    const row =
      ahead !== undefined && answered(ahead.app)
        ? yield* Effect.fromResult(ahead.app)
        : yield* readApp(db, input.app);
    if (row === null) return yield* new AppNotFound({ app: input.app });
    const app = yield* Schema.decodeUnknownEffect(StoredApp)(row).pipe(
      Effect.mapError(() => new StorageError()),
    );
    const deploymentId = input.deployment ?? app.activeDeployment;
    if (deploymentId === null) return yield* new AppNotDeployed({ app: app.id });
    // Historical invocations retain their pinned deployment and its lineage check.
    const deployment =
      deploymentId !== app.activeDeployment
        ? yield* storedDeployment(db, app, deploymentId)
        : row.deployment === null
          ? yield* new DeploymentNotFound({ app: app.id, deployment: deploymentId })
          : yield* Schema.decodeUnknownEffect(StoredDeployment)(row.deployment).pipe(
              Effect.mapError(() => new StorageError()),
            );
    const profile =
      input.profile === undefined
        ? undefined
        : ahead?.profile !== undefined &&
            ahead.profile.owner === app.owner &&
            answered(ahead.profile.read)
          ? yield* Effect.fromResult(ahead.profile.read)
          : yield* storedProfile(db, {
              app: app.id,
              profile: input.profile,
              owner: app.owner,
            });
    if (profile !== undefined) {
      if (
        profile.status === "removed" ||
        ((!profile.enabled || profile.status === "removing") && !cleanup)
      )
        return yield* new ProfileConflict({
          profile: profile.id,
          reason: "inactive",
        });
      if (
        input.expectedProfileRevision !== undefined &&
        profile.revision !== input.expectedProfileRevision
      )
        return yield* new ProfileConflict({
          profile: profile.id,
          reason: "revision",
        });
    }
    const bindings = profile === undefined ? {} : (savedAccounts ?? profile.accounts);
    const validated = yield* validateSelection(
      db,
      app.id,
      deployment.requirements,
      bindings,
      ahead?.accounts,
    );
    const selections = yield* Effect.forEach(
      Object.keys(deployment.requirements.accounts),
      (slot) =>
        Effect.gen(function* () {
          const selected = validated.get(slot);
          if (selected === undefined)
            return yield* Effect.fail(
              new AccountRequired({ app: app.id, deployment: deployment.id, slot }),
            );
          return selected;
        }),
    );
    return {
      app,
      deployment,
      selections,
      profile:
        profile === undefined
          ? undefined
          : { ...profile, revision: savedProfileRevision ?? profile.revision },
      accounts: bindings,
    };
  });
}

/**
 * A profile recheck run beside the snapshot's reads, before the call's own profile and accounts
 * were known: the profile and accounts it ran for, and its outcome.
 */
export interface RecheckAhead {
  readonly profile: Profile;
  readonly accounts: readonly Pick<Account, "id" | "owner">[];
  readonly result: Exit.Exit<ReadonlySet<AccountId>, StorageError>;
}

const sameProfile = Schema.toEquivalence(ProfileSchema);
/**
 * Per selected account, whether resolving it reads a grant: its slot's provider signs in with
 * something other than secrets, by the account's method when its row was read, else by any of
 * the provider's methods. Opaque to the host, which keeps it beside the profile it was made for.
 */
class GrantHint {
  readonly accounts: ReadonlyMap<AccountId, boolean>;
  constructor(accounts: ReadonlyMap<AccountId, boolean>) {
    this.accounts = accounts;
  }
  static read(hint: unknown) {
    return hint instanceof GrantHint ? hint.accounts : undefined;
  }
}
/** The {@link GrantHint} for a profile, from the app's deployment and any account rows read. */
const grantHint = (
  app: Effect.Success<ReturnType<typeof gotApp>>,
  profile: Profile,
  rows: ReadonlyArray<{ readonly id: AccountId; readonly method: string }>,
) => {
  const methods = new Map(rows.map((row) => [row.id, row.method]));
  const grants = new Map<AccountId, boolean>();
  for (const [slot, selection] of Object.entries(profile.accounts)) {
    const auth = app.requirements.accounts[slot]?.definition.auth;
    for (const id of typeof selection === "string" ? [selection] : selection) {
      const method = methods.get(id);
      const types =
        auth === undefined
          ? undefined
          : method === undefined
            ? Object.values(auth).map((entry) => entry.type)
            : [auth[method]?.type];
      grants.set(
        id,
        grants.get(id) === true || types === undefined || types.some((type) => type !== "secrets"),
      );
    }
  }
  return new GrantHint(grants);
};
/** Each account's grant row as read in the batch; taken once, by the account's first read. */
const grantReadAhead = (ids: readonly AccountId[], rows: ReadonlyArray<GrantRow>) => {
  const byId = new Map<AccountId, GrantRow | null>(ids.map((id) => [id, null]));
  for (const row of rows) if (byId.has(row.id as AccountId)) byId.set(row.id as AccountId, row);
  return byId;
};
/** The recheck ran for exactly this profile and these accounts, each under the same owner. */
const recheckedFor = (
  ahead: RecheckAhead,
  profile: Profile,
  accounts: readonly Pick<Account, "id" | "owner">[],
) => {
  const owners = new Map(ahead.accounts.map((account) => [account.id, account.owner]));
  return (
    sameProfile(ahead.profile, profile) &&
    owners.size === ahead.accounts.length &&
    owners.size === new Set(accounts.map((account) => account.id)).size &&
    accounts.every((account) => owners.get(account.id) === account.owner)
  );
};

/**
 * Resolve current credentials without holding a database transaction open. `ahead` stands in
 * for the profile recheck only when it succeeded, for the profile and accounts this state holds.
 */
export function resolve(
  state: Effect.Success<ReturnType<typeof snapshot>>,
  resolveAccount: ReturnType<typeof makeOAuth>["resolveSelected"],
  lifecycle?: ResourceLifecycle,
  ahead?: RecheckAhead,
) {
  return Effect.gen(function* () {
    const selections = new Map<string, HostAccounts[string]>();
    // An account selected for several slots is resolved once per invocation, in selection
    // order. A token renewed for one slot is the token every slot uses, even when it already
    // falls inside the refresh-ahead window, so one invocation never renews the same grant twice.
    const distinct = new Map<AccountId, Parameters<typeof resolveAccount>[0][number]>();
    for (const { required, accounts } of state.selections)
      for (const account of accounts)
        if (!distinct.has(account.id))
          distinct.set(account.id, { account, provider: required.definition });
    const selected = [...distinct.values()];
    // The profile's subject and its accounts are rechecked together, before any credential.
    const resolvedFields =
      state.profile !== undefined && lifecycle?.profileResolving
        ? yield* resolveAccount(
            selected,
            ahead !== undefined &&
              Exit.isSuccess(ahead.result) &&
              recheckedFor(
                ahead,
                state.profile,
                selected.map(({ account }) => account),
              )
              ? ahead.result
              : lifecycle.profileResolving(
                  state.profile,
                  selected.map(({ account }) => account),
                ),
          )
        : yield* resolveAccount(selected);
    const credentials = new Map(
      [...distinct.keys()].map((id, index) => [id, resolvedFields[index]] as const),
    );
    for (const { slot, required, accounts } of state.selections) {
      const resolved = yield* Effect.forEach(accounts, (account) =>
        Effect.gen(function* () {
          const bind = credentials.get(account.id);
          if (bind === undefined) return yield* new StorageError();
          return bind(required.definition);
        }),
      );
      if (required.cardinality === "many") selections.set(slot, resolved);
      else {
        const account = resolved[0];
        if (account === undefined)
          return yield* Effect.fail(
            new AccountRequired({ app: state.app.id, deployment: state.deployment.id, slot }),
          );
        selections.set(slot, account);
      }
    }
    return {
      accounts: Redacted.make(Object.fromEntries(selections)),
    };
  }).pipe(Effect.provideService(CurrentProfile, state.profile));
}

/** Whether a profile's selected accounts can run its tools; recorded on the check's span. */
const accountsOutcome = (outcome: "ready" | "reconnect" | "account_required") =>
  Effect.annotateCurrentSpan("executor.accounts.outcome", outcome);

/** One resolved invocation: app, pinned deployment, optional profile and account selection. */
export type InvocationSnapshot = Effect.Success<ReturnType<typeof snapshot>>;
type InvocationContext = Effect.Success<ReturnType<typeof resolve>>;
type SelectedAccount = HostAccounts[string];
const isMany = (
  value: SelectedAccount,
): value is Extract<SelectedAccount, ReadonlyArray<unknown>> => Array.isArray(value);
const sameFields = Schema.toEquivalence(JsonObject);

/**
 * The service refused one of this invocation's accounts: the app reported an `unauthorized`
 * provider failure attributed to a selected account. Renew that account once, or read a renewal
 * another call already made, and return the invocation's accounts with its new credentials.
 *
 * Returns undefined when there is nothing new to try: the failure is not an attributed
 * authentication refusal, or the account cannot be renewed, such as a secrets account or a grant
 * without a refresh token. A renewal the service refuses with `invalid_grant` fails with
 * `OAuthReconnectRequired`, as any resolve does.
 */
const renewRefused = (
  oauth: Pick<ReturnType<typeof makeOAuth>, "renewRejected">,
  clients: ReadonlyMap<string, FirstPartyOAuthClient>,
  state: InvocationSnapshot,
  context: InvocationContext,
  error: unknown,
) =>
  Effect.gen(function* () {
    if (
      !Schema.is(ProviderError)(error) ||
      error.reason !== "unauthorized" ||
      error.accountId === undefined
    )
      return undefined;
    const { accountId } = error;
    const selected = state.selections
      .flatMap(({ required, accounts }) =>
        accounts.map((account) => ({ account, definition: required.definition })),
      )
      .find(({ account }) => account.id === accountId);
    if (selected === undefined) return undefined;
    const accounts = Redacted.value(context.accounts);
    const used = Object.values(accounts)
      .flatMap((value) => (isMany(value) ? value : [value]))
      .find((account) => account.id === accountId);
    if (used === undefined) return undefined;
    // Renewal authorizes the account for the profile's subject, as `resolve` does. A scheduled
    // call has no signed-in caller to fall back on.
    const usedFields = used.fields;
    const renewed = yield* oauth
      .renewRejected(selected.account, selected.definition, usedFields)
      .pipe(Effect.provideService(CurrentProfile, state.profile));
    if (sameFields(Redacted.value(renewed.fields), usedFields)) return undefined;
    yield* Effect.annotateCurrentSpan("executor.account.credentials_renewed", accountId);
    // Rebuilt from the renewed credential itself, so whether it is managed is whatever the
    // credential now is, even if a reconnect replaced it during this invocation.
    const definitions = new Map(
      state.selections.map(({ slot, required }) => [slot, required.definition] as const),
    );
    const replace =
      (slot: string) =>
      (account: HostAccount): HostAccount => {
        const definition = definitions.get(slot);
        return account.id === accountId && definition !== undefined
          ? invocationAccount(selected.account, definition, renewed, clients)
          : account;
      };
    return {
      accounts: Redacted.make(
        Object.fromEntries(
          Object.entries(accounts).map(([slot, value]) => [
            slot,
            isMany(value) ? value.map(replace(slot)) : replace(slot)(value),
          ]),
        ),
      ),
    } satisfies InvocationContext;
  });

function invocation(
  state: InvocationSnapshot,
  tool: ToolName,
  kind: ToolKind | undefined,
  input: Json,
) {
  return Schema.decodeUnknownEffect(ToolInvocation)({
    app: state.app.id,
    owner: state.app.owner,
    ...(state.profile === undefined
      ? {}
      : { profile: state.profile.id, profileRevision: state.profile.revision }),
    deployment: state.deployment.id,
    tool,
    ...(kind === undefined ? {} : { kind }),
    input,
    accounts: Object.fromEntries(
      state.selections.map(({ slot, required, accounts }) => {
        const identities = accounts.map(({ id, owner, provider, method }) => ({
          id,
          owner,
          provider,
          method,
        }));
        return [slot, required.cardinality === "many" ? identities : identities[0]];
      }),
    ),
  }).pipe(Effect.mapError(() => new StorageError()));
}

/**
 * Check failures that are answers: the saved call's app, deployment, profile or accounts are now
 * missing, inactive or different. Anything else, such as storage failing, answers nothing.
 */
const isContextChange = Schema.is(
  Schema.Union([
    AppNotFound,
    AppNotDeployed,
    DeploymentNotFound,
    ProfileNotFound,
    ProfileConflict,
    AccountNotFound,
    AccountSelectionInvalid,
    AccountRequired,
  ]),
);

/** A failure the app runtime reports for a call. */
type CallError = Effect.Error<ReturnType<Runtime["call"] | Runtime["query"] | Runtime["mutate"]>>;

/**
 * What renewing a refused account's credentials after a call that may write came to: the call is
 * never repeated, so its failure reports the renewal.
 */
type Renewal = "renewed" | RenewalFailure;

/** The typed error of a failed call. */
const runtimeFailure = (
  identity: { app: AppId; deployment: DeploymentId; tool: ToolName },
  state: InvocationSnapshot,
  renewal: Renewal | undefined,
) =>
  Match.type<CallError>().pipe(
    Match.tagsExhaustive({
      ProviderError: (error) => appProviderFailure(state, error, renewal),
      OpenapiResponseError: ({ code, status, message, recovery }) =>
        new ToolCallFailed({
          ...identity,
          reason: message,
          response: { code, status, message, ...(recovery === undefined ? {} : { recovery }) },
        }),
      WorkflowFailure: () =>
        new ToolCallFailed({ ...identity, reason: "Workflow operation failed" }),
      ElicitationFailed: ({ reason }) => new ToolElicitationFailed({ ...identity, reason }),
      HostToolNotFound: () => new ToolNotFound(identity),
      HostOperationNotFound: () => new ToolNotFound(identity),
      HostKindMismatch: ({ requested, actual }) =>
        new ToolKindMismatch({ ...identity, requested, actual }),
      HostOperationFailed: (error) =>
        Option.match(appFailure(error), {
          onNone: () => new ToolCallFailed({ ...identity, reason: "Operation execution failed" }),
          onSome: (failure) =>
            new ToolCallFailed({ ...identity, reason: appFailureText(failure), failure }),
        }),
      DatabaseLimitExceeded: (error) => {
        const failure = {
          source: "storage" as const,
          errorName: error._tag,
          code: error.limit,
          message: error.message,
        };
        return new ToolCallFailed({ ...identity, reason: appFailureText(failure), failure });
      },
      HostInputInvalid: ({ problems }) =>
        new InputInvalid({
          ...identity,
          problems:
            problems === undefined || problems.length === 0
              ? ["Input did not match the tool schema"]
              : problems,
        }),
      HostToolBlocked: () => new ToolBlocked(identity),
      HostToolApprovalRequired: () => new ToolApprovalRequired(identity),
      HostToolPolicyFailed: () => new ToolPolicyFailed(identity),
      HostOutputInvalid: () => new ToolCallFailed({ ...identity, reason: "Tool execution failed" }),
      HostRequestInvalid: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
      HostAccountsInvalid: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
      // Also how the app's framework reports an unexpected failure anywhere in its handling of
      // the call, including after the handler returned, so it is not reported as a failure to
      // load the app's tools.
      HostDeclarationInvalid: () =>
        new ToolCallFailed({
          ...identity,
          reason:
            "Executor did not receive a usable result from this tool call. The app’s framework reported an invalid declaration or an unexpected failure while handling it.",
        }),
      HostEvaluationFailed: (error) => evaluationFailure(identity, error),
      SkillLoadFailed: (error) => evaluationFailure(identity, error),
      McpError: (error) => operationMcpFailure(identity, error),
      RuntimeBuildUnavailable: () =>
        new AppEvaluationFailed({ ...identity, reason: "App evaluation failed" }),
      // The runtime's reply to the call was lost or unusable, which can happen after the tool ran,
      // so it is not reported as a failure to load the app's tools.
      RuntimeProtocolFailed: () =>
        new ToolCallFailed({
          ...identity,
          reason: "Executor did not receive a usable result from this tool call.",
        }),
      RuntimeProtocolUnsupported: (error) =>
        new AppEvaluationFailed({ ...identity, reason: error.message }),
    }),
  );

/**
 * The error a failed call reports to its caller, such as an agent. A call that may write, a
 * mutation or a call that names no kind, may already have made its change once the host handed any of
 * its work to the app's code, or may still make it, whatever failed: the app's factory, account
 * hooks, approval policy and handler all run there, and every failure reported from there passes
 * through code the app controls, its name and fields included. So does a failure of Executor's own
 * work after the hand-off, such as saving an approval request. Its error records that, so it leads
 * with Executor's instruction not to repeat the call and is never offered as a retry. That includes
 * a refusal, such as invalid input or a denied approval, which the app's reply reports. A failure
 * before the host handed over any work, and every failure of a query, keep their own
 * classification.
 */
const callFailure =
  (kind: ToolKind | undefined, enteredApp: boolean) =>
  (failure: CallFailure): CallFailure =>
    kind === "query" || !enteredApp
      ? failure
      : Match.value(failure).pipe(
          Match.tagsExhaustive({
            ToolCallFailed: (failure) => mayHaveWritten(ToolCallFailed, failure),
            AppProviderFailed: (failure) => mayHaveWritten(AppProviderFailed, failure),
            AppEvaluationFailed: (failure) => mayHaveWritten(AppEvaluationFailed, failure),
            ToolElicitationFailed: (failure) => mayHaveWritten(ToolElicitationFailed, failure),
            ToolNotFound: (failure) => mayHaveWritten(ToolNotFound, failure),
            ToolKindMismatch: (failure) => mayHaveWritten(ToolKindMismatch, failure),
            InputInvalid: (failure) => mayHaveWritten(InputInvalid, failure),
            ToolBlocked: (failure) => mayHaveWritten(ToolBlocked, failure),
            ToolApprovalRequired: (failure) => mayHaveWritten(ToolApprovalRequired, failure),
            ToolPolicyFailed: (failure) => mayHaveWritten(ToolPolicyFailed, failure),
            StorageError: (failure) => mayHaveWritten(StorageError, failure),
            CredentialsError: (failure) => mayHaveWritten(CredentialsError, failure),
          }),
        );

/**
 * Report a defect that a call's failure replaces for its caller: the host's error reporter, such as
 * Sentry, captures it, and the call's span records it as the tracer records a defect it ends with.
 */
const reportDefect = (cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    yield* ErrorReporter.report(cause);
    const span = yield* Effect.option(Effect.currentSpan);
    if (Option.isNone(span)) return;
    const time = yield* Clock.currentTimeNanos;
    for (const error of Cause.prettyErrors(recordedCause(cause), { includeCauseInStack: true }))
      span.value.event("exception", time, {
        "exception.type": error.name,
        "exception.message": error.message,
        "exception.stacktrace": error.stack ?? "No stack trace available",
      });
  });

/** A listed tool without its schemas. */
const summarizeTool = ({
  inputSchema: _input,
  outputSchema: _output,
  _meta,
  ...summary
}: Tool): ToolSummary => summary;

/** Live calls return completion or a durable approval request. Resume trusts the supplied SDK decision. */
export const makeTools = (
  storage: ExecutorDatabase,
  oauth: Pick<ReturnType<typeof makeOAuth>, "resolveSelected" | "renewRejected" | "usable">,
  clients: ReadonlyMap<string, FirstPartyOAuthClient>,
  runtime: Runtime,
  credentials: Credentials,
  crypto: Crypto.Crypto,
  listings: Listings,
  workflows?: (state: InvocationSnapshot) => WorkflowHostControls,
  lifecycle?: ResourceLifecycle,
) => {
  const db = database(storage);
  const resolveAccount = oauth.resolveSelected;
  const approvals = makeToolApprovals(db, credentials, crypto, storage.reactivity.inTransaction);
  /** Renew an account the service refused without repeating what it refused; undefined when none was. */
  const renewOnce = (state: InvocationSnapshot, context: InvocationContext, error: unknown) =>
    renewRefused(oauth, clients, state, context, error).pipe(
      Effect.result,
      Effect.map((renewed): Renewal | undefined =>
        Result.isFailure(renewed)
          ? renewed.failure
          : renewed.success === undefined
            ? undefined
            : "renewed",
      ),
    );
  /** The typed error of a catalog evaluation, with the renewal of an account it refused. */
  const catalogFailure = (
    state: InvocationSnapshot,
    error: Effect.Error<ReturnType<typeof runtime.index>>,
    renewal?: Renewal,
  ) =>
    Schema.is(ProviderError)(error)
      ? appProviderFailure(state, error, renewal)
      : evaluationFailure({ app: state.app.id, deployment: state.deployment.id }, error);
  /**
   * Run a tool, live or approved, and renew an account the service refuses. A 401 means the
   * service did not perform the refused request, but an earlier request in the same call may
   * already have made changes. A query only reads, so it is repeated once with the renewed
   * credentials, and a failed renewal is its failure. A call that may write is never repeated: the
   * renewal, renewed or failed, comes after the call was dispatched, so it is reported with the
   * call's failure rather than in its place.
   */
  const executeRenewing = <A, E, R>(
    state: InvocationSnapshot,
    context: InvocationContext,
    kind: ToolKind | undefined,
    execute: (context: InvocationContext) => Effect.Effect<Result.Result<A, E>, never, R>,
  ) =>
    Effect.gen(function* () {
      const result = yield* execute(context);
      if (Result.isSuccess(result)) return { result };
      if (kind === "query") {
        const renewed = yield* renewRefused(oauth, clients, state, context, result.failure);
        if (renewed === undefined) return { result };
        yield* Effect.annotateCurrentSpan("executor.tool.retry", "credentials_renewed");
        return { result: yield* execute(renewed) };
      }
      const renewal = yield* renewOnce(state, context, result.failure);
      return { result, renewal };
    });
  /** Runtime options that evaluate one invocation's catalog with its resolved accounts. */
  const inspection = (state: InvocationSnapshot, context: InvocationContext) => ({
    app: state.app.id,
    build: state.deployment.build,
    ...context,
    ...(workflows === undefined ? {} : { workflowControls: workflows(state) }),
  });
  /**
   * Evaluate a catalog and renew an account the service refuses while it is evaluated. Inspection
   * only reads, so it is repeated once with the renewed credentials. Every catalog read, including
   * the tool listing that MCP discovery serves, goes through here.
   */
  const inspectRenewing = <A, R>(
    state: InvocationSnapshot,
    context: InvocationContext,
    inspect: (
      context: InvocationContext,
    ) => Effect.Effect<A, Effect.Error<ReturnType<typeof runtime.index>>, R>,
  ) =>
    inspect(context).pipe(
      Effect.catch((error) =>
        renewRefused(oauth, clients, state, context, error).pipe(
          Effect.flatMap((renewed) =>
            renewed === undefined
              ? Effect.fail(catalogFailure(state, error))
              : inspect(renewed).pipe(Effect.mapError((error) => catalogFailure(state, error))),
          ),
        ),
      ),
    );
  /** Read the live catalog of a resolved invocation, renewing an account the service refuses. */
  const readCatalog = <A, R>(
    state: InvocationSnapshot,
    context: InvocationContext,
    read: (
      options: Parameters<typeof runtime.index>[0],
      toolIndex: boolean,
      scheduledTools: boolean,
    ) => Effect.Effect<A, Effect.Error<ReturnType<typeof runtime.index>>, R>,
  ) =>
    inspectRenewing(state, context, (context) =>
      read(
        inspection(state, context),
        state.deployment.requirements.capabilities?.toolIndex === true,
        state.deployment.requirements.capabilities?.scheduledTools === true,
      ),
    );
  /** Inspect the live catalog for one tool, or all of it on builds without a tool index. */
  const inspectTool = (state: InvocationSnapshot, name: ToolName, context: InvocationContext) =>
    runtime.inspect(
      state.deployment.requirements.capabilities?.toolIndex === true
        ? { ...inspection(state, context), tools: [name] }
        : inspection(state, context),
    );
  /** The named tool of an evaluated catalog; ToolNotFound when it is absent. */
  const found =
    (state: InvocationSnapshot, name: ToolName) =>
    ({ tools, routers }: Effect.Success<ReturnType<typeof runtime.inspect>>) =>
      Effect.gen(function* () {
        const tool = tools.find((tool) => tool.name === name);
        if (tool !== undefined) return tool;
        // A tool under a router that could not be read fails with that router's error.
        const failed = routers.find(
          (router) => router.error !== undefined && name.startsWith(`${router.path}.`),
        )?.error;
        if (failed !== undefined)
          return yield* Schema.is(ProviderError)(failed)
            ? appProviderFailure(state, failed)
            : evaluationFailure({ app: state.app.id, deployment: state.deployment.id }, failed);
        return yield* new ToolNotFound({
          app: state.app.id,
          deployment: state.deployment.id,
          tool: name,
        });
      });
  /** Describe one tool of the live catalog; ToolNotFound when it is absent. */
  const describe = (state: InvocationSnapshot, context: InvocationContext, name: ToolName) =>
    inspectRenewing(state, context, (context) => inspectTool(state, name, context)).pipe(
      Effect.flatMap(found(state, name)),
    );
  /**
   * The kind of a call that names none, from the live catalog. Evaluating the catalog runs the
   * app's code, which may write before it fails, and the call may write, so the catalog is
   * evaluated once: a refused account is renewed, and the failure reports that renewal, as a call
   * that may write does.
   */
  const catalogKind = (state: InvocationSnapshot, context: InvocationContext, name: ToolName) =>
    inspectTool(state, name, context).pipe(
      Effect.catch((error) =>
        renewOnce(state, context, error).pipe(
          Effect.flatMap((renewal) => Effect.fail(catalogFailure(state, error, renewal))),
        ),
      ),
      Effect.flatMap(found(state, name)),
    );
  /**
   * The caller's kind, or the kept listing's for a caller that did not name one, so the call of an
   * app with a database loads only its data facet, not the app's Worker too. Only the first call of
   * an invocation state with no kept listing evaluates it, and an aged listing is not refreshed for
   * this. That evaluation uses the accounts the call resolved, so the call renews a grant once. A
   * tool the listing does not name, such as one a dynamic source resolves on demand or one added
   * since the listing was evaluated, is described live from one evaluation of the catalog; one the catalog does not list either is
   * called without a kind: the app applies the tool's own kind and storage opens for writing.
   */
  const kindOf = (
    state: InvocationSnapshot,
    context: InvocationContext,
    name: ToolName,
    kind: ToolKind | undefined,
  ) =>
    kind === undefined
      ? listings.read(state, callListingOf(state), { refreshStale: false, resolved: context }).pipe(
          Effect.map((listing) => listing.items.find((tool) => tool.name === name)),
          // A listing that did not finish says nothing about the tool.
          Effect.catchTag("ToolListingTimedOut", () => Effect.succeed(undefined)),
          Effect.flatMap((listed) =>
            listed === undefined ? catalogKind(state, context, name) : Effect.succeed(listed),
          ),
          Effect.map((tool): ToolKind | undefined =>
            tool.readOnly === true ? "query" : "mutation",
          ),
          Effect.catchTag("ToolNotFound", () => Effect.succeed(undefined)),
          Effect.withSpan("sdk.tools.kind"),
        )
      : Effect.succeed(kind);
  /**
   * With the profile the host's check read ({@link InvocationSelection}), make the call's reads of
   * the app, the profile and its accounts, and the profile recheck, at once. The host's check has
   * finished, so each read still follows it. The snapshot uses a read only where the call's own
   * reads agree with what it was made for, and the recheck only when it ran for the profile and
   * accounts the call runs; failures are reported in the snapshot's order. A recheck after the
   * reads would come before the grant reads anyway, so running it beside them leaves nothing
   * older when the app starts. Without a matching selection, or without a profile, nothing is
   * read ahead.
   */
  const invocationReads = (
    selection: {
      readonly app: AppId;
      readonly owner: OwnerId;
      readonly profile: Profile;
    },
    /** Accounts whose grant rows to read too, for a host that sends them in the same batch. */
    grantsOf: readonly AccountId[] = [],
  ) => {
    const profile = selection.profile;
    const ids = selectionAccountIds(profile.accounts);
    const accounts = ids.map((id) => ({ id, owner: selection.owner }));
    const slots: {
      app?: SnapshotReads["app"];
      read?: Result.Result<Profile, Effect.Error<ReturnType<typeof storedProfile>>>;
      rows?: SelectionAccountsRead["rows"];
      recheck?: RecheckAhead["result"];
      grants?: Result.Result<ReadonlyArray<GrantRow>, StorageError>;
    } = {};
    const leaves: Array<Effect.Effect<void>> = [
      Effect.result(readApp(db, selection.app)).pipe(
        Effect.map((app) => {
          slots.app = app;
        }),
      ),
      Effect.result(
        storedProfile(db, { app: selection.app, profile: profile.id, owner: selection.owner }),
      ).pipe(
        Effect.map((read) => {
          slots.read = read;
        }),
      ),
      Effect.result(readSelectionAccounts(db, ids)).pipe(
        Effect.map((rows) => {
          slots.rows = rows;
        }),
      ),
    ];
    if (lifecycle?.profileResolving !== undefined)
      leaves.push(
        Effect.exit(
          lifecycle
            .profileResolving(profile, accounts)
            .pipe(Effect.withSpan("sdk.accounts.recheck")),
        ).pipe(
          Effect.map((recheck) => {
            slots.recheck = recheck;
          }),
        ),
      );
    if (grantsOf.length > 0)
      leaves.push(
        Effect.result(
          query(() => db.findMany("oauthGrants", { where: (b) => b("id", "in", grantsOf) })),
        ).pipe(
          Effect.map((grants) => {
            slots.grants = grants;
          }),
        ),
      );
    return {
      leaves,
      slots,
      take: () => {
        if (slots.app === undefined || slots.read === undefined || slots.rows === undefined)
          return undefined;
        return {
          reads: {
            app: slots.app,
            profile: { owner: selection.owner, read: slots.read },
            accounts: { ids, rows: slots.rows },
          } satisfies SnapshotReads,
          recheck:
            slots.recheck === undefined
              ? undefined
              : ({ profile, accounts, result: slots.recheck } satisfies RecheckAhead),
          grants:
            slots.grants === undefined || Result.isFailure(slots.grants)
              ? undefined
              : { ids: grantsOf, rows: slots.grants.success },
        };
      },
      /** Whether any read failed in storage: a batch that did is not used at all. */
      failed: () =>
        (
          [slots.app, slots.read, slots.rows, slots.grants] as ReadonlyArray<
            Result.Result<unknown, { readonly _tag: string }> | undefined
          >
        ).some(
          (read) =>
            read !== undefined && Result.isFailure(read) && read.failure._tag === "StorageError",
        ) ||
        (slots.recheck !== undefined && Exit.isFailure(slots.recheck)),
    };
  };
  type InvocationReads = NonNullable<ReturnType<ReturnType<typeof invocationReads>["take"]>>;
  /**
   * {@link PrefetchHost}: what `apps.get`, `apps.profiles.get` and the reads above return, read by
   * the host in one batch with its own checks. The hint says which of the live profile's accounts
   * resolve through a grant (see {@link GrantHint}), so the next batch reads only those grants. A
   * stale hint costs a grant read in the resolve loop, in the call's own order, never a different
   * answer.
   */
  const prefetchInvocation: PrefetchHost["invocation"] = (selection) => {
    const known = selection.known;
    const hint = known === undefined ? undefined : GrantHint.read(known.hint);
    const ids = known === undefined ? [] : selectionAccountIds(known.profile.accounts);
    // Grants of accounts the hint says hold none are not read; the resolve loop reads any it needs.
    const grantsOf = ids.filter((id) => hint?.get(id) !== false);
    const reads =
      known === undefined
        ? undefined
        : invocationReads(
            { app: selection.app, owner: selection.owner, profile: known.profile },
            grantsOf,
          );
    const slots: {
      app?: SnapshotReads["app"];
      read?: Result.Result<Profile, Effect.Error<ReturnType<typeof storedProfile>>>;
    } = reads?.slots ?? {};
    const leaves: ReadonlyArray<Effect.Effect<void>> = reads?.leaves ?? [
      Effect.result(readApp(db, selection.app)).pipe(
        Effect.map((app) => {
          slots.app = app;
        }),
      ),
      Effect.result(
        storedProfile(db, {
          app: selection.app,
          profile: selection.profile,
          owner: selection.owner,
        }),
      ).pipe(
        Effect.map((read) => {
          slots.read = read;
        }),
      ),
    ];
    // What `apps.get` returns for the row: it reads the app under its owner only.
    const asGot = (row: Effect.Success<ReturnType<typeof readApp>>) =>
      Effect.gen(function* () {
        if (row === null || row.owner !== selection.owner)
          return yield* new AppNotFound({ app: selection.app });
        return yield* gotApp(row);
      });
    const stored = (read: Result.Result<unknown, { readonly _tag: string }> | undefined) =>
      read !== undefined && Result.isFailure(read) && read.failure._tag === "StorageError";
    const take = Effect.gen(function* () {
      const app =
        slots.app === undefined
          ? undefined
          : Result.isFailure(slots.app)
            ? Result.fail(slots.app.failure)
            : yield* Effect.result(asGot(slots.app.success));
      const value = reads === undefined || reads.failed() ? undefined : reads.take();
      const live =
        slots.read !== undefined && Result.isSuccess(slots.read) ? slots.read.success : undefined;
      return {
        app,
        profile: slots.read,
        invocation:
          known === undefined || value === undefined
            ? undefined
            : { app: selection.app, owner: selection.owner, profile: known.profile, value },
        hint:
          app === undefined || Result.isFailure(app) || live === undefined
            ? undefined
            : grantHint(
                app.success,
                live,
                reads?.slots.rows !== undefined && Result.isSuccess(reads.slots.rows)
                  ? reads.slots.rows.success
                  : [],
              ),
        failed: reads?.failed() ?? (stored(slots.app) || stored(slots.read)),
      } satisfies PrefetchedInvocation;
    });
    return { leaves, take };
  };
  // A prefetch answers one call: it is provided around the whole host call, so a later call in
  // that scope (none today) must read live rather than reuse reads that may be seconds old.
  const consumedPrefetches = new WeakSet<object>();
  const readAhead = (input: { readonly app: AppId; readonly profile?: ProfileId | undefined }) =>
    Effect.gen(function* () {
      const selection = yield* InvocationSelection;
      if (
        selection === undefined ||
        input.profile === undefined ||
        selection.app !== input.app ||
        selection.profile.app !== input.app ||
        selection.profile.id !== input.profile
      )
        return undefined;
      // Made by the host in one batch with its checks, for exactly this selection.
      const prefetched = yield* InvocationPrefetch;
      if (
        prefetched !== undefined &&
        !consumedPrefetches.has(prefetched) &&
        prefetched.app === selection.app &&
        prefetched.owner === selection.owner &&
        sameProfile(prefetched.profile, selection.profile)
      ) {
        consumedPrefetches.add(prefetched);
        return prefetched.value as InvocationReads;
      }
      const reads = invocationReads(selection);
      yield* Effect.all(reads.leaves, { concurrency: "unbounded", discard: true });
      return reads.take();
    });
  /** Evaluate the selected profile's live catalog. */
  const evaluate = <A, R>(
    input: Parameters<Executor["tools"]["index"]>[0],
    read: (
      options: Parameters<typeof runtime.index>[0],
      /** Earlier builds reject index and filtered inspection; they only describe every tool. */
      toolIndex: boolean,
      /** Earlier builds reject scheduled inspection; they only describe every tool. */
      scheduledTools: boolean,
    ) => Effect.Effect<A, Effect.Error<ReturnType<typeof runtime.index>>, R>,
  ) =>
    Effect.gen(function* () {
      const state = yield* snapshot(db, input).pipe(Effect.withSpan("sdk.invocation.snapshot"));
      const context = yield* resolve(state, resolveAccount, lifecycle).pipe(
        Effect.withSpan("sdk.accounts.resolve"),
      );
      yield* Effect.annotateCurrentSpan({
        "executor.app.id": state.app.id,
        "executor.deployment.id": state.deployment.id,
        "executor.build.id": state.deployment.build,
      });
      return { deployment: state.deployment.id, value: yield* readCatalog(state, context, read) };
    });
  /** The invocation state a listing is read for, annotated on the caller's span. */
  const listed = (input: Parameters<typeof snapshot>[1]) =>
    Effect.gen(function* () {
      const state = yield* snapshot(db, input).pipe(Effect.withSpan("sdk.invocation.snapshot"));
      yield* Effect.annotateCurrentSpan({
        "executor.app.id": state.app.id,
        "executor.deployment.id": state.deployment.id,
        "executor.build.id": state.deployment.build,
      });
      return state;
    });
  /** Evaluate every tool of the catalog with schemas, sorted by name, for the listing store. */
  /** A catalog's tools as the listing store keeps them, sorted by name. */
  const toListing =
    (state: InvocationSnapshot) =>
    ({ tools, routers }: Effect.Success<ReturnType<typeof runtime.inspect>>): ToolListing => ({
      catalog: {
        deployment: state.deployment.id,
        ...(state.profile === undefined
          ? {}
          : { profile: state.profile.id, profileRevision: state.profile.revision }),
      },
      routers,
      items: [...tools]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((tool) => ({
          ...tool,
          app: state.app.id,
          deployment: state.deployment.id,
          name: ToolName.make(tool.name),
        })),
    });
  /** Evaluate every tool of the catalog with schemas, sorted by name, for the listing store. */
  const listingOf = (state: InvocationSnapshot) => (context: InvocationContext) =>
    inspectRenewing(state, context, (context) => runtime.inspect(inspection(state, context))).pipe(
      Effect.map(toListing(state)),
    );
  /**
   * The listing a call that names no kind evaluates when none is kept. Evaluating the catalog runs
   * the app's code, which may write before it fails, and the call may write, so it is evaluated
   * once: a refused account is renewed, and the failure reports that renewal, as a call that may
   * write does.
   */
  const callListingOf = (state: InvocationSnapshot) => (context: InvocationContext) =>
    runtime.inspect(inspection(state, context)).pipe(
      Effect.catch((error) =>
        renewOnce(state, context, error).pipe(
          Effect.flatMap((renewal) => Effect.fail(catalogFailure(state, error, renewal))),
        ),
      ),
      Effect.map(toListing(state)),
    );
  return {
    prefetchInvocation,
    /**
     * The first account selected by this profile whose saved sign-in must reconnect before the
     * profile's tools can run; undefined when every account can supply credentials. Reads stored
     * state only: it never renews a grant or evaluates the app.
     *
     * An account that must reconnect, or a required account that is not selected yet, is an
     * expected account state the owner resolves, not a fault of this check. It is recorded as the
     * span's `executor.accounts.outcome`; a missing account fails the caller only after the span.
     */
    accountNeedingReconnect: (input: { app: AppId; profile: ProfileId }) =>
      Effect.gen(function* () {
        const state = yield* snapshot(db, input);
        for (const { required, accounts } of state.selections)
          for (const account of accounts) {
            const usable = yield* oauth.usable(account, required.definition).pipe(Effect.result);
            if (Result.isFailure(usable)) {
              if (!Schema.is(OAuthReconnectRequired)(usable.failure))
                return yield* Effect.fail(usable.failure);
              yield* accountsOutcome("reconnect");
              return account.id;
            }
          }
        yield* accountsOutcome("ready");
        return undefined;
      }).pipe(
        Effect.catchIf(Schema.is(AccountRequired), (missing) =>
          accountsOutcome("account_required").pipe(Effect.as(missing)),
        ),
        Effect.withSpan("sdk.accounts.reconnectRequired", {
          attributes: { "executor.app.id": input.app, "executor.profile.id": input.profile },
        }),
        Effect.flatMap((found) =>
          Schema.is(AccountRequired)(found) ? Effect.fail(found) : Effect.succeed(found),
        ),
      ),
    /**
     * Page through the app's evaluated catalog. The whole listing is evaluated once and, with a
     * listing store, reused across pages and requests for identical inputs.
     */
    list: (input: Parameters<Executor["tools"]["list"]>[0], options?: ToolListOptions) =>
      Effect.gen(function* () {
        const state = yield* listed(input);
        const listing = yield* listings.read(state, listingOf(state), options);
        // Pages share the listing's item objects, so a caller can recognise a kept listing.
        const cursor: string | undefined = input.cursor;
        const after =
          cursor === undefined ? listing.items : listing.items.filter((tool) => tool.name > cursor);
        const selected = after.slice(0, input.limit ?? 2_000);
        const last = selected.at(-1);
        return {
          ...listing.catalog,
          routers: listing.routers,
          items: selected,
          ...(last !== undefined && after.length > selected.length
            ? { next: Cursor.make(last.name) }
            : {}),
        };
      }).pipe(Effect.withSpan("sdk.tools.list")),
    /** Keep the target's current listing as search rows; see `Listings.searchable`. */
    searchable: (
      input: Omit<Parameters<Executor["tools"]["list"]>[0], "cursor" | "limit">,
      options?: ToolListOptions,
    ) =>
      Effect.gen(function* () {
        const state = yield* listed(input);
        const found = yield* listings.searchable(state, listingOf(state), options);
        return {
          listing: found.listing,
          deployment: state.deployment.id,
          routers: found.routers.filter((router) => router.error !== undefined),
        };
      }).pipe(Effect.withSpan("sdk.tools.searchable")),
    /**
     * Describe the declared operations that have schedules. Current builds skip dynamic
     * tool discovery, which can compile a large catalog in the shared app runtime.
     */
    scheduled: (input: Parameters<Executor["tools"]["list"]>[0]) =>
      Effect.gen(function* () {
        const {
          deployment,
          value: { tools },
        } = yield* evaluate(input, (options, _toolIndex, scheduled) =>
          runtime.inspect(scheduled ? { ...options, scheduled: true } : options),
        );
        // Callers that act on the result can require that this deployment is still active.
        return {
          deployment,
          items: tools.flatMap((tool) =>
            (tool.schedules ?? []).map((schedule) => ({
              ...schedule,
              tool: ToolName.make(tool.name),
            })),
          ),
        };
      }).pipe(Effect.withSpan("sdk.tools.scheduled")),
    /**
     * The catalog without schemas, read from the same kept listing as `list`, so browsing an app
     * evaluates it no more often than MCP discovery does.
     */
    index: (input: Parameters<Executor["tools"]["index"]>[0]) =>
      Effect.gen(function* () {
        const state = yield* listed(input);
        const listing = yield* listings.read(state, listingOf(state));
        return {
          ...listing.catalog,
          routers: listing.routers,
          items: listing.items.map(summarizeTool),
        };
      }).pipe(Effect.withSpan("sdk.tools.index")),
    /**
     * One tool's schemas from the kept listing. A tool the listing does not name, such as one a
     * dynamic source resolves on demand or one added since the listing was evaluated, is described
     * live; a tool under a router the listing could not read fails with that router's error.
     */
    get: (input: Parameters<Executor["tools"]["get"]>[0]) =>
      Effect.gen(function* () {
        const state = yield* listed(input);
        const listing = yield* listings.read(state, listingOf(state));
        const kept = listing.items.find((tool) => tool.name === input.tool);
        if (kept !== undefined) {
          yield* Effect.annotateCurrentSpan("executor.tools.source", "listing");
          return kept;
        }
        const failed = listing.routers.find(
          (router) => router.error !== undefined && input.tool.startsWith(`${router.path}.`),
        )?.error;
        if (failed !== undefined)
          return yield* Schema.is(ProviderError)(failed)
            ? appProviderFailure(state, failed)
            : evaluationFailure({ app: state.app.id, deployment: state.deployment.id }, failed);
        yield* Effect.annotateCurrentSpan("executor.tools.source", "live");
        const context = yield* resolve(state, resolveAccount, lifecycle).pipe(
          Effect.withSpan("sdk.accounts.resolve"),
        );
        const tool = yield* describe(state, context, input.tool);
        return {
          ...tool,
          app: state.app.id,
          deployment: state.deployment.id,
          name: ToolName.make(tool.name),
        };
      }).pipe(Effect.withSpan("sdk.tools.get")),
    call: (input: Parameters<Executor["tools"]["call"]>[0], options?: ToolInvocationOptions) =>
      Effect.gen(function* () {
        if (yield* storage.reactivity.inTransaction) return yield* new RequestInvalid();
        const parsed = yield* Schema.decodeUnknownEffect(ToolInputs.call)(input).pipe(
          Effect.mapError(() => new RequestInvalid()),
        );
        // Round-trip before any async lookup: later caller mutations cannot change the dispatched or saved arguments.
        const args = yield* Schema.encodeEffect(Schema.fromJsonString(Json))(
          parsed.input === undefined ? {} : parsed.input,
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Json))),
          Effect.mapError(() => new RequestInvalid()),
        );
        const { ahead, state } = yield* Effect.gen(function* () {
          const ahead = yield* readAhead(parsed);
          const state = yield* snapshot(db, parsed, undefined, undefined, false, ahead?.reads);
          return { ahead, state };
        }).pipe(Effect.withSpan("sdk.invocation.snapshot"));
        // Grant rows read in the batch, for accounts this state holds, stand in for each grant's
        // first read; other accounts read theirs in the resolve loop.
        const held = new Set(selectionAccountIds(state.accounts));
        const grants =
          ahead?.grants !== undefined && ahead.grants.ids.every((id) => held.has(id))
            ? grantReadAhead(ahead.grants.ids, ahead.grants.rows)
            : undefined;
        const context = yield* resolve(state, resolveAccount, lifecycle, ahead?.recheck).pipe(
          Effect.withSpan("sdk.accounts.resolve"),
          Effect.provideService(GrantReadAhead, grants),
        );
        const identity = { app: state.app.id, deployment: state.deployment.id, tool: parsed.tool };
        yield* Effect.annotateCurrentSpan({
          "executor.app.id": state.app.id,
          "executor.deployment.id": state.deployment.id,
          "executor.build.id": state.deployment.build,
        });
        // Set by the host when it hands this call's work to the app's code: catalog reads for its
        // kind, and the call itself.
        let enteredApp = false;
        const appCode = {
          entered: () => {
            enteredApp = true;
          },
        };
        // The caller's kind decides how a failure is reported and whether a refused call is
        // repeated. For a call that names none, the catalog only names the kind it is dispatched
        // with: reading the catalog ran the app's code, so the call's outcome stays unknown.
        const named = parsed.kind;
        // Every failure from here, the app's or Executor's own, passes through `callFailure` once.
        return yield* Effect.gen(function* () {
          const kind = yield* kindOf(state, context, parsed.tool, named);
          let toolError = false;
          const execute = (context: InvocationContext) =>
            Effect.suspend(() => {
              toolError = false;
              return runtime.call({
                app: state.app.id,
                ...(workflows === undefined ? {} : { workflowControls: workflows(state) }),
                build: state.deployment.build,
                database: ownsDatabase(state.deployment.requirements),
                ...context,
                tool: parsed.tool,
                ...(kind === undefined ? {} : { kind }),
                input: args,
                ...(options?.elicitation === undefined ? {} : { elicitation: options.elicitation }),
              });
            }).pipe(
              Effect.provideService(ToolResultObservation, {
                failed: () => {
                  toolError = true;
                },
              }),
              Effect.result,
            );
          const { result, renewal } = yield* executeRenewing(state, context, named, execute);
          // The tool is named once the app has answered for it: a name it lacks is the caller's text.
          if (
            Result.isSuccess(result) ||
            (result.failure._tag !== "HostToolNotFound" &&
              result.failure._tag !== "HostOperationNotFound")
          )
            yield* Effect.annotateCurrentSpan("executor.tool.name", parsed.tool);
          if (Result.isSuccess(result)) {
            if (toolError)
              yield* Effect.annotateCurrentSpan({
                "executor.outcome": "failed",
                "error.type": "McpToolError",
              });
            return {
              status: "completed" as const,
              value: result.success,
              ...(toolError ? { toolError: true as const } : {}),
            };
          }
          // The app reports the decoded input it asks approval for; its prompt is not used.
          if (Schema.is(HostToolApprovalRequired)(result.failure)) {
            // The request saves the caller's kind, so its pending response and its resumption
            // treat a call that named none as one that may write.
            return yield* approvals.save(
              yield* invocation(state, parsed.tool, named, result.failure.input),
              args,
              options?.issuer,
            );
          }
          return yield* Effect.fail(runtimeFailure(identity, state, renewal)(result.failure));
        }).pipe(
          Effect.mapError((failure) =>
            // Only a query's renewal fails a call itself (`executeRenewing`), and a query keeps
            // its classification. A missing account is the host's finding while it resolves
            // accounts, before any of the app's code runs for it.
            failure._tag === "OAuthReconnectRequired" ||
            failure._tag === "OAuthRenewalFailed" ||
            failure._tag === "AccountRequired"
              ? failure
              : callFailure(named, enteredApp)(failure),
          ),
          // A defect after the hand-off, such as in Executor's own code, does not establish what
          // the app's code did either. A call that may write reports it as a failure that records
          // the write, and the defect is still reported as one. Interruption is unchanged.
          Effect.catchCause((cause) =>
            named === "query" || !enteredApp || !Cause.hasDies(cause) || Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : reportDefect(cause).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ToolCallFailed({
                        ...identity,
                        reason: "Executor failed unexpectedly while handling this tool call.",
                        mayHaveWritten: true,
                      }),
                    ),
                  ),
                ),
          ),
          Effect.provideService(AppCodeEntered, appCode),
        );
      }).pipe(Effect.withSpan("sdk.tools.call")),
    pruneApprovals: (input: Parameters<Executor["tools"]["pruneApprovals"]>[0] = {}) =>
      Schema.decodeUnknownEffect(ToolInputs.pruneApprovals)(input)
        .pipe(
          Effect.mapError(() => new RequestInvalid()),
          Effect.flatMap(({ owner }) => approvals.prune(owner)),
        )
        .pipe(Effect.withSpan("sdk.tools.pruneApprovals")),
    approval: (input: Parameters<Executor["tools"]["approval"]>[0]) =>
      approvals.get(input.requestId, input.owner).pipe(Effect.withSpan("sdk.tools.approval")),
    resume: (input: Parameters<Executor["tools"]["resume"]>[0], options?: ToolInvocationOptions) =>
      Schema.decodeUnknownEffect(ToolInputs.resume)(input, { onExcessProperty: "error" })
        .pipe(
          Effect.mapError(() => new RequestInvalid()),
          Effect.flatMap((input) =>
            approvals.resume(input, options?.issuer, (saved, originalInput) =>
              Effect.gen(function* () {
                const checked = yield* snapshot(db, {
                  app: saved.app,
                  deployment: saved.deployment,
                  profile: saved.profile,
                  expectedProfileRevision: saved.profileRevision,
                }).pipe(
                  Effect.withSpan("sdk.invocation.snapshot"),
                  Effect.flatMap((state) =>
                    invocation(state, saved.tool, saved.kind, saved.input).pipe(
                      Effect.map((current) => ({ state, current })),
                    ),
                  ),
                  Effect.result,
                );
                // A failed read shows nothing about the context: only an answer that differs does.
                if (Result.isFailure(checked) && !isContextChange(checked.failure)) {
                  yield* Effect.annotateCurrentSpan({
                    "executor.outcome": "failed",
                    "error.type": checked.failure._tag,
                  });
                  return {
                    status: "failed",
                    requestId: input.requestId,
                    reason: "execution-failed",
                    error: checked.failure,
                    context: "unconfirmed",
                  } satisfies ToolResumeResult;
                }
                if (
                  Result.isFailure(checked) ||
                  !Schema.toEquivalence(ToolInvocation)(saved, checked.success.current)
                ) {
                  return {
                    status: "failed",
                    requestId: input.requestId,
                    reason: "context-changed",
                  } satisfies ToolResumeResult;
                }
                const { state } = checked.success;
                return yield* Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({
                    "executor.app.id": saved.app,
                    "executor.deployment.id": saved.deployment,
                    "executor.build.id": state.deployment.build,
                    "executor.tool.name": saved.tool,
                    "executor.approval.id": input.requestId,
                  });
                  const context = yield* resolve(state, resolveAccount, lifecycle).pipe(
                    Effect.withSpan("sdk.accounts.resolve"),
                  );
                  // Set by the host when it hands this call's work to the app's code, as for a call.
                  let enteredApp = false;
                  // As for a call, every failure from here passes through `callFailure` once, so a
                  // resumed call that may write reports what it failed with as possibly written.
                  return yield* Effect.gen(function* () {
                    const kind = yield* kindOf(state, context, saved.tool, saved.kind);
                    let toolError = false;
                    const execute = (context: InvocationContext) =>
                      Effect.suspend(() => {
                        toolError = false;
                        return runtime.call({
                          app: saved.app,
                          ...(workflows === undefined
                            ? {}
                            : { workflowControls: workflows(state) }),
                          build: state.deployment.build,
                          database: ownsDatabase(state.deployment.requirements),
                          ...context,
                          tool: saved.tool,
                          ...(kind === undefined ? {} : { kind }),
                          input: originalInput,
                          approval: { tool: saved.tool, input: saved.input },
                          ...(options?.elicitation === undefined
                            ? {}
                            : { elicitation: options.elicitation }),
                        });
                      }).pipe(
                        Effect.provideService(ToolResultObservation, {
                          failed: () => {
                            toolError = true;
                          },
                        }),
                        Effect.result,
                      );
                    // As for a call, the saved (caller's) kind decides whether a refused call is
                    // repeated; the catalog's only sets the dispatched kind.
                    const { result, renewal } = yield* executeRenewing(
                      state,
                      context,
                      saved.kind,
                      execute,
                    );
                    if (Result.isFailure(result))
                      return yield* Effect.fail(
                        runtimeFailure(
                          { app: saved.app, deployment: saved.deployment, tool: saved.tool },
                          state,
                          renewal,
                        )(result.failure),
                      );
                    const value = result.success;
                    if (toolError)
                      yield* Effect.annotateCurrentSpan({
                        "executor.outcome": "failed",
                        "error.type": "McpToolError",
                      });
                    return {
                      status: "completed" as const,
                      value,
                      ...(toolError ? { toolError: true as const } : {}),
                    };
                  }).pipe(
                    Effect.mapError((failure) =>
                      failure._tag === "OAuthReconnectRequired" ||
                      failure._tag === "OAuthRenewalFailed" ||
                      failure._tag === "AccountRequired"
                        ? failure
                        : callFailure(saved.kind, enteredApp)(failure),
                    ),
                    Effect.provideService(AppCodeEntered, {
                      entered: () => {
                        enteredApp = true;
                      },
                    }),
                  );
                }).pipe(
                  // The request is consumed, so its caller receives the call's own failure.
                  Effect.catch((error) =>
                    Effect.succeed({
                      status: "failed" as const,
                      requestId: input.requestId,
                      reason: "execution-failed" as const,
                      error,
                    } satisfies ToolResumeResult),
                  ),
                );
              }),
            ),
          ),
        )
        .pipe(Effect.withSpan("sdk.tools.resume")),
  };
};
