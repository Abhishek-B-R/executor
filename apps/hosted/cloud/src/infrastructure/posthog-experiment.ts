/** Code-managed native PostHog experiments. PostHog owns allocation and all result statistics. */
import { isDeepStrictEqual } from "node:util";
import { Credentials } from "@distilled.cloud/posthog/Credentials";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { onboardingExperiment } from "../contracts/onboarding.ts";
import { PostHogProvisioningFailed } from "./posthog-provider.ts";

const ownership = (key: string) => `[executor-next:${key}]`;
/** An event property that must match one of the listed values. */
const PropertyFilter = Schema.Struct({
  key: Schema.String,
  value: Schema.Array(Schema.String),
  operator: Schema.Literal("exact"),
  type: Schema.Literal("event"),
});
const Source = Schema.Struct({
  kind: Schema.Literal("EventsNode"),
  event: Schema.String,
  properties: Schema.optionalKey(Schema.Array(PropertyFilter)),
});
const Metric = Schema.Struct({
  uuid: Schema.String,
  name: Schema.String,
  kind: Schema.Literal("ExperimentMetric"),
  metric_type: Schema.Literal("funnel"),
  goal: Schema.Literals(["increase", "decrease"]),
  conversion_window: Schema.Number,
  conversion_window_unit: Schema.Literal("day"),
  series: Schema.Array(Source),
});
const FlagConfig = Schema.Struct({
  ensure_experience_continuity: Schema.Boolean,
  filters: Schema.Struct({
    groups: Schema.Array(
      Schema.Struct({
        properties: Schema.Array(Schema.Unknown),
        rollout_percentage: Schema.Number,
      }),
    ),
    multivariate: Schema.Struct({
      variants: Schema.Array(
        Schema.Struct({ key: Schema.String, rollout_percentage: Schema.Number }),
      ),
    }),
  }),
});
const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  feature_flag_key: Schema.String,
  feature_flag: FlagConfig,
  parameters: Schema.optional(
    Schema.Struct({ variant_notes: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
  ),
  metrics: Schema.Array(Metric),
  metrics_secondary: Schema.Array(Metric),
  exposure_criteria: Schema.Struct({
    filterTestAccounts: Schema.Boolean,
    multiple_variant_handling: Schema.Literal("exclude"),
  }),
  only_count_matured_users: Schema.Boolean,
});

/** Declared native configuration carried in Alchemy resource props and state. */
export type PostHogExperimentDefinition = typeof Definition.Type;

const window = {
  kind: "ExperimentMetric",
  metric_type: "funnel",
  conversion_window: onboardingExperiment.attributionDays,
  conversion_window_unit: "day",
} as const;
const onboardingAction = (action: string) => ({
  kind: "EventsNode" as const,
  event: "product_action",
  properties: [
    { key: "area", value: ["onboarding"], operator: "exact" as const, type: "event" as const },
    { key: "action", value: [action], operator: "exact" as const, type: "event" as const },
  ],
});

/**
 * Accounts first or the assistant first, for members creating their first Cloud team. Native
 * funnel metrics include exposure automatically, so no series repeats it. The primary metric is
 * activation that neither order reaches by construction: the first successful tool call.
 */
export const onboardingExperimentDefinition: PostHogExperimentDefinition = {
  name: "Onboarding order: accounts or assistant first",
  description: `Members creating their first Cloud team connect their accounts before their assistant (control), or connect their assistant over MCP before their accounts. Both orders end at the first prompt.\n${ownership(onboardingExperiment.flag)}`,
  feature_flag_key: onboardingExperiment.flag,
  feature_flag: {
    // Cloud keeps each team's assignment, and the person's ID never changes, so PostHog does
    // not need to persist one too.
    ensure_experience_continuity: false,
    filters: {
      groups: [{ properties: [], rollout_percentage: 100 }],
      multivariate: {
        variants: [
          { key: "accounts_first", rollout_percentage: 50 },
          { key: "assistant_first", rollout_percentage: 50 },
        ],
      },
    },
  },
  parameters: {
    variant_notes: {
      accounts_first: "Create team, connect accounts, connect assistant, first prompt",
      assistant_first: "Create team, connect assistant, connect accounts, first prompt",
    },
  },
  metrics: [
    {
      ...window,
      uuid: "5f0f3c1e-8f5a-4f37-9d0a-1c6e2b7a4d21",
      name: "First successful tool call within 7 days",
      goal: "increase",
      series: [
        {
          kind: "EventsNode",
          event: "tool_execution_completed",
          properties: [{ key: "ok", value: ["true"], operator: "exact", type: "event" }],
        },
      ],
    },
  ],
  metrics_secondary: [
    {
      ...window,
      uuid: "a3b6d0e2-41c7-4e8b-9b55-7f2d9c0e6a13",
      name: "MCP agent connected",
      goal: "increase",
      series: [
        {
          kind: "EventsNode",
          event: "agent_connected",
          properties: [{ key: "grant_kind", value: ["mcp"], operator: "exact", type: "event" }],
        },
      ],
    },
    {
      ...window,
      uuid: "c81e4a57-2d36-4f0b-8e1a-5b9c3f7d2e64",
      name: "Account connected",
      goal: "increase",
      series: [{ kind: "EventsNode", event: "account_connected" }],
    },
    {
      ...window,
      uuid: "e4d27b90-6a1f-4c3e-b8d5-0f9a2c6e7b31",
      name: "Reached the first prompt",
      goal: "increase",
      series: [onboardingAction("setup_prompt")],
    },
    {
      ...window,
      uuid: "1b7c5e3a-9d42-4f86-a0e7-3c8f2d6b9a54",
      name: "Skipped the accounts step",
      goal: "decrease",
      series: [onboardingAction("skip_accounts")],
    },
    {
      ...window,
      uuid: "7d2f9a6c-3e18-4b57-9c40-8a1e5f3b2d97",
      name: "Skipped the assistant step",
      goal: "decrease",
      series: [onboardingAction("skip_assistant")],
    },
  ],
  exposure_criteria: { filterTestAccounts: true, multiple_variant_handling: "exclude" },
  only_count_matured_users: true,
};

const Experiment = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.String,
  start_date: Schema.NullOr(Schema.String),
  end_date: Schema.NullOr(Schema.String),
  version: Schema.Number,
  feature_flag: Schema.Struct({ id: Schema.Number, key: Schema.String }),
  parameters: Schema.optional(Schema.Unknown),
  metrics: Schema.Array(Schema.Unknown),
  metrics_secondary: Schema.Array(Schema.Unknown),
  exposure_criteria: Schema.Unknown,
  only_count_matured_users: Schema.Boolean,
});
const NativeFlag = Schema.Struct({
  id: Schema.Number,
  key: Schema.String,
  active: Schema.Boolean,
  ...FlagConfig.fields,
});

/** A narrow REST adapter retains conversion_window_unit, which the generated write DTO omits. */
export const nativeExperiments = Effect.gen(function* () {
  const credentials = yield* yield* Credentials;
  const client = yield* HttpClient.HttpClient;
  const request = (
    project: number,
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
  ) =>
    Effect.gen(function* () {
      const authenticated = HttpClientRequest.make(method)(
        `${credentials.apiBaseUrl}/api/projects/${project}/${path}`,
      ).pipe(HttpClientRequest.bearerToken(Redacted.make(credentials.apiKey)));
      const outgoing =
        body === undefined
          ? authenticated
          : authenticated.pipe(HttpClientRequest.bodyJsonUnsafe(body));
      const response = yield* client.execute(outgoing);
      if (response.status < 200 || response.status >= 300)
        return yield* new PostHogProvisioningFailed({
          operation: `${method} ${path}: HTTP ${response.status}`,
          detail: Redacted.make(yield* response.json),
        });
      return yield* response.json;
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(
        (detail) =>
          new PostHogProvisioningFailed({
            operation: `${method} ${path}`,
            detail: Redacted.make(detail),
          }),
      ),
    );
  const get = Effect.fn(function* (project: number, id: number) {
    const experiment = yield* request(project, `experiments/${id}/`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Experiment)),
    );
    const flag = yield* request(project, `feature_flags/${experiment.feature_flag.id}/`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(NativeFlag)),
    );
    const actual = yield* Schema.decodeUnknownEffect(Definition)({
      ...experiment,
      feature_flag_key: flag.key,
      feature_flag: flag,
    });
    return { ...experiment, flag, definition: actual };
  });
  const find = Effect.fn(function* (project: number, flagKey: string) {
    let offset = 0;
    let found: number | undefined;
    while (true) {
      const page = yield* request(
        project,
        `experiments/?limit=100&offset=${offset}&status=all&archived=false`,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              results: Schema.Array(
                Schema.Struct({
                  id: Schema.Number,
                  feature_flag: Schema.Struct({ key: Schema.String }),
                }),
              ),
              next: Schema.NullOr(Schema.String),
            }),
          ),
        ),
      );
      for (const item of page.results)
        if (item.feature_flag.key === flagKey) {
          if (found !== undefined)
            return yield* Effect.die(`Multiple experiments own the ${flagKey} flag`);
          found = item.id;
        }
      if (page.next === null) return found === undefined ? undefined : yield* get(project, found);
      if (page.results.length === 0) return yield* Effect.die("Empty experiment pagination page");
      offset += page.results.length;
    }
  });
  const sync = Effect.fn(function* (project: number, definition: PostHogExperimentDefinition) {
    const existing = yield* find(project, definition.feature_flag_key);
    if (
      existing !== undefined &&
      !existing.description.endsWith(ownership(definition.feature_flag_key))
    )
      return yield* Effect.die(`The ${definition.feature_flag_key} experiment is not owned here`);
    if (existing !== undefined && isDeepStrictEqual(existing.definition, definition))
      return existing;
    if (existing !== undefined && existing.start_date !== null)
      return yield* Effect.die("Use a new experiment key to change a launched experiment");
    if (existing === undefined) {
      const flags = yield* request(
        project,
        `feature_flags/?search=${encodeURIComponent(definition.feature_flag_key)}`,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ results: Schema.Array(Schema.Struct({ key: Schema.String })) }),
          ),
        ),
      );
      if (flags.results.some((flag) => flag.key === definition.feature_flag_key))
        return yield* Effect.die(
          `An existing ${definition.feature_flag_key} flag is not owned by its experiment`,
        );
    }
    // Register the intentional event names without emitting synthetic production events
    // or disabling PostHog's unknown-event validation.
    for (const name of new Set(
      [...definition.metrics, ...definition.metrics_secondary].flatMap((metric) =>
        metric.series.map((source) => source.event),
      ),
    )) {
      const definitions = yield* request(
        project,
        `event_definitions/?names=${encodeURIComponent(name)}`,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ results: Schema.Array(Schema.Struct({ name: Schema.String })) }),
          ),
        ),
      );
      if (!definitions.results.some((value) => value.name === name))
        yield* request(project, "event_definitions/", "POST", { name, post_to_slack: false });
    }
    const created = yield* request(
      project,
      existing === undefined ? "experiments/" : `experiments/${existing.id}/`,
      existing === undefined ? "POST" : "PATCH",
      {
        ...definition,
        ...(existing === undefined ? {} : { version: existing.version }),
      },
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Number }))));
    const result = yield* get(project, created.id);
    if (
      !isDeepStrictEqual(result.definition, definition) ||
      result.start_date !== null ||
      result.flag.active
    )
      return yield* Effect.die("PostHog did not retain the declared draft configuration");
    return result;
  });
  const results = (project: number, experiment: Effect.Success<ReturnType<typeof get>>) =>
    Effect.gen(function* () {
      if (experiment.start_date === null) return { status: "draft", results: [] };
      const output = [];
      for (const metric of [...experiment.metrics, ...experiment.metrics_secondary]) {
        const result = yield* request(project, "query/", "POST", {
          query: { kind: "ExperimentQuery", experiment_id: experiment.id, metric },
          refresh: "force_blocking",
        });
        output.push({ metric, result });
      }
      return {
        status:
          experiment.end_date !== null ? "stopped" : experiment.flag.active ? "running" : "paused",
        results: output,
      };
    });
  return { find, sync, results };
});

interface Props {
  readonly projectId: number;
  readonly definition: PostHogExperimentDefinition;
}
interface Attributes extends Props {
  readonly id: number;
  readonly featureFlagId: number;
}
/** A native experiment lifecycle retained separately from the application deployment. */
export type PostHogExperiment = Resource<"Executor.PostHogExperiment", Props, Attributes>;
/** Declares a draft experiment and its native multivariate feature flag. */
export const PostHogExperiment = Resource<PostHogExperiment>("Executor.PostHogExperiment");
/** No deployment starts, pauses or deletes an experiment or changes a launched definition. */
export const postHogExperimentProvider = () =>
  Provider.effect(
    PostHogExperiment,
    Effect.gen(function* () {
      const api = yield* nativeExperiments;
      const attributes = (
        projectId: number,
        value: NonNullable<Effect.Success<ReturnType<typeof api.find>>>,
      ): Attributes => ({
        projectId,
        id: value.id,
        featureFlagId: value.flag.id,
        definition: value.definition,
      });
      return {
        stables: ["id", "projectId", "featureFlagId"],
        diff: ({ news, output }) =>
          !isResolved(news) || output === undefined
            ? Effect.succeed(undefined)
            : Effect.succeed(
                news.projectId !== output.projectId ||
                  news.definition.feature_flag_key !== output.definition.feature_flag_key
                  ? { action: "replace" as const }
                  : isDeepStrictEqual(news.definition, output.definition)
                    ? undefined
                    : { action: "update" as const },
              ),
        read: Effect.fn(function* ({ olds }) {
          const value = yield* api.find(olds.projectId, olds.definition.feature_flag_key);
          if (
            value !== undefined &&
            !value.description.endsWith(ownership(olds.definition.feature_flag_key))
          )
            return yield* Effect.die("Experiment ownership mismatch");
          return value === undefined ? undefined : attributes(olds.projectId, value);
        }),
        reconcile: Effect.fn(function* ({ news }) {
          return attributes(news.projectId, yield* api.sync(news.projectId, news.definition));
        }),
        // Retiring an experiment orphans its state; its results stay in PostHog.
        delete: () => Effect.void,
      };
    }),
  );

interface RetiredProps {
  readonly projectId: number;
}
interface RetiredAttributes extends RetiredProps {
  readonly id: number;
}
/**
 * The retired homepage hero experiment. The stack no longer declares it, and its state row was
 * retained, so the next deploy orphans the row and leaves the experiment and its results in
 * PostHog. Alchemy needs this provider registered to plan that orphaning; it never creates,
 * changes or deletes anything. Remove it once every stage has deployed without the resource.
 */
export type PostHogHeroExperiment = Resource<
  "Executor.PostHogHeroExperiment",
  RetiredProps,
  RetiredAttributes
>;
/** Not declared by any stack; exists only so Alchemy can resolve the retained row's type. */
export const PostHogHeroExperiment = Resource<PostHogHeroExperiment>(
  "Executor.PostHogHeroExperiment",
);
/** Never touches PostHog: the experiment and its data stay there. */
export const retiredExperimentProvider = () =>
  Provider.succeed(PostHogHeroExperiment, {
    reconcile: () => Effect.die("The hero experiment is retired; do not declare it"),
    delete: () => Effect.void,
  });
