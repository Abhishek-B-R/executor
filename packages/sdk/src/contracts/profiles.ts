import { UserFacingError } from "@executor-js/utils/user-facing-error";
/** Durable account bindings and setup state for one use of an app. Deployments belong to the app. */
import { Context, Schema, type Effect, type Result } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AppId, OwnerId, ProfileId, DeploymentId, StorageError } from "./shared.ts";
import { AppNotFound, AccountSelectionInvalid, SelectedAccounts } from "./apps.ts";
import { AccountNotFound } from "./account.ts";
import type { Executor } from "./executor.ts";

/** A revision protects account choices and durable setup against concurrent updates. */
export const ProfileRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
/** Setup input is app-owned configuration, not provider credentials. */
export const ProfileWebhookConfig = Schema.Record(Schema.NonEmptyString, Schema.Json);
/** A profile never selects its own code version or owns a separate database. */
/** The immutable creation request a profile was made from; later selection edits never change it. */
export const ProfileRequest = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  accounts: SelectedAccounts,
  webhookConfig: ProfileWebhookConfig,
});
export type ProfileRequest = typeof ProfileRequest.Type;
export const Profile = Schema.Struct({
  id: ProfileId,
  app: AppId,
  idempotencyKey: Schema.NonEmptyString,
  request: ProfileRequest,
  owner: OwnerId,
  subject: Schema.NonEmptyString,
  name: Schema.NullOr(Schema.NonEmptyString.check(Schema.isMaxLength(128))),
  accounts: SelectedAccounts,
  webhookConfig: ProfileWebhookConfig,
  revision: ProfileRevision,
  enabled: Schema.Boolean,
  status: Schema.Literals([
    "pending",
    "ready",
    "needs-setup",
    "failed",
    "disabled",
    "removing",
    "removed",
  ]),
  failure: Schema.NullOr(
    Schema.Literals([
      "accounts",
      "configuration",
      "registration",
      "cleanup",
      "access",
      "deployment",
    ]),
  ),
  reconciledDeployment: Schema.NullOr(DeploymentId),
  reconciledRevision: Schema.NullOr(ProfileRevision),
  createdAt: Schema.Date,
});
export type Profile = typeof Profile.Type;

/** Trusted invocation metadata for product credential policy; never supplied by authored code. */
export const CurrentProfile = Context.Reference<Profile | undefined>("executor/CurrentProfile", {
  defaultValue: () => undefined,
});
/**
 * Host-only: the profile the host's own access check read for the tool call it is about to make,
 * and the app's owner it read it under. With it, `tools.call` reads the app, the profile and the
 * accounts that profile selects, and runs the profile recheck, in one round trip instead of one
 * after another. Nothing here is trusted. The call still makes every read, after the host's
 * check, and uses a read made with these values only when its own app and profile reads agree
 * with them; otherwise it reads and checks again in order. Never supplied by authored code.
 */
export const InvocationSelection = Context.Reference<
  | {
      readonly app: AppId;
      readonly owner: OwnerId;
      readonly profile: Profile;
    }
  | undefined
>("executor/InvocationSelection", { defaultValue: () => undefined });
/**
 * Host-only: the reads `tools.call` would make for a selection, made by the host beside its own
 * checks in one batch (see {@link PrefetchHost}). `value` is opaque to the host. `tools.call` uses
 * it only for the app, owner and a profile equal to its {@link InvocationSelection}, and only
 * once: a later call in its scope reads live, as grant rows from `GrantReadAhead` are consumed on
 * first use. Every read it holds is checked as the call's own reads are. Never supplied by
 * authored code.
 */
export const InvocationPrefetch = Context.Reference<
  | {
      readonly app: AppId;
      readonly owner: OwnerId;
      readonly profile: Profile;
      readonly value: unknown;
    }
  | undefined
>("executor/InvocationPrefetch", { defaultValue: () => undefined });
/** Host-only reads made ahead for a tool call, outside the public HTTP/Promise facade. */
export const PrefetchHost = Symbol("executor.PrefetchHost");
export interface PrefetchHost {
  /**
   * The reads `apps.get`, `apps.profiles.get` and then `tools.call` make for one selection, as
   * effects of one statement each that never fail, for the host to send in one batch beside its
   * own checks. Without `known`, only the app and the profile are read. With it, the accounts that
   * `known.profile` selects are read too, with their profile recheck and the grants of the
   * accounts `known.hint` says hold one (all of them without a hint): `known` is the profile and
   * hint the host's previous call for this selection read, and names rows to read, nothing more.
   * Once the leaves have run, `take` returns what they read.
   */
  readonly invocation: (selection: {
    readonly app: AppId;
    readonly owner: OwnerId;
    readonly profile: ProfileId;
    readonly known?: { readonly profile: Profile; readonly hint: unknown } | undefined;
  }) => {
    readonly leaves: ReadonlyArray<Effect.Effect<void>>;
    readonly take: Effect.Effect<PrefetchedInvocation>;
  };
}
/** What {@link PrefetchHost} read for one selection. */
export interface PrefetchedInvocation {
  /** What `apps.get({ app, owner })` would have returned; undefined when it was not read. */
  readonly app:
    | Result.Result<
        Effect.Success<ReturnType<Executor["apps"]["get"]>>,
        Effect.Error<ReturnType<Executor["apps"]["get"]>>
      >
    | undefined;
  /** What `apps.profiles.get({ app, owner, profile })` would have returned. */
  readonly profile: Result.Result<Profile, ProfileNotFound | StorageError> | undefined;
  /**
   * For {@link InvocationPrefetch}: the reads made with `known`, when every one answered; a read
   * that failed in storage makes the call read again on its own.
   */
  readonly invocation:
    | {
        readonly app: AppId;
        readonly owner: OwnerId;
        readonly profile: Profile;
        readonly value: unknown;
      }
    | undefined;
  /** Keep beside the live profile for the next call's `known`; opaque to the host. */
  readonly hint: unknown;
  /** Whether any read failed in storage; the host then reads nothing from this batch. */
  readonly failed: boolean;
}
/** Profiles are always resolved within the requested app and optional owner. */
export const ProfileNotFound = UserFacingError.define({
  tag: "ProfileNotFound",
  status: 404,
  fields: { app: AppId, profile: ProfileId },
  title: "Account selection unavailable",
  description: "The saved account selection for this app could not be found.",
  recovery: {
    action: "Open the app’s Accounts tab and choose an available profile.",
    instructions:
      "Read the current app’s account requirements and saved account selection. Reopen setup to establish the intended selection through the supported account flow. Do not invent missing bindings or reuse a stale profile reference.",
  },
});
/** Parsed ProfileNotFound failure. */
export type ProfileNotFound = typeof ProfileNotFound.Type;
/** A stale editor or stopped profile cannot silently select another identity. */
export const ProfileConflict = UserFacingError.define({
  tag: "ProfileConflict",
  status: 409,
  fields: {
    profile: ProfileId,
    reason: Schema.Literals(["revision", "idempotency", "inactive", "active-resources"]),
  },
  title: "Account selection needs attention",
  description: "The saved account selection changed or is not available for this action.",
  recovery: {
    action: "Reload the current account selection and review it before making changes.",
    instructions:
      "Read the latest profile state, account requirements, and active resource bindings. Resolve the conflict against the user’s intended selection. Preserve newer selections and active resource bindings; do not overwrite them with stale state.",
  },
});
/** Parsed ProfileConflict failure. */
export type ProfileConflict = typeof ProfileConflict.Type;
/** Shared errors preserve profile failures through execution transports. */
export const ProfileErrors = [ProfileNotFound, ProfileConflict] as const;
const target = { app: AppId, profile: ProfileId };
export const ProfileInputs = {
  create: Schema.Struct({
    app: AppId,
    owner: OwnerId,
    subject: Schema.NonEmptyString,
    name: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(128))),
    accounts: SelectedAccounts,
    webhookConfig: Schema.optional(ProfileWebhookConfig),
    idempotencyKey: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  }),
  get: Schema.Struct({ ...target, owner: Schema.optional(OwnerId) }),
  list: Schema.Struct({
    app: AppId,
    owner: Schema.optional(OwnerId),
    subject: Schema.optional(Schema.NonEmptyString),
    idempotencyKey: Schema.optional(Schema.NonEmptyString),
  }),
  /** List existing profiles across explicit apps; absent apps contribute no rows. */
  listMany: Schema.Struct({
    apps: Schema.Array(AppId),
    owner: OwnerId,
    subject: Schema.NonEmptyString,
  }),
  update: Schema.Struct({
    ...target,
    expectedRevision: ProfileRevision,
    accounts: SelectedAccounts,
    webhookConfig: Schema.optional(ProfileWebhookConfig),
  }),
  setEnabled: Schema.Struct({
    ...target,
    expectedRevision: ProfileRevision,
    enabled: Schema.Boolean,
  }),
  reconcile: Schema.Struct(target),
  remove: Schema.Struct(target),
};
const errors = [
  StorageError,
  AppNotFound,
  AccountNotFound,
  AccountSelectionInvalid,
  ...ProfileErrors,
] as const;
/** App setup uses the same native contract in SDK and HTTP clients. */
export const AppProfilesGroup = HttpApiGroup.make("appProfiles")
  .add(
    HttpApiEndpoint.post("create", "/v1/apps/:app/profiles", {
      params: { app: AppId },
      payload: ProfileInputs.create.mapFields(({ app: _app, ...fields }) => fields),
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/v1/apps/:app/profiles/:profile", {
      params: target,
      query: { owner: Schema.optional(OwnerId) },
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/v1/apps/:app/profiles", {
      params: { app: AppId },
      query: {
        owner: Schema.optional(OwnerId),
        subject: Schema.optional(Schema.NonEmptyString),
        idempotencyKey: Schema.optional(Schema.NonEmptyString),
      },
      success: Schema.Array(Profile),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("listMany", "/v1/profiles/list", {
      payload: ProfileInputs.listMany,
      success: Schema.Array(Profile),
      error: [StorageError],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/v1/apps/:app/profiles/:profile", {
      params: target,
      payload: Schema.Struct({
        expectedRevision: ProfileRevision,
        accounts: SelectedAccounts,
        webhookConfig: Schema.optional(ProfileWebhookConfig),
      }),
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("setEnabled", "/v1/apps/:app/profiles/:profile/enabled", {
      params: target,
      payload: Schema.Struct({ expectedRevision: ProfileRevision, enabled: Schema.Boolean }),
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("reconcile", "/v1/apps/:app/profiles/:profile/reconcile", {
      params: target,
      success: Profile,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/v1/apps/:app/profiles/:profile", {
      params: target,
      success: Profile,
      error: errors,
    }),
  );

/** Host-owned durable setup wake; never an app-authored capability. */
export const ProfileHost = Symbol.for("executor/ProfileHost");
export interface ProfileDispatcher {
  /**
   * Reconcile up to `limit` profiles: saved intent first, then due retries. Succeeds with `true`
   * when the batch was full of saved intent, so more may be waiting and the host should run
   * another pass now instead of at its next wake.
   */
  readonly tick: (limit: number) => Effect.Effect<boolean, StorageError>;
}
