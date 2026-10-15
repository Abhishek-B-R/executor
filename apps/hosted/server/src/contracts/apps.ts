import {
  VersionDisplay,
  SourceDisplayFile,
  SourceDisplayFileQuery,
} from "@executor-js/app-management/contracts/source-display";
import { RequiredAction } from "./authorization.ts";
import { AppWorkflowsActive } from "@executor-js/sdk/core";
import { AppWebhooksActive } from "@executor-js/sdk/core";
/** App installation and configuration. Owners always come from authenticated organization context. */
import {
  CatalogImport,
  CatalogImportFailed,
  CatalogUnavailable,
  CustomAppInput,
} from "@executor-js/catalog/contracts";
import {
  AccountNotFound,
  AccountSelectionInvalid,
  App,
  DeployedApp,
  AppNotDeployed,
  AppId,
  AppName,
  Version,
  VersionId,
  VersionSummary,
  VersionNotFound,
  AppVersionChanged,
  AppNameTaken,
  AppSlugTaken,
  AppNotFound,
  VersionBuildFailed,
  BuildMemoryExceeded,
  SkillDefinitionInvalid,
  SourceFiles,
  sourceErrors,
  StorageError,
} from "@executor-js/sdk/core";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { withLegacyKeys } from "@executor-js/utils/legacy-keys";
import {
  OrganizationReference,
  OrganizationForbidden,
  RequireOrganization,
} from "./organization.ts";

/** Catalog installation is create-only: it cannot overwrite another app by name. */
export const InstallApp = Schema.Struct({ ...CatalogImport.fields, name: Schema.NonEmptyString });
/** Deploying source directly uses the same runtime as generated catalog apps. */
export const DeployApp = Schema.Struct({ name: Schema.NonEmptyString, files: SourceFiles });
const params = { organization: OrganizationReference };
const app = { ...params, app: AppId };
const deployErrors = [
  AppNotFound,
  AppVersionChanged,
  StorageError,
  VersionBuildFailed,
  BuildMemoryExceeded,
  SkillDefinitionInvalid,
  ...sourceErrors,
  AppNameTaken,
  AppSlugTaken,
  AccountNotFound,
  AccountSelectionInvalid,
  OrganizationForbidden,
] as const;
const prefix = "/api/organizations/:organization/apps";
// Versions were called deployments. The former paths and field names stay accepted, and responses
// repeat the former field names, so API callers written before the rename keep working.
const versionsOptions = {
  params: app,
  success: Schema.Array(VersionSummary),
  error: [StorageError, AppNotFound, OrganizationForbidden],
};
const versionQuery = Schema.Struct({ version: Schema.optional(VersionId) }).pipe(
  withLegacyKeys({ version: "deployment" }),
);
const sourceDisplayFileOptions = {
  params: { ...app, version: VersionId },
  query: SourceDisplayFileQuery,
  success: SourceDisplayFile,
  error: [
    StorageError,
    AppNotFound,
    AppNotDeployed,
    VersionNotFound,
    OrganizationForbidden,
    ...sourceErrors,
  ],
};
/** Shared app routes; both hosts supply the same handlers. */
export const HostedApps = HttpApiGroup.make("apps")
  .add(
    HttpApiEndpoint.post("install", `${prefix}/install`, {
      params,
      payload: InstallApp,
      success: DeployedApp,
      error: [...deployErrors, CatalogImportFailed, CatalogUnavailable],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("importCustom", `${prefix}/import`, {
      params,
      payload: Schema.Struct({ source: CustomAppInput }),
      success: DeployedApp,
      error: [...deployErrors, CatalogImportFailed],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.post("deploy", `${prefix}/deploy`, {
      params,
      payload: DeployApp,
      success: DeployedApp,
      error: deployErrors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("get", `${prefix}/:app`, {
      params: app,
      success: App,
      error: [StorageError, AppNotFound],
    }).annotate(RequiredAction, "discover"),
  )
  .add(
    HttpApiEndpoint.delete("remove", `${prefix}/:app`, {
      params: app,
      success: Schema.Struct({ app: AppId }),
      error: [StorageError, AppWebhooksActive, AppWorkflowsActive, OrganizationForbidden],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("versions", `${prefix}/:app/versions`, versionsOptions).annotate(
      RequiredAction,
      "read",
    ),
  )
  .add(
    HttpApiEndpoint.get("deployments", `${prefix}/:app/deployments`, versionsOptions)
      .annotate(RequiredAction, "read")
      .annotate(OpenApi.Deprecated, true),
  )
  .add(
    HttpApiEndpoint.get("source", `${prefix}/:app/source`, {
      params: app,
      query: versionQuery,
      success: Version,
      error: [StorageError, AppNotFound, AppNotDeployed, VersionNotFound, OrganizationForbidden],
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get("sourceDisplay", `${prefix}/:app/source/display`, {
      params: app,
      query: versionQuery,
      success: VersionDisplay,
      error: [StorageError, AppNotFound, AppNotDeployed, VersionNotFound, OrganizationForbidden],
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get(
      "sourceDisplayFile",
      `${prefix}/:app/versions/:version/display/file`,
      sourceDisplayFileOptions,
    ).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.get(
      "legacySourceDisplayFile",
      `${prefix}/:app/deployments/:version/display/file`,
      sourceDisplayFileOptions,
    )
      .annotate(RequiredAction, "read")
      .annotate(OpenApi.Deprecated, true),
  )
  .add(
    HttpApiEndpoint.post("activate", `${prefix}/:app/activate`, {
      params: app,
      payload: Schema.Struct({
        version: VersionId,
        expectedVersion: Schema.NullOr(VersionId),
      }).pipe(withLegacyKeys({ version: "deployment", expectedVersion: "expectedDeployment" })),
      success: App,
      error: [
        StorageError,
        AppNotFound,
        AppNotDeployed,
        VersionNotFound,
        AppVersionChanged,
        AccountNotFound,
        AccountSelectionInvalid,
        OrganizationForbidden,
      ],
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.patch("rename", `${prefix}/:app/name`, {
      params: app,
      payload: Schema.Struct({ name: AppName }),
      success: App,
      error: [StorageError, AppNotFound, AppNameTaken, AppSlugTaken, OrganizationForbidden],
    }).annotate(RequiredAction, "manage"),
  )
  .middleware(RequireOrganization);
