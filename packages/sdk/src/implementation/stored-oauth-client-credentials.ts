/**
 * A stored client's credentials are its owner, provider, client ID and secret (none for a public
 * client). They have one identity per owner and provider, a keyed digest, recorded in
 * `executor_stored_oauth_client_credentials` for every set of credentials a client holds or
 * held. So credentials read from anywhere, a grant's copy, a connect form or an attempt, resolve
 * to exactly one stored client, or to none, by an indexed lookup that compares no secret.
 */
import { Effect, Redacted, Result, Schema } from "effect";
import { SqlError } from "effect/sql";
import type { OAuthClientId } from "../contracts/oauth.ts";
import { type OwnerId, type ProviderId, StorageError } from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import { query, type Query } from "./database.ts";
import type { CredentialsWithdrawal } from "./storage-schema.ts";

export interface ClientCredentials {
  readonly owner: OwnerId;
  readonly provider: ProviderId;
  readonly clientId: string;
  readonly secret: string | undefined;
}

/** The credentials' identity under this host's key. */
export const credentialsDigest = (credentials: Credentials, input: ClientCredentials) =>
  credentials.fingerprint(
    "oauth client credentials",
    Redacted.make(
      JSON.stringify([input.owner, input.provider, input.clientId, input.secret ?? null]),
    ),
  );

/**
 * Who the credentials belong to: the stored client holding them now or before an edit, a client
 * since gone (`withdrawn`, with why), or nobody.
 */
export const credentialsOwner = (store: Query, digest: string) =>
  Effect.gen(function* () {
    const entry = yield* query(() =>
      store.findFirst("storedOAuthClientCredentials", { where: (b) => b("id", "=", digest) }),
    );
    if (entry === null) return undefined;
    const row = yield* query(() =>
      store.findFirst("storedOAuthClients", { where: (b) => b("id", "=", entry.client) }),
    );
    return row === null
      ? ({ kind: "withdrawn", client: entry.client, withdrawal: entry.withdrawal } as const)
      : ({ kind: "held", row } as const);
  });

/**
 * Record that a client holds the credentials, in the caller's transaction. Credentials another
 * existing client holds, now or before an edit, are refused with that client's ID. Those of a
 * removed client pass to this one when `reclaim` allows it, since it is registered with them
 * again; otherwise they are refused with the removed client's ID.
 *
 * Concurrent claims of the same credentials have one winner. A first claim inserts the row in a
 * savepoint, so a racing insert's primary-key conflict leaves the caller's transaction usable,
 * and a reclaim moves the row only from the removed client it read. Either way the loser reads
 * the row again once the winner has committed, and is refused with the winner's ID.
 */
export const claimCredentials = (
  store: Query,
  input: {
    readonly digest: string;
    readonly owner: OwnerId;
    readonly provider: ProviderId;
    readonly client: OAuthClientId;
    readonly createdAt: Date;
    readonly reclaim: boolean;
  },
): Effect.Effect<OAuthClientId | undefined, StorageError> =>
  Effect.gen(function* () {
    const found = yield* credentialsOwner(store, input.digest);
    if (found === undefined) {
      const inserted = yield* store
        .transaction(
          store.create("storedOAuthClientCredentials", {
            id: input.digest,
            owner: input.owner,
            provider: input.provider,
            client: input.client,
            createdAt: input.createdAt,
          }),
        )
        .pipe(Effect.result);
      if (Result.isSuccess(inserted)) return undefined;
      if (!isUniqueViolation(inserted.failure)) return yield* new StorageError();
      return yield* claimCredentials(store, input);
    }
    if (found.kind === "held") return found.row.id === input.client ? undefined : found.row.id;
    if (!input.reclaim) return found.client;
    yield* query(() =>
      store.updateMany("storedOAuthClientCredentials", {
        where: (b) => b.and(b("id", "=", input.digest), b("client", "=", found.client)),
        set: { client: input.client, withdrawal: null, createdAt: input.createdAt },
      }),
    );
    const claimed = yield* query(() =>
      store.findFirst("storedOAuthClientCredentials", { where: (b) => b("id", "=", input.digest) }),
    );
    if (claimed?.client === input.client) return undefined;
    return yield* claimCredentials(store, input);
  });

/**
 * Record why a client no longer holds its credentials, after its row was deleted in the caller's
 * transaction. A removal by a person always wins: it is recorded over any earlier reason, so a
 * pending sign-in with the client fails closed. Executor's own discards record theirs only when
 * no reason is recorded yet, so a discard racing a removal never records over it.
 */
export const withdrawCredentials = (
  store: Query,
  client: OAuthClientId,
  withdrawal: typeof CredentialsWithdrawal.Type,
) =>
  query(() =>
    store.updateMany("storedOAuthClientCredentials", {
      where: (b) =>
        withdrawal === "removed"
          ? b("client", "=", client)
          : b.and(b("client", "=", client), b("withdrawal", "is", null)),
      set: { withdrawal },
    }),
  );

const isUniqueViolation = (error: unknown) =>
  SqlError.isSqlError(error) && Schema.is(SqlError.UniqueViolation)(error.reason);
