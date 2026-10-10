import {
  AccountNotFound,
  AppNotDeployed,
  DeploymentNotFound,
  StorageError,
} from "@executor-js/sdk/core";
import {
  requireAppAccess,
  accountAccesses,
  currentResourceAuthority,
  resourceAuthorityForSelection,
  type ResourceAuthority,
} from "./resource-policy.ts";
import type {
  App,
  AppId,
  Profile,
  ProfileId,
  AccountConnectionId,
  AccountId,
  Executor,
  OwnerId,
  SelectedAccounts,
} from "@executor-js/sdk/core";
import { Context, Effect, type Exit, Result } from "effect";
import { HttpServerRequest } from "effect/http";
import { CurrentUserId, Forbidden } from "../contracts/auth.ts";
import {
  CurrentOrganization,
  OrganizationForbidden,
  type OrganizationId,
  organizationOwner,
} from "../contracts/organization.ts";
import type { AccountAccess } from "../contracts/resource-access.ts";

/** A person's own decisions come from their signed-in browser, never from an API credential. */
export const browserOnly = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.authorization !== undefined) return yield* new Forbidden();
});
/** Membership was checked by middleware; administrative actions require the current role. */
export const requireOrganizationAdmin = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  if (organization.role === "member") return yield* new OrganizationForbidden();
  return organization;
});
/** Only an owner may remove the organization itself. */
export const requireOrganizationOwner = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  if (organization.role !== "owner") return yield* new OrganizationForbidden();
  return organization;
});
/** Server-derived owners are the only owners used by hosted HTTP handlers. */
export const currentOwner = Effect.map(CurrentOrganization, (organization) => organization.owner);
/** Resolve administrative authority before opening the SDK or performing work. */
export const adminOwner = Effect.map(
  requireOrganizationAdmin,
  (organization) => organization.owner,
);

/** Account use requires its independent sharing policy as well as the SDK tenant check. */
export const checkAccounts = (owner: OwnerId, accounts: SelectedAccounts) =>
  Effect.flatMap(currentResourceAuthority, (actor) => checkAccountsAs(actor, owner, accounts));
export const selectedAccounts = (accounts: SelectedAccounts) =>
  Object.values(accounts).flatMap((selection) =>
    typeof selection === "string" ? [selection] : selection,
  );
/**
 * Check the selected accounts in selection order against their policies. A policy row exists
 * only for an account the actor's organization owns, so it also stands in for the SDK's
 * owned-account read.
 */
const permitAccounts = (
  actor: ResourceAuthority,
  owner: OwnerId,
  accounts: SelectedAccounts,
  policies: ReadonlyArray<typeof AccountAccess.Type>,
) =>
  Effect.gen(function* () {
    const byAccount = new Map(policies.map((access) => [access.account, access]));
    for (const account of selectedAccounts(accounts)) {
      const access = byAccount.get(account);
      if (access === undefined || !access.canUse) return yield* new OrganizationForbidden();
      if (owner !== organizationOwner(actor.organization))
        return yield* new AccountNotFound({ account });
    }
  });
/** Account policies are read in one statement and checked in selection order. */
export const checkAccountsAs = (
  actor: ResourceAuthority,
  owner: OwnerId,
  accounts: SelectedAccounts,
) =>
  Effect.gen(function* () {
    const selected = selectedAccounts(accounts);
    if (selected.length === 0) return;
    yield* permitAccounts(
      actor,
      owner,
      accounts,
      yield* accountAccesses([...new Set(selected)], actor),
    );
  });
type ProfileRead = Effect.Effect<
  Profile,
  Effect.Error<ReturnType<Executor["apps"]["profiles"]["get"]>>
>;
/**
 * The app and profile a selection check reads, and what they were read for. The check uses them
 * only for the selected account IDs, the deployment pin and the order of its failures; a tool
 * call reads its own state after the check.
 */
export interface SelectionReads {
  readonly owner: OwnerId;
  readonly app: AppId;
  readonly profile: ProfileId | undefined;
  readonly current: Result.Result<App, Effect.Error<ReturnType<Executor["apps"]["get"]>>>;
  readonly selected:
    | Result.Result<Profile, Effect.Error<ReturnType<Executor["apps"]["profiles"]["get"]>>>
    | undefined;
}
/**
 * Whether a read made ahead answered: it stands in for the read it was made for unless it failed
 * for storage. Reads made at once share a connection, so one dropped after the recheck's reply
 * fails the rest; read in order, the same read could reach a fresh connection.
 */
const answered = <A, E extends { readonly _tag: string }>(read: Result.Result<A, E>) =>
  Result.isSuccess(read) || read.failure._tag !== "StorageError";
/**
 * The access fold an MCP tool call made in one batch with its recheck and selection reads, and
 * what it was made for. {@link checkedSelection} uses its result, at the point where it would run
 * the fold, only for the same organization, user, app and account IDs; otherwise it runs the fold.
 */
export const FoldReadAhead = Context.Reference<
  | {
      readonly organization: OrganizationId;
      readonly user: string;
      readonly app: AppId;
      readonly accounts: readonly AccountId[];
      readonly result: Exit.Exit<
        Effect.Success<ReturnType<typeof resourceAuthorityForSelection>>,
        Effect.Error<ReturnType<typeof resourceAuthorityForSelection>>
      >;
    }
  | undefined
>("hosted/FoldReadAhead", { defaultValue: () => undefined });
const sameAccounts = (left: readonly AccountId[], right: readonly AccountId[]) => {
  const ids = new Set(left);
  return ids.size === new Set(right).size && right.every((id) => ids.has(id));
};
/**
 * The selection reads an MCP tool call made beside its authentication recheck, for the call it
 * is about to make. Unset everywhere else.
 */
export const SelectionReadAhead = Context.Reference<SelectionReads | undefined>(
  "hosted/SelectionReadAhead",
  { defaultValue: () => undefined },
);
/**
 * The app and profile reads of {@link selectedApp}, made at once. Only a host whose SQL client
 * sends concurrent statements together should ask for them this way (see
 * `ConcurrentStatements`); elsewhere the second read would wait for, or open, another connection.
 */
export const readSelection = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  profile: ProfileId | undefined,
) =>
  Effect.all(
    [
      Effect.result(executor.apps.get({ owner, app })),
      profile === undefined
        ? Effect.succeed(undefined)
        : Effect.result(executor.apps.profiles.get({ app, owner, profile })),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([current, selected]): SelectionReads => ({
      owner,
      app,
      profile,
      current,
      selected,
    })),
  );
/**
 * Check both the configured app and every selected account before evaluating its code. The app
 * and profile are read first, so membership and the app's and accounts' policies take one
 * statement; failures are still reported in the order the checks run. A tool call then reads its
 * own state, after these checks. `read` is those two reads made earlier by the caller, used only
 * when they were made for this owner, app and profile, and each only when it answered. Returns the app and the checked profile.
 */
export const checkedSelection = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  profile?: ProfileId,
  read?: SelectionReads,
) =>
  Effect.gen(function* () {
    const reads =
      read !== undefined && read.owner === owner && read.app === app && read.profile === profile
        ? read
        : undefined;
    const current =
      reads !== undefined && answered(reads.current)
        ? reads.current
        : yield* Effect.result(executor.apps.get({ owner, app }));
    const selected =
      profile === undefined
        ? undefined
        : reads?.selected !== undefined && answered(reads.selected)
          ? reads.selected
          : yield* Effect.result(executor.apps.profiles.get({ app, owner, profile }));
    const organization = (yield* CurrentOrganization).organization;
    const user = yield* CurrentUserId;
    const ids =
      selected === undefined || Result.isFailure(selected)
        ? []
        : [...new Set(selectedAccounts(selected.success.accounts))];
    const fold = yield* FoldReadAhead;
    const { actor, access, accounts } =
      fold !== undefined &&
      fold.organization === organization &&
      fold.user === user &&
      fold.app === app &&
      sameAccounts(fold.accounts, ids)
        ? yield* fold.result
        : yield* resourceAuthorityForSelection(organization, user, app, ids);
    if (!access.canUse) return yield* new OrganizationForbidden();
    const found = yield* Effect.fromResult(current);
    if (selected === undefined) return { app: found, profile: undefined };
    const checked = yield* ownedBy(actor, Effect.fromResult(selected));
    yield* permitAccounts(actor, owner, checked.accounts, yield* accounts);
    return { app: found, profile: checked };
  });
/** {@link checkedSelection}'s app. */
export const selectedApp = (executor: Executor, owner: OwnerId, app: AppId, profile?: ProfileId) =>
  Effect.map(checkedSelection(executor, owner, app, profile), (checked) => checked.app);
/**
 * New tool discovery and calls use the active build; retained execution is reserved for saved
 * invocations. Returns the pinned deployment and the checked profile.
 */
export const checkedActiveDeployment = (
  executor: Executor,
  owner: OwnerId,
  input: Parameters<Executor["tools"]["list"]>[0],
  read?: SelectionReads,
) =>
  Effect.gen(function* () {
    const { app, profile } = yield* checkedSelection(
      executor,
      owner,
      input.app,
      input.profile,
      read,
    );
    if (input.deployment !== undefined && input.deployment !== app.activeDeployment)
      return yield* new DeploymentNotFound({ app: app.id, deployment: input.deployment });
    if (app.activeDeployment === null) return yield* new AppNotDeployed({ app: app.id });
    // Pin the authorized version so a concurrent promotion cannot silently change the call.
    return { deployment: app.activeDeployment, profile };
  });
/** {@link checkedActiveDeployment}'s pinned deployment. */
export const selectedActiveDeployment = (
  executor: Executor,
  owner: OwnerId,
  input: Parameters<Executor["tools"]["list"]>[0],
) => Effect.map(checkedActiveDeployment(executor, owner, input), (checked) => checked.deployment);

/** Setup identity remains private even when every selected account is shared. Allows own cleanup after revocation. */
export const ownProfile = (executor: Executor, owner: OwnerId, app: AppId, profile: ProfileId) =>
  Effect.flatMap(currentResourceAuthority, (actor) =>
    ownProfileAs(actor, executor, owner, app, profile),
  );
export const ownProfileAs = (
  actor: ResourceAuthority,
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  profile: ProfileId,
) => ownedBy(actor, executor.apps.profiles.get({ app, owner, profile }));
/** The setup subject is the actor; another user's profile is forbidden, not missing. */
const ownedBy = (actor: ResourceAuthority, read: ProfileRead) =>
  Effect.gen(function* () {
    const selected = yield* read.pipe(
      Effect.catchTags({
        ProfileNotFound: () => new OrganizationForbidden(),
        ProfileConflict: () => new StorageError(),
        AccountSelectionInvalid: () => new StorageError(),
      }),
    );
    if (selected.subject !== actor.user) return yield* new OrganizationForbidden();
    return selected;
  });
/** The caller's own profile and every account it selects, reading the caller's membership once. */
export const selectedProfile = (
  executor: Executor,
  owner: OwnerId,
  app: AppId,
  profile: ProfileId,
) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const selected = yield* ownProfileAs(actor, executor, owner, app, profile);
    yield* checkAccountsAs(actor, owner, selected.accounts);
    return selected;
  });
/** App-only resources require app management; profile resources require their subject. */
export const executionManagerOwner = (executor: Executor, app: AppId, profile?: ProfileId) =>
  Effect.gen(function* () {
    const owner = yield* currentOwner;
    if (profile === undefined) yield* requireAppAccess(app, "manage");
    else yield* ownProfile(executor, owner, app, profile);
    return owner;
  });
/** A connection must still belong to this organization, along with its target app. */
export const ownedConnection = (
  executor: Executor,
  owner: OwnerId,
  connection: AccountConnectionId,
) =>
  Effect.gen(function* () {
    const current = yield* executor.accountConnections.get({ owner, connection });
    yield* executor.apps.get({ owner, app: current.target.app });
    return current;
  });

/** App creators and admins manage settings; this does not authorize account-backed execution. */
export const appManagerOwner = (app: AppId) =>
  requireAppAccess(app, "manage").pipe(Effect.andThen(currentOwner));
/** Metadata reads include separate management access, without selecting credentials. */
export const appReaderOwner = (app: AppId) =>
  requireAppAccess(app, "read").pipe(Effect.andThen(currentOwner));

/** Pending approvals retain their original accounts even if current app bindings later change. */
export const checkInvocationAccounts = (
  executor: Executor,
  owner: OwnerId,
  invocation: import("@executor-js/sdk/core").ToolInvocation,
) =>
  Effect.gen(function* () {
    if (invocation.profile !== undefined)
      yield* ownProfile(executor, owner, invocation.app, invocation.profile);
    yield* checkAccounts(
      owner,
      Object.fromEntries(
        Object.entries(invocation.accounts).map(([slot, selected]) => [
          slot,
          "id" in selected ? selected.id : selected.map((account) => account.id),
        ]),
      ),
    );
  });
