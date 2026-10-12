/** Search, describe and call reach app tools through MCP without an execute program. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";

const source = `import { defineApp, mutation, query, object, string, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({ accounts: {} }, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text back to the caller" },
    async (_ctx, { text }) => ({ text })),
  oversized: query({ input: object({}), description: "Return more than the output limit" },
    async () => ({ data: "x".repeat(150000) })),
  review: mutation({ input: object({ note: string() }), approval: always(), description: "Record a reviewed note" },
    async (_ctx, { note }) => ({ reviewed: note })),
}) }));`;

const SearchResult = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, input: Schema.String })),
});
const DescribeResult = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
  missing: Schema.Array(
    Schema.Struct({ path: Schema.String, matches: Schema.Array(Schema.String) }),
  ),
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, outcome: Schema.String })),
  }),
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("MCP direct calls", (it) => {
  it.effect(scenarios.mcpDirectCalls.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Direct calls",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Direct calls ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "direct-calls", {
          organization: actors.organization.id,
        });
        const tool = (label: string, name: string, args: Record<string, unknown>) =>
          Effect.gen(function* () {
            const result = yield* client.use(label, (client, signal) =>
              client.callTool({ name, arguments: args }, undefined, { signal }),
            );
            yield* evidence.json(
              `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`,
              result.structuredContent,
            );
            return result.structuredContent;
          });

        const listed = yield* client.use("List the MCP tools", (client) => client.listTools());
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "call",
          "describe",
          "execute",
          "resume",
          "search",
          "skills",
        ]);

        // Search returns the exact paths call and execute both accept.
        const found = yield* Schema.decodeUnknownEffect(SearchResult)(
          yield* tool("Search the app", "search", { namespace: app.slug, query: "echo" }),
        );
        const echo = `tools[${JSON.stringify(app.slug)}].echo`;
        const oversized = `tools[${JSON.stringify(app.slug)}].oversized`;
        const review = `tools[${JSON.stringify(app.slug)}].review`;
        expect(found.items[0]).toMatchObject({ path: echo });
        expect(found.items[0]?.input).toContain("text");

        const described = yield* Schema.decodeUnknownEffect(DescribeResult)(
          yield* tool("Describe tools", "describe", { paths: [echo, `${echo}x`] }),
        );
        expect(described.items.map((item) => item.path)).toEqual([echo]);
        expect(described.items[0]?.signature).toContain("text");
        // An unknown path lists the closest paths, nearest first.
        expect(described.missing.map((entry) => entry.path)).toEqual([`${echo}x`]);
        expect(described.missing[0]?.matches[0]).toBe(echo);

        // One call returns its outcome alone.
        const single = yield* Schema.decodeUnknownEffect(Completed)(
          yield* tool("Call one tool", "call", { calls: { path: echo, input: { text: "hi" } } }),
        );
        expect(single.execution).toMatchObject({
          ok: true,
          value: { path: echo, ok: true, value: { text: "hi" } },
          toolCalls: [{ name: echo, outcome: "success" }],
        });

        // A batch keeps its order, and one call failing does not stop the others.
        const batch = yield* Schema.decodeUnknownEffect(Completed)(
          yield* tool("Call a batch", "call", {
            calls: [
              { path: echo, input: { text: "first" } },
              { path: `${echo}x`, input: {} },
              { path: oversized, input: {} },
              { path: echo, input: { text: "last" } },
            ],
          }),
        );
        expect(batch.execution.ok).toBe(true);
        expect(batch.execution.value).toMatchObject([
          { path: echo, ok: true, value: { text: "first" } },
          { path: `${echo}x`, ok: false, error: { kind: "UnknownTool" } },
          { path: oversized, ok: false, error: { kind: "Truncated" } },
          { path: echo, ok: true, value: { text: "last" } },
        ]);
        expect(JSON.stringify(batch.execution.value)).toContain(
          `"matches":[${JSON.stringify(echo)}`,
        );

        // An approval pauses the call; resume runs it once and returns its outcome.
        const pending = yield* Schema.decodeUnknownEffect(Pending)(
          yield* tool("Call a tool that needs approval", "call", {
            calls: { path: review, input: { note: "ship it" } },
          }),
        );
        const resumed = yield* Schema.decodeUnknownEffect(Completed)(
          yield* tool("Approve the call", "resume", {
            requestId: pending.requestId,
            response: { action: "accept" },
          }),
        );
        expect(resumed.execution).toMatchObject({
          ok: true,
          value: { path: review, ok: true, value: { reviewed: "ship it" } },
          toolCalls: [{ name: review, outcome: "success" }],
        });
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
