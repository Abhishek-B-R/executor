import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { mcpAuthServer } from "../support/mcp-auth-patterns.ts";
import { Target } from "../support/platform.ts";
import { createProfile } from "../support/profiles.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Imported = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
  }),
});

layer(HostedLive, { excludeTestServices: true })("Private HTTPS MCP", (it) => {
  it.effect(scenarios.privateHttpsMcp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          processes = yield* ChildProcessSpawner.ChildProcessSpawner,
          api = yield* Api,
          actors = yield* Actors,
          target = yield* Target;
        // Trust only this scenario's short-lived certificate, without disabling TLS verification.
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-https-mcp-" });
        const certificate = `${directory}/cert.pem`;
        const key = `${directory}/key.pem`;
        yield* processes.string(
          ChildProcess.make(
            "openssl",
            [
              "req",
              "-x509",
              "-newkey",
              "rsa:2048",
              "-nodes",
              "-keyout",
              key,
              "-out",
              certificate,
              "-days",
              "1",
              "-subj",
              "/CN=127.0.0.1",
              "-addext",
              "subjectAltName=IP:127.0.0.1,DNS:localhost",
            ],
            { stderr: "pipe" },
          ),
        );
        const tls = {
          key: yield* fs.readFileString(key),
          cert: yield* fs.readFileString(certificate),
        };
        const allowed = yield* mcpAuthServer("oauth-dcr", tls);
        const otherPort = yield* mcpAuthServer("oauth-dcr", tls);
        const prefix = `/api/organizations/${actors.organization.id}`;
        const attempt = (url: string) =>
          api.request(actors.owner, "POST", `${prefix}/apps/import`, {
            source: { kind: "mcp", name: "Private HTTPS fixture", url },
          });

        yield* serverControl("stop");
        yield* serverControl("environment", 200, {
          NODE_EXTRA_CA_CERTS: certificate,
          EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "false",
          EXECUTOR_URL_ALLOW_HTTP_ORIGINS: "[]",
        });
        yield* serverControl("start");
        expect((yield* attempt(allowed.url)).status).toBe(422);
        expect(yield* allowed.requests).toBe(0);

        yield* serverControl("stop");
        // Disabling the loopback shortcut also requires an explicit origin for the runner's callback.
        const callback = `http://account-picker.localhost:${new URL(target.metadata.origin).port}`;
        yield* serverControl("environment", 200, {
          EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([allowed.origin, callback]),
        });
        yield* serverControl("start");
        const imported = yield* attempt(allowed.url);
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(Imported, imported);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        expect(Object.keys(app.requirements.accounts)).toEqual(["service"]);

        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/start`,
          { method: "oauth", label: "Private HTTPS account" },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        expect(yield* allowed.registrations).toBe(1);
        const signIn = yield* body(Schema.Struct({ authorizationUrl: Schema.String }), started);
        expect(new URL(signIn.authorizationUrl).origin).toBe(allowed.origin);

        const requests = yield* allowed.requests;
        for (const url of [
          otherPort.url,
          allowed.url.replace("https:", "http:"),
          allowed.url.replace("127.0.0.1", "localhost"),
        ]) {
          expect((yield* attempt(url)).status, url).toBe(422);
        }
        expect(yield* otherPort.requests).toBe(0);
        expect(yield* allowed.requests).toBe(requests);
      }),
    ),
  );
});
