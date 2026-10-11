import { ProfileHost, type ProfileDispatcher } from "./profiles.ts";
import { WorkflowHost, type WorkflowRuntime } from "./workflow-runtime.ts";
/** The shared Executor interface and remote client options; projected from ExecutorApi. */
import { type Effect, type Redacted, type Stream, Schema } from "effect";
import type { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import type { WebhookSetupApi } from "./webhook-setup.ts";
import type { ExecutorApi } from "./http.ts";
import { StorageHost, type Credentials } from "./storage.ts";
import { PrefetchHost } from "./profiles.ts";
import { SavedOAuthClientsHost } from "./oauth-clients.ts";
import type { ExecutorDatabase } from "../implementation/storage.ts";
import type { AppRuntime } from "../implementation/runtime.ts";
import type { OAuthOptions } from "./oauth.ts";
import type {
  SearchableTools,
  ToolApproval,
  ToolApprovalNotFound,
  ToolInvocationOptions,
  ToolListOptions,
  ToolSearchInput,
  ToolSearchPage,
  ToolSearchUnavailable,
} from "./tools.ts";
import type { App } from "./apps.ts";
import type { Account } from "./account.ts";
import type {
  AccountConnectionId,
  AccountId,
  ApprovalRequestId,
  OwnerId,
  StorageError,
} from "./shared.ts";
import type { BlobStorage } from "./blobs.ts";
import { RepositoryHost, type RepositoryBackend } from "./source.ts";
import type { RegistryOptions } from "./registry.ts";
import type { CatalogReadOptions } from "./declarations.ts";

/** The connection being completed, with what the product needs to recheck without reading SDK tables. */
export interface AccountConnectionCompletion {
  readonly id: AccountConnectionId;
  readonly owner: import("./shared.ts").OwnerId;
  readonly reconnectAccount: import("./shared.ts").AccountId | null;
  /** The profile the connection targets, as stored now. */
  readonly target: {
    readonly app: import("./shared.ts").AppId;
    readonly profile: import("./profiles.ts").Profile;
  };
}
/** Product metadata participates in the resource transaction; hooks must perform no external I/O. */
export interface ResourceLifecycle {
  /**
   * Recheck the saved subject before any profile-backed execution, including background work,
   * together with the selected accounts `accountsResolving` would check for that subject. Returns
   * the IDs of the accounts the product still authorizes; the SDK refuses the others. It receives
   * each account's ID and owner only: a tool call may run it beside its account read, with the
   * owner it expects, and uses the result only when the accounts it read match.
   */
  readonly profileResolving?: (
    profile: import("./profiles.ts").Profile,
    accounts: readonly Pick<Account, "id" | "owner">[],
  ) => Effect.Effect<ReadonlySet<AccountId>, StorageError>;
  /**
   * Recheck product authority before acquiring account credentials, and again after any renewal.
   * Returns the IDs of the accounts the product still authorizes; the SDK refuses the others.
   */
  readonly accountsResolving: (
    accounts: readonly [Account, ...Account[]],
  ) => Effect.Effect<ReadonlySet<AccountId>, StorageError>;
  /** Recheck a saved connection after external authentication, before committing its result. */
  readonly connectionCompleting: (
    connection: AccountConnectionCompletion,
  ) => Effect.Effect<void, StorageError>;
  /** Called once after inserting a new configured app, before its transaction commits. */
  readonly appCreated: (app: App) => Effect.Effect<void, StorageError>;
  /** Called once for a newly saved account, including secrets and OAuth completion. */
  readonly accountCreated: (account: Account) => Effect.Effect<void, StorageError>;
  /** Called after active-work checks, before deleting credentials in the same transaction. */
  readonly accountRemoving: (account: Account) => Effect.Effect<void, StorageError>;
  /**
   * Called once for a newly stored OAuth client, registered by a person or automatically, before
   * its transaction commits. A product that decides who may use clients records that here.
   */
  readonly oauthClientCreated?: (
    client: import("./oauth-clients.ts").OAuthClient,
  ) => Effect.Effect<void, StorageError>;
  /**
   * Recheck product authority before a stored client's credentials are used: whenever a sign-in
   * resolves one, whether the connection named it, a reconnect kept its account's client or the
   * automatic choice found it, and again before the sign-in's authorization code is exchanged.
   * Returns whether the product still lets the caller use it; the SDK refuses it otherwise.
   */
  readonly oauthClientResolving?: (
    client: import("./oauth-clients.ts").OAuthClient,
  ) => Effect.Effect<boolean, StorageError>;
}

/** Evaluated declarations and tool listings: where they are kept and how long they are trusted. */
export interface ExecutorCache {
  /** Per process or isolate. Defaults to a store owned by this executor. */
  readonly memory?: import("./declarations.ts").DeclarationCache;
  /** Kept beyond this process or isolate, read when `memory` misses. */
  readonly durable?: import("./declarations.ts").DurableDeclarations;
  /** Overrides of `defaultToolListingPolicy`. */
  readonly toolListings?: Partial<import("./declarations.ts").ToolListingPolicy>;
}

/** Caller-owned database, blobs, Git and execution; constructors do not migrate or close them. */
export interface ExecutorInputs {
  /** Executor tables, app data and the catalog live here. Migrated by the host before use. */
  readonly database: ExecutorDatabase;
  /** Public origin: the address of a stored catalog, and of webhook callbacks by default. */
  readonly origin?: string;
  /**
   * Origin new webhook subscriptions register their callbacks on; defaults to `origin`.
   * Existing subscriptions keep the callback URL they stored.
   */
  readonly webhookOrigin?: string;
  /** The Git backend behind app source. The executor derives revision storage from it. */
  readonly git: RepositoryBackend;
  readonly blobs: BlobStorage;
  readonly runtime: AppRuntime;
  readonly oauth?: OAuthOptions;
  /** Defaults to reading the hosted Executor registry. */
  readonly registry?: RegistryOptions;
  /** Optional product-owned metadata lifecycle. Failures roll back the resource write. */
  readonly hooks?: ResourceLifecycle;
  readonly workflows?: WorkflowRuntime;
  readonly cache?: ExecutorCache;
  /** Outbound delivery and authorization for app events. Without it, subscribing is unavailable. */
  readonly events?: import("./events.ts").EventOptions;
  /**
   * Revalidates stale declarations and revokes deleted accounts' OAuth grants after the response.
   * Without it, stale declarations revalidate first and revocation runs inline.
   */
  readonly background?: import("./declarations.ts").BackgroundWork;
}

/** A hex-encoded 256-bit key encrypts saved credentials with AES-GCM; a custom store replaces that. */
export type ExecutorOptions = ExecutorInputs &
  (
    | { readonly secret: Redacted.Redacted<string>; readonly credentials?: undefined }
    | { readonly credentials: Credentials; readonly secret?: undefined }
  );

/** No valid remote response was received; the operation may already have completed. */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  reason: Schema.String,
}) {}

/**
 * Remote door options (scaffold shape). The serving host authenticates the
 * apiKey and decides which resources the caller may access. One caller may
 * work with several owners; an owner filter is not an authorization claim.
 */
export interface RemoteExecutorOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
}

type TypeOf<S> = S extends { readonly Type: infer T } ? T : never;

type Part<T> = [T] extends [never] ? {} : T;

/** Promise inputs are ordinary values; the facade decodes/redacts them on entry. */
type PublicInput<T> =
  T extends Redacted.Redacted<infer Value>
    ? Value
    : T extends (...args: infer Args) => Effect.Effect<infer A, infer _E>
      ? (...args: Args) => Promise<A>
      : T extends string | number | boolean | null | undefined
        ? T
        : T extends ReadonlyArray<infer Item>
          ? readonly PublicInput<Item>[]
          : T extends object
            ? { readonly [Key in keyof T]: PublicInput<T[Key]> }
            : T;

type Input<E extends HttpApiEndpoint.Constraint> = Part<TypeOf<HttpApiEndpoint.Params<E>>> &
  Part<TypeOf<HttpApiEndpoint.Query<E>>> &
  Part<TypeOf<HttpApiEndpoint.Payload<E>>>;

type PublicOutput<T> = T extends Stream.Stream<infer A, infer _E, infer _R> ? AsyncIterable<A> : T;

type Method<E extends HttpApiEndpoint.Constraint> = [keyof Input<E>] extends [never]
  ? () => Effect.Effect<TypeOf<HttpApiEndpoint.Success<E>>, TypeOf<HttpApiEndpoint.Error<E>>>
  : Partial<Input<E>> extends Input<E>
    ? (
        input?: Input<E>,
      ) => Effect.Effect<TypeOf<HttpApiEndpoint.Success<E>>, TypeOf<HttpApiEndpoint.Error<E>>>
    : (
        input: Input<E>,
      ) => Effect.Effect<TypeOf<HttpApiEndpoint.Success<E>>, TypeOf<HttpApiEndpoint.Error<E>>>;

type Groups<Api> = Api extends HttpApi.HttpApi<infer _Id, infer G> ? G : never;
type WithInvocationOptions<M> = M extends (input: infer Input) => infer Output
  ? (input: Input, options?: ToolInvocationOptions) => Output
  : M;
type WithListOptions<M, Options> = M extends (input: infer Input) => infer Output
  ? (input: Input, options?: Options) => Output
  : M;

/**
 * Effect-native operations exposed by @executor-js/sdk/core, projected from
 * the HTTP contract rather than inferred from an implementation. Inputs use
 * decoded contract values, including Redacted secrets. Operations run in the
 * caller's fiber, retaining cancellation and live-query dependency tracking.
 */
type FlatExecutor = {
  readonly [G in Groups<ExecutorApi | typeof WebhookSetupApi> as HttpApiGroup.Identifier<G>]: {
    readonly [
      E in HttpApiGroup.Endpoints<G> as HttpApiEndpoint.Identifier<E>
    ]: HttpApiGroup.Identifier<G> extends "tools"
      ? HttpApiEndpoint.Identifier<E> extends "call" | "resume"
        ? WithInvocationOptions<Method<E>>
        : HttpApiEndpoint.Identifier<E> extends "list"
          ? WithListOptions<Method<E>, ToolListOptions>
          : Method<E>
      : HttpApiGroup.Identifier<G> extends "skills"
        ? HttpApiEndpoint.Identifier<E> extends "list"
          ? WithListOptions<Method<E>, CatalogReadOptions>
          : Method<E>
        : Method<E>;
  };
};

/** App-related namespaces remain beneath apps, including workflow execution management. */
export type Executor = Omit<
  FlatExecutor,
  "apps" | "appWorkflows" | "appWorkflowRuns" | "appProfiles" | "tools"
> & {
  readonly tools: FlatExecutor["tools"] & {
    /**
     * Host-only: read a pending request and its issuer, so the host that issued it can show the
     * saved call. The owner is a filter, not authorization; consumed and expired requests are not
     * found. The host authorizes the reader and refuses requests it did not issue.
     */
    readonly approval: (input: {
      readonly requestId: ApprovalRequestId;
      readonly owner?: OwnerId;
    }) => Effect.Effect<ToolApproval, StorageError | ToolApprovalNotFound>;
    /**
     * Host-only: keep the target's current listing as search rows, reading the listing as `list`
     * does only when its rows are missing or older than a kept listing may be served. It names
     * the listing only once its rows are saved, and fails with `ToolSearchUnavailable` when they
     * cannot be. Hosts authorize the target as for `list`.
     */
    readonly searchable: (
      input: Omit<Parameters<FlatExecutor["tools"]["list"]>[0], "cursor" | "limit">,
      options?: ToolListOptions,
    ) => Effect.Effect<
      SearchableTools,
      Effect.Error<ReturnType<FlatExecutor["tools"]["list"]>> | ToolSearchUnavailable
    >;
    /**
     * Host-only: rank the tools of listings `searchable` returned with BM25. Hosts narrow each
     * target's scopes to the tools the caller may discover; the SDK never widens them.
     */
    readonly search: (input: ToolSearchInput) => Effect.Effect<ToolSearchPage, StorageError>;
  };
  readonly apps: FlatExecutor["apps"] & {
    readonly profiles: FlatExecutor["appProfiles"];
    readonly workflows: FlatExecutor["appWorkflows"];
    readonly workflowRuns: FlatExecutor["appWorkflowRuns"];
  };
  readonly [ProfileHost]: ProfileDispatcher;
  readonly [WorkflowHost]: import("./workflow-runtime.ts").WorkflowHost;
  readonly [RepositoryHost]: RepositoryHost;
  readonly [StorageHost]: StorageHost;
  readonly [PrefetchHost]: import("./profiles.ts").PrefetchHost;
  readonly [SavedOAuthClientsHost]: import("./oauth-clients.ts").SavedOAuthClients;
  readonly scheduler: import("./scheduler.ts").ScheduleDispatcher;
  /** Host-only: products authorize every event operation before calling it. */
  readonly events: import("./events.ts").ExecutorEvents;
  /**
   * Host-only: credential writes for accounts the product provisions itself, such as its own API
   * access. Everyone else saves credentials through an app's connection request.
   */
  readonly managedAccounts: import("./account.ts").ManagedAccounts;
};

type Promisify<T> = T extends (...args: infer Args) => Effect.Effect<infer A, infer _E, never>
  ? (...args: { [Key in keyof Args]: PublicInput<Args[Key]> }) => Promise<PublicOutput<A>>
  : { readonly [Key in keyof T]: Promisify<T[Key]> };

/** Root SDK facade over the same operations: plain inputs, Promises, and AsyncIterable subscriptions. */
export type PromiseExecutor = Promisify<
  Omit<
    Executor,
    | typeof WorkflowHost
    | typeof ProfileHost
    | typeof RepositoryHost
    | typeof StorageHost
    | typeof PrefetchHost
    | typeof SavedOAuthClientsHost
    | "scheduler"
    | "events"
    | "managedAccounts"
    | "tools"
  > & { readonly tools: Omit<Executor["tools"], "approval" | "searchable" | "search"> }
>;
