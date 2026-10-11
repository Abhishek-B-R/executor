/** Current baseline and the additive repair required by existing version 4 databases. */
import { fumadb } from "fumadb-effect";
import { Effect, Schema } from "effect";
import { generateMigrationFromSchema } from "fumadb-effect/migration";
import { schema, type AnySchema, type CustomMigrationFn } from "fumadb-effect/schema";
import {
  boundedReadIndexes,
  eventIndexes,
  toolSearchIndexes,
  version408Schema,
  version409Schema,
  version4010Schema,
  version402Tables,
  version403Tables,
  version404Tables,
  version405Tables,
  version406Tables,
  version407Tables,
  version4Tables,
  storedOAuthClientIndexes,
  storedOAuthClientIssuerIndexes,
  storageSchema,
} from "./storage-schema.ts";

/** Indexes the 4.0.1 step added. Released steps never change; later indexes join their own step. */
export const storageIndexes = [
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_workflow_runs_context_key ON executor_workflow_runs (app, COALESCE(installation, ''), start_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_webhooks_context_key ON executor_webhooks (app, COALESCE(installation, ''), subscription_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS executor_schedules_context_name ON executor_schedules (app, COALESCE(installation, ''), name)",
  "CREATE INDEX IF NOT EXISTS executor_schedules_due ON executor_schedules (enabled, active_run, next_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_pending ON executor_scheduled_runs (status, expires_at)",
  "CREATE INDEX IF NOT EXISTS executor_scheduled_runs_owner ON executor_scheduled_runs (owner, started_at)",
] as const;

/** Every index of the current layout, for a new database. Upgrades add each in its own step. */
export const currentIndexes = [
  ...storageIndexes,
  ...eventIndexes,
  ...toolSearchIndexes,
  ...storedOAuthClientIndexes,
  ...boundedReadIndexes,
  ...storedOAuthClientIssuerIndexes,
] as const;

/** Versions built by {@link indexOnlyVersion}. */
const indexOnlyVersions = new WeakSet<AnySchema>();

/**
 * A version that only builds indexes: it reuses `previous`'s tables and relations and runs
 * `indexes`, so it cannot express a table change. `trailingIndexVersions` checks that `previous`
 * is the version before it.
 */
export const indexOnlyVersion = <Version extends string, Previous extends AnySchema>(
  previous: Previous,
  version: Version,
  indexes: ReadonlyArray<string>,
) => {
  const entry = schema({
    version,
    tables: previous.tables as Previous["tables"],
    up: () => Effect.succeed(indexes.map((sql) => ({ type: "custom" as const, sql }))),
  });
  indexOnlyVersions.add(entry);
  return entry;
};

/** An index-only version whose tables differ from the version before it, or that has none. */
export class IndexOnlyVersionChangesTables extends Schema.TaggedError<IndexOnlyVersionChangesTables>()(
  "IndexOnlyVersionChangesTables",
  { version: Schema.String },
) {
  override get message() {
    return `Storage version ${this.version} is index-only, but its tables differ from the version before it. Build it with indexOnlyVersion from that version.`;
  }
}

/**
 * The index-only versions after the last version that changes tables. `CREATE INDEX` blocks writes
 * to its table until the enclosing transaction commits, so a host that does more work in that
 * transaction runs these at its end (`migrateTables`, then `migrate`). Every table exists before
 * them, so that work sees the current layout. Throws `IndexOnlyVersionChangesTables` when an
 * index-only version's tables are not exactly its predecessor's: deferring it would run that work
 * before its tables exist.
 */
export const trailingIndexVersions = (schemas: ReadonlyArray<AnySchema>): ReadonlySet<string> => {
  schemas.forEach((entry, index) => {
    if (!indexOnlyVersions.has(entry)) return;
    const previous = schemas[index - 1];
    const changes =
      previous === undefined
        ? undefined
        : generateMigrationFromSchema(previous, entry, {
            provider: "postgresql",
            dropUnusedTables: true,
            dropUnusedColumns: true,
          });
    if (changes === undefined || changes.length > 0)
      throw new IndexOnlyVersionChangesTables({ version: entry.version });
  });
  return new Set(
    schemas
      .slice(schemas.findLastIndex((entry) => !indexOnlyVersions.has(entry)) + 1)
      .map((entry) => entry.version),
  );
};

/** A shipped version 4 layout, with the same foreign keys as the current schema. */
const version4 = <Version extends string>(version: Version, up?: CustomMigrationFn) =>
  schema({
    version,
    tables: version4Tables,
    ...(up === undefined ? {} : { up }),
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  });

/** Version 4 is the oldest supported layout. Append future compatible upgrades here. */
export const storageSchemas = [
  version4("4.0.0"),
  version4("4.0.1", () =>
    Effect.succeed(storageIndexes.map((sql) => ({ type: "custom" as const, sql }))),
  ),
  // Additive: existing accounts start at generation 0 and the running server ignores the column.
  schema({
    version: "4.0.2",
    tables: version402Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a new account checks table that the running server never reads.
  schema({
    version: "4.0.3",
    tables: version403Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a nullable account description; the running server neither reads nor writes it.
  schema({
    version: "4.0.4",
    tables: version404Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a nullable column the running server never names. Existing accounts read as
  // connected without hosts, which is how they behave before this version.
  schema({
    version: "4.0.5",
    tables: version405Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: a nullable check message the running server never names. Existing checks have none.
  schema({
    version: "4.0.6",
    tables: version406Tables,
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Additive: three event tables and their indexes, which the running server never names.
  schema({
    version: "4.0.7",
    tables: version407Tables,
    up: ({ auto }) =>
      auto.pipe(
        Effect.map((operations) => [
          ...operations,
          ...eventIndexes.map((sql) => ({ type: "custom" as const, sql })),
        ]),
      ),
    relations: {
      accounts: ({ one }) => ({
        providerDefinition: one("providers", ["provider", "id"]).foreignKey(),
      }),
      apps: ({ one }) => ({
        deployment: one("deployments", ["activeDeployment", "id"], ["code", "code"]).foreignKey(),
      }),
    },
  }),
  // Deletes connections without a target, then requires one. The running server has written a
  // target on every connection since #2135 and reads the column as nullable, so it is unaffected.
  version408Schema,
  // Additive: three tool search tables and their indexes, which the running server never names.
  version409Schema,
  // Additive: a stored OAuth clients table and its indexes, which the running server never names.
  // The old saved-client table stays, so the running server keeps using it; a data step moves its
  // clients (see `6_stored_oauth_clients`).
  version4010Schema,
  // Additive: three indexes; the running server's queries are unchanged.
  indexOnlyVersion(version4010Schema, "4.0.11", boundedReadIndexes),
  // Additive for the running server: a nullable `issuer` on stored clients and its index, and
  // `provider` made nullable on stored clients and their credentials. The running server writes a
  // provider on every row and never names `issuer`. The new server's data step
  // `8_oauth_clients_by_issuer` records each existing client's issuer; until then those clients
  // keep working through their pre-4.0.12 credentials identity, and are offered to no sign-in.
  storageSchema,
] as const;

/** Checked when this module loads, so a misbuilt index-only version fails every host's start. */
export const trailingStorageIndexVersions = trailingIndexVersions(storageSchemas);

/** Versioned persistence factory; constructing it does not touch a database. */
export const executorDatabase = fumadb({
  namespace: "executor",
  schemas: storageSchemas,
});
