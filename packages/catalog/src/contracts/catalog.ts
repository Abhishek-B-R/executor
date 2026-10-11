/** Catalog and onboarding projections, independent of any integration runtime. */
import { Schema, SchemaGetter, type Effect } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { TemplateErrorCode } from "@executor-js/app-templates/contracts";
import { SourceFiles } from "@executor-js/sdk";
import type { HostEgress } from "@executor-js/utils/url-policy";
import type { CustomAppInput } from "./imports.ts";
import { McpDetection } from "./detection.ts";

/**
 * Public integrations.sh v1 entries, plus a host's own built-in apps. Only MCP servers and
 * built-in apps are added directly; every other kind is set up with the user's agent.
 */
export const CatalogEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["app", "openapi", "mcp", "graphql", "cli"]),
  name: Schema.NonEmptyString,
  description: Schema.String,
  domain: Schema.String,
  connectUrl: Schema.optional(Schema.String),
  /** Protected-resource discovery target, independent of transport options. */
  oauthDiscoveryUrl: Schema.optional(Schema.String),
  feeds: Schema.optional(Schema.Array(Schema.String)),
  popularity: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type CatalogEntry = typeof CatalogEntry.Type;
/** Entries a host can add without the user's agent; others copy a setup prompt instead. */
export const quickAdd = (entry: CatalogEntry) =>
  entry.kind === "app" || (entry.kind === "mcp" && entry.connectUrl !== undefined);
/** A catalog choice contains no owner, workspace, account selection or credential. */
export const CatalogImport = Schema.Struct({ entry: Schema.NonEmptyString });
export type CatalogImport = typeof CatalogImport.Type;
/** Ordinary source files ready for a product to save or deploy using its own rules. */
export const PreparedApp = Schema.Struct({ files: SourceFiles });
export type PreparedApp = typeof PreparedApp.Type;
/** The registry envelope is versioned, rather than guessed from an arbitrary array. */
export const CatalogFeed = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Array(CatalogEntry),
});
/** What to do next: a short step, and instructions for the agent that sets the service up. */
export const CatalogRecovery = Schema.Struct({
  action: Schema.NonEmptyString,
  instructions: Schema.NonEmptyString,
});
export type CatalogRecovery = typeof CatalogRecovery.Type;
/**
 * Import failures expose a safe, actionable reason, never a fetched document or credential. A
 * failed MCP server check also carries its typed detection and the signals that decided it. A
 * catalog entry its caller's agent must set up carries the setup prompt as `recovery`.
 */
export class CatalogImportFailed extends Schema.TaggedError<CatalogImportFailed>()(
  "CatalogImportFailed",
  {
    code: Schema.Union([
      TemplateErrorCode,
      Schema.Literals([
        "entry_missing",
        "agent_setup_required",
        "destination_blocked",
        "package_name",
        "mcp_url",
        "mcp_probe",
        "mcp_timeout",
      ]),
    ]),
    reason: Schema.String,
    detection: Schema.optionalKey(McpDetection),
    recovery: Schema.optionalKey(CatalogRecovery),
    // Optional on the wire for older clients; restored from safe fields on decode.
    message: Schema.optionalKey(Schema.String).pipe(
      Schema.decodeTo(Schema.optionalKey(Schema.String), {
        decode: SchemaGetter.omit(),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  },
  { httpApiStatus: 422 },
) {}
// Imported OpenAPI tools only forward a declared message, not arbitrary body fields.
Object.defineProperty(CatalogImportFailed.prototype, "message", {
  get(this: CatalogImportFailed) {
    return `${this.reason} [${this.code}]`;
  },
});
/** Remote catalog availability is separate from the local app inventory. */
export const CatalogUnavailable = ApiError.define({
  tag: "CatalogUnavailable",
  status: 502,
  message: "Executor could not read the app catalog. Try again.",
});
export type CatalogUnavailable = typeof CatalogUnavailable.Type;

/**
 * What the importing host supplies. An import reads URLs a user chose, so it fetches with the
 * host's egress. `clientMetadataUrl` is the Client ID Metadata Document the host's account setup
 * uses, so an import reports the client setup that host will use.
 */
export interface CatalogHost {
  readonly egress: HostEgress;
  readonly clientMetadataUrl?: string | undefined;
  /** Where the integrations.sh feed is read; a mirror or a test fixture may serve it instead. */
  readonly feedUrl?: string | undefined;
}

/**
 * The registrable domain for each lower-cased catalog name that names exactly one domain, as
 * `[name, domain]` pairs. Dashboards read this to decorate apps and accounts with logos, instead
 * of downloading the whole catalog; ambiguous names are left out rather than guessed.
 */
export const CatalogIcons = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
export type CatalogIcons = typeof CatalogIcons.Type;

/**
 * How long a process keeps the published catalog. A read within `freshMillis` of the last fetch
 * uses the kept copy. A later read still answers from it, until `maxStaleMillis`, while one refresh
 * runs beside it; a failed refresh is retried after `retryMillis`. Past `maxStaleMillis` a read
 * waits for the feed. A fetch that has not settled after `loadMillis` no longer holds back others.
 */
export const catalogFreshness = {
  freshMillis: 10 * 60 * 1000,
  maxStaleMillis: 24 * 60 * 60 * 1000,
  retryMillis: 60 * 1000,
  loadMillis: 45 * 1000,
} as const;

/** Published metadata, replaceable without changing the import workflow. */
export interface CatalogSource {
  readonly list: Effect.Effect<readonly CatalogEntry[], CatalogUnavailable>;
}

/**
 * Runs a catalog refresh beside the request that noticed the kept copy was stale, within the
 * host's lifetime for background work. Returns false when the host refuses the work.
 */
export type CatalogBackground = (work: Effect.Effect<void>) => Effect.Effect<boolean>;

/** One process's copy of a catalog source, shared by every request the process serves. */
export interface KeptCatalog {
  readonly read: (
    background: CatalogBackground | undefined,
  ) => Effect.Effect<KeptCatalogSnapshot, CatalogUnavailable>;
}
export interface KeptCatalogSnapshot {
  readonly entries: readonly CatalogEntry[];
  readonly icons: CatalogIcons;
}

/** Read a catalog and prepare source. The caller owns access checks and installation. */
export interface Catalog {
  readonly list: Effect.Effect<readonly CatalogEntry[], CatalogUnavailable>;
  /** Logo domains by catalog name; a small projection of `list`. */
  readonly icons: Effect.Effect<CatalogIcons, CatalogUnavailable>;
  readonly prepare: (
    input: CatalogImport,
  ) => Effect.Effect<PreparedApp, CatalogImportFailed | CatalogUnavailable>;
  /** Prepare source for an MCP URL a user supplied, using the same host egress as an install. */
  readonly custom: (input: CustomAppInput) => Effect.Effect<PreparedApp, CatalogImportFailed>;
}
