/**
 * The one-off repair of organizations moved before the importer took v1's approval stamps
 * (`notes/v1-import.md`, "Repair of moved organizations"). It changes what that fix changes and
 * nothing else, with the importer's own code, so a repaired app holds what an import makes now:
 * an MCP tool whose row v1 stamped as needing approval, and that no policy decided, gets the app's
 * own `always` rule (`toolActions`). The app's source is generated again, as the importer generates
 * it, and a new version is deployed through the importer's own deploy call. A file the fix changes
 * is replaced only when the deployed one is still the earlier importer's output.
 *
 * Without `apply` it reports what it would change and writes nothing.
 */
import { CurrentUserId, HostedExecutor, organizationOwner } from "@executor-js/hosted-server";
import { sharedAppCreation } from "@executor-js/hosted-server/resource-lifecycle";
import { AppId, scopeGeneratedPackage, type SourceFile } from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { V1ImportDatabase, V1ImportUnavailable } from "../../contracts/v1-import.ts";
import type { IntegrationRow, ToolRow } from "./formats.ts";
import {
  appMethods,
  approvalRules,
  generate,
  mcpNaming,
  redundantFixed,
  toolActions,
  type ItemContext,
} from "./items.ts";
import { integrationLabel, integrationPlan } from "./plan.ts";
import { V1ImportEnvironment, firstPartyClients } from "./run.ts";
import { allSnapshotTables, type V1Snapshot, type V1Source } from "./source.ts";
import { makeImportStore, type ImportStore } from "./store.ts";

/** An imported member: their WorkOS user, v2 user and role in the v2 organization. */
const Member = Schema.Struct({ v1: Schema.String, v2: Schema.String, role: Schema.String });

/** Tool rows as the earlier importer read them: without v1's approval stamp. */
export const unstamped = (tools: readonly ToolRow[]): readonly ToolRow[] =>
  tools.map((tool) => ({ ...tool, requires_approval: false }));

/**
 * The tools of an integration's app that the stamp fix makes ask always: the app's `always`
 * rules with v1's stamps, less those it had without them. Only MCP tools change.
 */
export const stampedAlways = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
) => {
  const aliases = integration.plugin_id === "mcp" ? mcpNaming(tools).aliases : {};
  const now = approvalRules(toolActions(snapshot, integration, tools, aliases)).approvals;
  const before = approvalRules(
    toolActions(snapshot, integration, unstamped(tools), aliases),
  ).approvals;
  return Object.keys(now)
    .filter((name) => now[name] === "always" && before[name] !== "always")
    .sort();
};

export interface AppRepair {
  readonly integration: string;
  readonly app: string;
  readonly always: readonly string[];
  readonly decision: "deploy" | "unchanged" | "edited" | "removed" | "failed";
  /** The files the new version changes, or the ones that block it. */
  readonly files: readonly string[];
  readonly reason?: string;
}

export interface OrganizationRepair {
  readonly organization: string;
  readonly v2Organization: string | null;
  readonly applied: boolean;
  readonly status: "repaired" | "planned" | "not_imported";
  readonly apps: readonly AppRepair[];
}

const fileKey = (file: SourceFile | undefined) =>
  file === undefined ? null : JSON.stringify(file);

/**
 * The files of a new version: the deployed ones, with each file the fix changes taken from the
 * importer's output now. Undefined, with the paths that block it, when a file the fix changes is
 * not the earlier importer's output (`before`). `done` when every such file is already the
 * importer's output now, as after an earlier repair.
 */
export const mergedFiles = (
  deployed: readonly SourceFile[],
  before: readonly SourceFile[],
  after: readonly SourceFile[],
) => {
  const at = (files: readonly SourceFile[], path: string) =>
    files.find((file) => file.path === path);
  const paths = [...new Set([...before, ...after].map((file) => file.path))].filter(
    (path) => fileKey(at(before, path)) !== fileKey(at(after, path)),
  );
  const done = paths.every((path) => fileKey(at(deployed, path)) === fileKey(at(after, path)));
  const blocked = paths.filter((path) => fileKey(at(deployed, path)) !== fileKey(at(before, path)));
  if (done || blocked.length > 0) return { changed: paths, blocked, files: undefined, done };
  const files = [
    ...deployed.filter((file) => !paths.includes(file.path)),
    ...paths.flatMap((path) => {
      const file = at(after, path);
      return file === undefined ? [] : [file];
    }),
  ];
  return { changed: paths, blocked, files, done };
};

/** A source whose tool rows read as the earlier importer read them. */
const withoutStamps = (source: V1Source): V1Source => ({
  ...source,
  tools: (tenant, subjects, integration) =>
    source.tools(tenant, subjects, integration).pipe(Effect.map(unstamped)),
});

/** The members an import moved: their WorkOS user, v2 user and role in the v2 organization. */
export const importedMembers = (sql: SqlClient.SqlClient, organization: string) =>
  sql`
    select u.v1_id as v1, m."userId" as v2, m.role from member m
    join private_v1_import_map u on u.v1_kind = 'user' and u.v2_id = m."userId"
    where m."organizationId" = ${organization} order by m."createdAt", u.v1_id
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Member))),
    Effect.mapError(() => new V1ImportUnavailable()),
  );

/** Each imported MCP app of the organization whose tools the stamp fix makes ask always. */
export const planStampedApps = (
  snapshot: V1Snapshot,
  source: Pick<V1Source, "tools">,
  store: Pick<ImportStore, "find">,
) =>
  Effect.gen(function* () {
    const planned: { integration: IntegrationRow; app: AppId; always: readonly string[] }[] = [];
    for (const integration of snapshot.integrations) {
      if (integration.plugin_id !== "mcp") continue;
      const imported = yield* store.find("integration", integration.row_id);
      if (imported?.status !== "imported" || imported.v2_id === null) continue;
      const tools = yield* source.tools(snapshot.tenant, snapshot.subjects, integration.slug);
      const always = stampedAlways(snapshot, integration, tools);
      if (always.length > 0) planned.push({ integration, app: AppId.make(imported.v2_id), always });
    }
    return planned;
  });

/**
 * Repair one moved organization, or plan its repair without writing (`apply` false). The members
 * are the imported v2 members whose user the import mapped, as the import read them.
 */
export const repairOrganization = (organization: string, apply: boolean) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    const sql = yield* Effect.flatten(V1ImportDatabase);
    const store = makeImportStore(sql);
    const recorded = yield* store.find("organization", organization);
    const empty = { organization, applied: false, apps: [] };
    if (recorded?.status !== "imported" || recorded.v2_id === null)
      return {
        ...empty,
        v2Organization: null,
        status: "not_imported",
      } satisfies OrganizationRepair;
    const target = yield* store.target(recorded.v2_id);
    const members = target === undefined ? [] : yield* importedMembers(sql, target.id);
    const owner = members.find((member) => member.role === "owner")?.v2;
    const [first, ...rest] = members.map((member) => member.v1);
    if (target === undefined || owner === undefined || first === undefined)
      return {
        ...empty,
        v2Organization: recorded.v2_id,
        status: "not_imported",
      } satisfies OrganizationRepair;
    const subjects = [first, ...rest] as const;
    const source = yield* environment.source;
    const snapshot = yield* source.snapshot(
      organization,
      subjects,
      subjects.length > 1,
      allSnapshotTables,
    );
    const executor = yield* Effect.flatten(HostedExecutor);
    const context: ItemContext = {
      executor,
      connections: environment.connections,
      store,
      sql,
      source,
      snapshot,
      target: { id: target.id as ItemContext["target"]["id"], slug: target.slug },
      owner,
      users: new Map(members.map((member) => [member.v1, member.v2])),
      firstParty: firstPartyClients(executor, environment.v1FirstPartyClients).lookup,
    };

    // MCP apps: v1's stamps become the app's own `always` rules.
    const apps: AppRepair[] = [];
    const appOwner = organizationOwner(target.id);
    for (const { integration, app, always } of yield* planStampedApps(snapshot, source, store)) {
      const base = { integration: integrationLabel(integration), app, always };
      const plan = integrationPlan(integration);
      if (!plan.ok) {
        apps.push({ ...base, decision: "failed", files: [], reason: plan.reason });
        continue;
      }
      const planned = appMethods(
        snapshot,
        context.firstParty,
        integration,
        yield* redundantFixed(context, integration),
      );
      const scoped = (files: Parameters<typeof scopeGeneratedPackage>[0]) =>
        scopeGeneratedPackage(files, target.slug, integrationLabel(integration));
      const generated = yield* Effect.all({
        after: generate(context, integration, plan.value, planned).pipe(
          Effect.flatMap((out) => scoped(out.files)),
        ),
        before: generate(
          { ...context, source: withoutStamps(source) },
          integration,
          plan.value,
          planned,
        ).pipe(Effect.flatMap((out) => scoped(out.files))),
      }).pipe(Effect.option);
      if (Option.isNone(generated)) {
        apps.push({
          ...base,
          decision: "failed",
          files: [],
          reason: "The importer no longer generates this app.",
        });
        continue;
      }
      const deployed = yield* executor.apps
        .source({ owner: appOwner, versionOwner: appOwner, app })
        .pipe(Effect.option);
      if (Option.isNone(deployed)) {
        apps.push({ ...base, decision: "removed", files: [] });
        continue;
      }
      const merged = mergedFiles(
        deployed.value.files,
        generated.value.before,
        generated.value.after,
      );
      if (merged.done) {
        apps.push({ ...base, decision: "unchanged", files: [] });
        continue;
      }
      if (merged.files === undefined) {
        apps.push({
          ...base,
          decision: "edited",
          files: merged.blocked,
          reason: "These files are not what the importer generated before the fix.",
        });
        continue;
      }
      const [index, ...others] = merged.files;
      if (apply && index !== undefined) {
        const failure = yield* executor.apps
          .deploy({ owner: appOwner, app, files: [index, ...others] })
          .pipe(
            Effect.as(undefined),
            Effect.catchTags({
              VersionBuildFailed: (error) => Effect.succeed(`It did not build. ${error.message}`),
            }),
            sharedAppCreation,
            Effect.provideService(CurrentUserId, context.owner),
          );
        if (failure !== undefined) {
          apps.push({ ...base, decision: "failed", files: merged.changed, reason: failure });
          continue;
        }
      }
      apps.push({ ...base, decision: "deploy", files: merged.changed });
    }
    return {
      organization,
      v2Organization: target.id,
      applied: apply,
      status: apply ? "repaired" : "planned",
      apps,
    } satisfies OrganizationRepair;
  });
