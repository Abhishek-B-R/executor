/**
 * The one-off repair of organizations moved before the importer took v1's approval stamps and
 * decided the tools v1 did not list (`notes/v1-import.md`, "Repair of moved organizations"). It
 * changes what those fixes change and nothing else, with the importer's own code, so a repaired
 * app holds what an import makes now: an MCP tool whose row v1 stamped as needing approval, and
 * that no policy decided, gets the app's own `always` rule (`toolActions`), and a tool v1 did not
 * list gets what v1's rules give it (`v1ToolRules`). The app's source
 * is generated again, as the importer generates it, and a new version is deployed through the
 * importer's own deploy call. A file the fixes change is replaced only when the deployed one is
 * still an earlier importer's output.
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
  v1ToolRules,
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

/**
 * What deciding the tools v1 did not list changes in an app, beside the stamps: the tools v1's
 * rules name, or for OpenAPI the operations v1 compiled (`operations`), that it now leaves out or
 * asks before, and what a tool no rule names gets on a server that lists tools as it runs. Null
 * when nothing changes.
 */
export const unlistedChange = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  operations?: readonly string[],
) => {
  const aliases = integration.plugin_id === "mcp" ? mcpNaming(tools).aliases : {};
  const before = approvalRules(toolActions(snapshot, integration, tools, aliases));
  const now = v1ToolRules(snapshot, integration, tools, aliases, operations);
  const change = {
    omitted: (now.omitted ?? []).filter((name) => !before.omitted.includes(name)).sort(),
    always: Object.keys(now.approvals ?? {})
      .filter((name) => now.approvals?.[name] === "always" && before.approvals[name] !== "always")
      .sort(),
    otherwise: now.otherwise?.rule ?? null,
  };
  return change.omitted.length === 0 && change.always.length === 0 && change.otherwise === null
    ? null
    : change;
};

export interface AppRepair {
  readonly integration: string;
  readonly app: string;
  readonly always: readonly string[];
  readonly unlisted: ReturnType<typeof unlistedChange>;
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
 * The files of a new version: the deployed ones, with each file the fixes change taken from the
 * importer's output now. Undefined, with the paths that block it, when a file the fixes change is
 * neither any earlier importer's output (`before`) nor the output now. `done` when every such file
 * is already the importer's output now, as after an earlier repair.
 */
export const mergedFiles = (
  deployed: readonly SourceFile[],
  before: readonly (readonly SourceFile[])[],
  after: readonly SourceFile[],
) => {
  const at = (files: readonly SourceFile[], path: string) =>
    files.find((file) => file.path === path);
  const paths = [...new Set([...before.flat(), ...after].map((file) => file.path))].filter((path) =>
    before.some((earlier) => fileKey(at(earlier, path)) !== fileKey(at(after, path))),
  );
  const done = paths.every((path) => fileKey(at(deployed, path)) === fileKey(at(after, path)));
  const blocked = paths.filter(
    (path) =>
      fileKey(at(deployed, path)) !== fileKey(at(after, path)) &&
      before.every((earlier) => fileKey(at(deployed, path)) !== fileKey(at(earlier, path))),
  );
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

/**
 * Each imported app of the organization the fixes change: an MCP app whose tools the stamp fix
 * makes ask always, and an app whose rules decide tools v1 did not list.
 */
export const planStampedApps = (
  snapshot: V1Snapshot,
  source: Pick<V1Source, "tools" | "openApiOperations">,
  store: Pick<ImportStore, "find">,
) =>
  Effect.gen(function* () {
    const planned: {
      integration: IntegrationRow;
      app: AppId;
      always: readonly string[];
      unlisted: ReturnType<typeof unlistedChange>;
    }[] = [];
    for (const integration of snapshot.integrations) {
      const imported = yield* store.find("integration", integration.row_id);
      if (imported?.status !== "imported" || imported.v2_id === null) continue;
      const tools = yield* source.tools(snapshot.tenant, snapshot.subjects, integration.slug);
      const always =
        integration.plugin_id === "mcp" ? stampedAlways(snapshot, integration, tools) : [];
      const operations =
        integration.plugin_id === "openapi"
          ? (yield* source.openApiOperations(snapshot.tenant, integration.slug)).map(
              (operation) => operation.tool,
            )
          : undefined;
      const unlisted = unlistedChange(snapshot, integration, tools, operations);
      if (always.length > 0 || unlisted !== null)
        planned.push({ integration, app: AppId.make(imported.v2_id), always, unlisted });
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

    // v1's stamps and its rules for tools it did not list become the app's own.
    const apps: AppRepair[] = [];
    const appOwner = organizationOwner(target.id);
    for (const { integration, app, always, unlisted } of yield* planStampedApps(
      snapshot,
      source,
      store,
    )) {
      const base = { integration: integrationLabel(integration), app, always, unlisted };
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
        // What the importer generated before each fix: without either, and with the stamps only.
        before: Effect.all(
          [withoutStamps(source), source].map((earlier) =>
            generate(
              { ...context, source: earlier, unlistedRules: false },
              integration,
              plan.value,
              planned,
            ).pipe(Effect.flatMap((out) => scoped(out.files))),
          ),
        ),
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
