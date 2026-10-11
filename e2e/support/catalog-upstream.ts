/** A synthetic published catalog feed that counts every fetch the product makes. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { type Duration, Effect, Exit, Layer, Ref, Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

/** Entries in the integrations.sh v1 shape, with fields the product ignores. */
export const catalogFixture = {
  mail: {
    id: "fixture/acme-mail-mcp",
    kind: "mcp",
    name: "Acme Mail",
    description: "A synthetic mail service",
    domain: "mail.acme-mail.example",
    connectUrl: "https://mcp.acme-mail.example/mcp",
    icon: "https://icons.example/acme-mail.png",
    categories: ["email"],
  },
  mailGraphql: {
    id: "fixture/acme-mail-graphql",
    kind: "graphql",
    name: "Acme Mail",
    description: "The same synthetic mail service over GraphQL",
    domain: "acme-mail.example",
  },
  // One name, two services: no logo domain may be guessed for it.
  twinOne: {
    id: "fixture/twin-one",
    kind: "openapi",
    name: "Twin",
    description: "A synthetic service sharing its name",
    domain: "twin-one.example",
  },
  twinTwo: {
    id: "fixture/twin-two",
    kind: "openapi",
    name: "Twin",
    description: "Another synthetic service sharing its name",
    domain: "twin-two.example",
  },
} as const;

/** A feed entry marking one published revision, so a reader can tell which revision it got. */
export const catalogRevision = (revision: number) => ({
  id: `fixture/revision-${revision}`,
  kind: "openapi",
  name: `Revision ${revision}`,
  description: "A synthetic entry marking one feed revision",
  domain: `revision-${revision}.example`,
});

/**
 * Serve the feed at `url` on loopback. Each response waits `delay`, so reads that start together
 * overlap one fetch. `fetches` counts the requests received and `answered` the responses sent.
 * `publish` replaces the entries later fetches receive, and `fail` makes them fail until the next
 * `publish`. The case scope closes the listener.
 */
export const catalogUpstream = (delay: Duration.Input = "300 millis") =>
  Effect.gen(function* () {
    const listener = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(listener, Exit.void));
    const fetches = yield* Ref.make(0);
    const answered = yield* Ref.make(0);
    const published = yield* Ref.make<ReadonlyArray<object> | "failing">(
      Object.values(catalogFixture),
    );
    const routes = HttpRouter.add(
      "GET",
      "/api.json",
      Ref.update(fetches, (count) => count + 1).pipe(
        Effect.andThen(Effect.sleep(delay)),
        Effect.andThen(Ref.get(published)),
        Effect.map((data) =>
          data === "failing"
            ? HttpServerResponse.text("Feed unavailable", { status: 503 })
            : HttpServerResponse.jsonUnsafe({
                version: 1,
                generatedAt: "2026-01-01T00:00:00.000Z",
                data,
              }),
        ),
        Effect.tap(() => Ref.update(answered, (count) => count + 1)),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    ).pipe(Scope.provide(listener));
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Catalog fixture must listen on TCP");
    return {
      url: `http://127.0.0.1:${server.address.port}/api.json`,
      fetches: Ref.get(fetches),
      answered: Ref.get(answered),
      publish: (entries: ReadonlyArray<object>) => Ref.set(published, entries),
      fail: Ref.set(published, "failing"),
    };
  });
