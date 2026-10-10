/**
 * The public catalogs self-host and local products read, served on loopback for a whole run: the
 * integrations.sh feed the Add app catalog lists, and the hosted Executor registry of published
 * apps. Scenarios then never depend on either live service. The feed holds copies of published
 * integrations.sh entries, with the fields the service serves, so the catalog sees each kind of
 * entry it handles: MCP servers it adds directly, and OpenAPI, GraphQL and CLI entries it hands to
 * the user's agent. The registry publishes nothing; registry-failures.spec.ts points a product at
 * its own registry fixture.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

const github = {
  slug: "github-com",
  name: "GitHub",
  description:
    "GitHub exposes more agent-callable surface area than almost any service: an official remote MCP server, a fully-specified REST API, a GraphQL API, and the `gh` CLI. Pick the format that fits your agent — they all reach the same data.",
  icon: "https://www.google.com/s2/favicons?domain=github.com&sz=64",
  domain: "github.com",
  categories: ["developer-tools", "version-control"],
  feeds: ["curated"],
  providerId: "github.com/api",
};

/** Published integrations.sh v1 entries, as https://integrations.sh/api.json serves them. */
const catalogFeedEntries = [
  {
    ...github,
    id: "curated/github-com-mcp",
    kind: "mcp",
    connectUrl: "https://api.githubcopilot.com/mcp/",
    auth: {
      kind: "mixed",
      header: "Authorization: Bearer {pat}",
      note: "OAuth in supporting clients, or a PAT bearer header anywhere else.",
    },
  },
  {
    ...github,
    id: "curated/github-com-openapi",
    kind: "openapi",
    slug: "github-com-openapi",
    connectUrl:
      "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    auth: { kind: "token", header: "Authorization: Bearer {pat}" },
  },
  {
    ...github,
    id: "curated/github-com-graphql",
    kind: "graphql",
    slug: "github-com-graphql",
    connectUrl: "https://api.github.com/graphql",
    auth: { kind: "token", header: "Authorization: Bearer {pat}" },
  },
  { ...github, id: "curated/github-com-cli", kind: "cli", slug: "github-com-cli" },
  {
    id: "mcp/cloudflare",
    kind: "mcp",
    slug: "cloudflare",
    name: "Cloudflare Developer Platform",
    description:
      "Enables users to build applications on Cloudflare Workers using built-in storage, AI, and compute primitives. Deploy code to production, create and query databases, manage KV stores, and more.",
    url: "https://www.support.cloudflare.com/",
    icon: "https://integrations.sh/logo/cloudflare.com",
    domain: "cloudflare.com",
    categories: ["code"],
    feeds: ["claude"],
    popularity: 17154,
    providerId: "cloudflare.com/bindings/mcp",
    connectUrl: "https://bindings.mcp.cloudflare.com/mcp",
  },
  {
    id: "openapi/cloudflare-com",
    kind: "openapi",
    slug: "cloudflare-com",
    name: "Cloudflare API",
    description:
      "The full Cloudflare API — manage DNS, Workers, R2, KV, Zero Trust, CDN/cache, WAF, and the rest of the Cloudflare platform.",
    icon: "https://integrations.sh/logo/cloudflare.com",
    domain: "cloudflare.com",
    categories: ["cloud", "developer_tools"],
    feeds: ["override"],
    providerId: "cloudflare.com/api",
    connectUrl: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
  },
];

/** Start the catalogs for the scope on loopback and return their origin. */
export const publicCatalogs = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/api.json",
          Effect.succeed(HttpServerResponse.jsonUnsafe({ version: 1, data: catalogFeedEntries })),
        ),
        HttpRouter.add(
          "GET",
          "/api/registry/apps",
          Effect.succeed(HttpServerResponse.jsonUnsafe([])),
        ),
        HttpRouter.add(
          "GET",
          "/api/registry/source",
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { _tag: "RegistryError", reason: "not-found" },
              { status: 400 },
            ),
          ),
        ),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("The catalogs must listen on TCP");
  return { origin: `http://127.0.0.1:${server.address.port}` };
});
