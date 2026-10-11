/**
 * Moves the saved clients of versions before 4.0.10 into stored OAuth clients, once, through a data
 * step. A saved client was keyed by a digest of its owner, provider, method, callback, issuer and
 * scopes, and its record held only the registration, so neither its owner nor its provider can be
 * read from it. Both come from the accounts whose grants hold the same client: a saved client no
 * account signed in with is not moved, and one that accounts of several owners hold is reported
 * rather than guessed. Saved records and grants are never changed: a grant keeps its own copy of
 * the client, and a sign-in using credentials a stored client holds uses that client, so a
 * reconnect keeps the client and the callback it was registered at, under the host's policy for
 * it, without the grant naming it.
 */
import { Clock, Effect, Option, Redacted, Schema } from "effect";
import {
  OAuthClientId,
  OAuthClientSource,
  OAuthGrant,
  OAuthRegistration,
  isFirstPartyGrant,
} from "../contracts/oauth.ts";
import {
  OAuthClient,
  type SavedClientOutcome,
  type SavedOAuthClients,
} from "../contracts/oauth-clients.ts";
import type { ResourceLifecycle } from "../contracts/executor.ts";
import {
  AccountId,
  CredentialsError,
  JsonObject,
  OwnerId,
  ProviderId,
  StorageError,
} from "../contracts/shared.ts";
import type { Credentials } from "../contracts/storage.ts";
import { query, transaction, type Query } from "./database.ts";
import {
  claimCredentials,
  credentialsDigest,
  credentialsOwner,
} from "./stored-oauth-client-credentials.ts";

/** Read beside the registration from a saved record, once sources were recorded. */
const SavedClientSource = Schema.Struct({ executor_source: Schema.optionalKey(OAuthClientSource) });

interface Holder {
  readonly account: AccountId;
  readonly owner: OwnerId;
  readonly provider: ProviderId;
  readonly secret: string | undefined;
  readonly machine: boolean;
}

const decodeStored = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new StorageError()));

export const makeSavedOAuthClients = (
  db: Query,
  credentials: Credentials,
  lifecycle: ResourceLifecycle | undefined,
): SavedOAuthClients => {
  const decrypt = <A>(
    identity: AccountId | OAuthClientId,
    bytes: Uint8Array,
    schema: Schema.Decoder<A>,
  ) =>
    credentials
      .decrypt(identity, Redacted.make(bytes))
      .pipe(Effect.flatMap((value) => decodeStored(schema, Redacted.value(value))));
  const encrypt = (identity: AccountId | OAuthClientId, value: unknown) =>
    decodeStored(JsonObject, value).pipe(
      Effect.flatMap((json) => credentials.encrypt(identity, Redacted.make(json))),
    );

  /** Who holds each client ID: every account whose grant signed in with it. */
  const holders = Effect.gen(function* () {
    const accounts = new Map(
      (yield* query(() => db.findMany("accounts", { select: ["id", "owner", "provider"] }))).map(
        (account) => [account.id, account] as const,
      ),
    );
    const byClient = new Map<string, Holder[]>();
    for (const row of yield* query(() => db.findMany("oauthGrants", {}))) {
      const account = accounts.get(AccountId.make(row.id));
      if (account === undefined) continue;
      const grant = yield* decrypt(account.id, row.encrypted, OAuthGrant).pipe(Effect.option);
      if (Option.isNone(grant) || isFirstPartyGrant(grant.value)) continue;
      const { client } = grant.value;
      const list = byClient.get(client.client_id) ?? [];
      list.push({
        account: account.id,
        owner: account.owner,
        provider: account.provider,
        secret: client.token_endpoint_auth_method === "none" ? undefined : client.client_secret,
        machine: grant.value.grant === "client_credentials",
      });
      byClient.set(client.client_id, list);
    }
    return byClient;
  });

  /** Where a saved client moves, read again for every report and move. */
  const analyse = (id: string, byClient: ReadonlyMap<string, ReadonlyArray<Holder>>) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        db.findFirst("oauthClients", { where: (b) => b("id", "=", id) }),
      );
      if (row === null) return "absent" as const;
      if (!id.startsWith("client_")) return "unreadable" as const;
      const identity = OAuthClientId.make(id);
      const read = yield* Effect.all([
        decrypt(identity, row.encrypted, OAuthRegistration),
        decrypt(identity, row.encrypted, SavedClientSource),
      ]).pipe(Effect.option);
      if (Option.isNone(read)) return "unreadable" as const;
      const [client, { executor_source }] = read.value;
      const secret =
        client.token_endpoint_auth_method === "none" ? undefined : client.client_secret;
      const held = (byClient.get(client.client_id) ?? []).filter(
        (holder) => holder.secret === secret,
      );
      if (held.length === 0) return "no_account" as const;
      // A machine client is the account itself; its grant keeps it.
      const browser = held.filter((holder) => !holder.machine);
      const holder = browser[0];
      if (holder === undefined) return "machine_client" as const;
      if (new Set(browser.map((found) => `${found.owner}\n${found.provider}`)).size !== 1)
        return "ambiguous_owner" as const;
      const key = id.slice("client_".length);
      // Before sources were recorded a record has none; it is kept as entered, never discarded.
      const source = executor_source === "registered" ? "registered" : "manual";
      // Every record moves to a client of its own key. Records saved under several settings with
      // the same credentials are one client: the first moved holds them and the rest are
      // duplicates. Records with different secrets for one client ID are different credentials,
      // so each is its own client, and a grant holding either resolves to the client holding it.
      const target = OAuthClientId.make(`oac_${key}`);
      const digest = yield* credentialsDigest(credentials, {
        owner: holder.owner,
        provider: holder.provider,
        clientId: client.client_id,
        secret,
      });
      return { key, client, secret, source, holder, target, digest } as const;
    });

  /** The order a data step walks records in, which decides which of a duplicate set moves. */
  const byId = (left: { readonly id: string }, right: { readonly id: string }) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

  const move = (
    id: string,
    byClient: ReadonlyMap<string, ReadonlyArray<Holder>>,
    firstWith: ReadonlyMap<string, string>,
    apply: boolean,
  ): Effect.Effect<SavedClientOutcome, StorageError | CredentialsError> =>
    Effect.gen(function* () {
      const found = yield* analyse(id, byClient);
      if (typeof found === "string") return found;
      const { key, client, secret, source, holder, target, digest } = found;
      const existing = yield* query(() =>
        db.findFirst("storedOAuthClients", { where: (b) => b("id", "=", target) }),
      );
      // A pass that moved it may have been interrupted before its outcome was recorded.
      if (existing !== null) return "already_moved";
      // Credentials are one client per owner and provider: a client holding these, such as one
      // registered since or another record's, keeps them, and this record is not moved. A
      // removed client's stay withdrawn. A report reads the same answer an apply would.
      if ((yield* credentialsOwner(db, digest)) !== undefined) return "duplicate";
      // A pass walks records in ID order, so of records with the same unheld credentials the
      // first moves and the rest are duplicates. The report decides that from every record, not
      // from the ones this process walked, so a report resumed after its cursor agrees too.
      if (!apply) return (firstWith.get(digest) ?? id) === id ? "would_move" : "duplicate";
      const stored = {
        id: target,
        owner: holder.owner,
        provider: holder.provider,
        clientId: client.client_id,
        source,
        hasSecret: secret !== undefined,
        // The saved key, so a sign-in finds the callback the client was registered at.
        automaticKey: key,
        // An account signed in with it.
        confirmed: true,
        encrypted: yield* encrypt(
          target,
          source === "registered"
            ? client
            : {
                client_id: client.client_id,
                ...(secret === undefined ? {} : { client_secret: secret }),
              },
        ),
        createdAt: new Date(yield* Clock.currentTimeMillis),
      };
      return yield* transaction(db, (tx) =>
        Effect.gen(function* () {
          const holding = yield* claimCredentials(tx, {
            digest,
            owner: holder.owner,
            provider: holder.provider,
            client: target,
            createdAt: stored.createdAt,
            reclaim: false,
          });
          if (holding !== undefined) return "duplicate" as const;
          yield* query(() => tx.create("storedOAuthClients", stored));
          if (lifecycle?.oauthClientCreated)
            yield* lifecycle.oauthClientCreated(yield* decodeStored(OAuthClient, stored));
          return "moved" as const;
        }),
      );
    });

  return {
    items: Effect.gen(function* () {
      const byClient = yield* holders;
      const rows = (yield* query(() => db.findMany("oauthClients", { select: ["id"] }))).toSorted(
        byId,
      );
      const analysed = yield* Effect.forEach(rows, (row) =>
        analyse(row.id, byClient).pipe(
          Effect.option,
          Effect.map((found) => ({
            id: row.id,
            found:
              Option.isSome(found) && typeof found.value !== "string" ? found.value : undefined,
          })),
        ),
      );
      // The first record, in walking order, of each set of credentials.
      const firstWith = new Map<string, string>();
      for (const { id, found } of analysed)
        if (found !== undefined && !firstWith.has(found.digest)) firstWith.set(found.digest, id);
      return analysed.map(({ id, found }) => ({
        id,
        owner: found?.holder.owner,
        move: (apply: boolean) =>
          move(id, byClient, firstWith, apply).pipe(
            Effect.catch(() => Effect.succeed("unavailable" as const)),
            Effect.withSpan("oauth.clients.moveSaved", { attributes: { apply } }),
          ),
      }));
    }).pipe(Effect.withSpan("oauth.clients.savedItems")),
  };
};
