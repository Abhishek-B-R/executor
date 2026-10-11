/**
 * Run the real `executor upgrade` from the directory layout each package manager installs into,
 * against a fake npm registry and fake package managers on PATH. The fakes record how they were
 * called and install an `executor` command that prints the version they were asked for, so the
 * scenario sees what the CLI ran and what it verified without touching this machine's installs.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import { Config, Deferred, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { freePort } from "../support/ports.ts";

const Call = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, args: Schema.Array(Schema.String) }),
);

/**
 * A package manager stand-in. It records its arguments; then, by FAKE_PM_MODE, it installs a
 * working `executor`, installs one that cannot start, or fails as a registry error would.
 */
const fakePackageManager = `import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [name, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_PM_LOG, JSON.stringify({ name, args }) + "\\n");
const mode = process.env.FAKE_PM_MODE ?? "install";
if (mode === "fail") {
  console.error(name + " error: 503 Service Unavailable from the fake registry");
  process.exit(1);
}
const version = args.find((arg) => arg.startsWith("executor@")).slice("executor@".length);
console.log("installed executor@" + version + " with fake " + name);
const directory = process.env.FAKE_PM_BIN;
if (process.platform === "win32") {
  writeFileSync(join(directory, "executor.cmd"), mode === "broken"
    ? "@echo off\\r\\necho Executor's native runtime is missing. 1>&2\\r\\nexit /b 1\\r\\n"
    : "@echo off\\r\\necho executor v" + version + "\\r\\n");
} else {
  writeFileSync(join(directory, "executor"), mode === "broken"
    ? "#!/bin/sh\\necho \\"Executor's native runtime is missing.\\" >&2\\nexit 1\\n"
    : "#!/bin/sh\\necho \\"executor v" + version + "\\"\\n");
  chmodSync(join(directory, "executor"), 0o755);
}
`;

layer(TestLive, { excludeTestServices: true })("Local upgrade", (it) => {
  it.effect(
    scenarios.localUpgrade.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            processes = yield* ChildProcessSpawner.ChildProcessSpawner,
            evidence = yield* Evidence;
          const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
            Config.option,
          );
          const entry = path.resolve(
            Option.isSome(packagedEntry) ? packagedEntry.value : "apps/local/server/src/bin.ts",
          );
          const windows = process.platform === "win32";
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-upgrade-" });
          const bin = path.join(root, "bin");
          const log = path.join(root, "calls.jsonl");
          yield* fs.makeDirectory(bin);
          yield* fs.writeFileString(path.join(bin, "fake-pm.mjs"), fakePackageManager);
          for (const name of ["npm", "pnpm", "bun", "yarn"]) {
            const script = path.join(bin, "fake-pm.mjs");
            if (windows)
              yield* fs.writeFileString(
                path.join(bin, `${name}.cmd`),
                `@"${process.execPath}" "${script}" ${name} %*\r\n`,
              );
            else {
              yield* fs.writeFileString(
                path.join(bin, name),
                `#!/bin/sh\nexec "${process.execPath}" "${script}" ${name} "$@"\n`,
              );
              yield* fs.chmod(path.join(bin, name), 0o755);
            }
          }
          /** The package manager calls since the last read. */
          const calls = Effect.gen(function* () {
            if (!(yield* fs.exists(log))) return [];
            const lines = (yield* fs.readFileString(log)).split("\n").filter(Boolean);
            yield* fs.remove(log);
            return yield* Effect.forEach(lines, (line) => Schema.decodeUnknownEffect(Call)(line));
          });

          // The registry's dist-tags and the Node range each release declares.
          let published: Record<string, string> = {};
          let nodeRange = ">=24.14.0";
          const services = yield* Layer.build(
            HttpRouter.serve(
              Layer.mergeAll(
                HttpRouter.add(
                  "GET",
                  "/-/package/executor/dist-tags",
                  Effect.suspend(() => HttpServerResponse.json(published)),
                ),
                HttpRouter.add(
                  "GET",
                  "/executor/:version",
                  Effect.gen(function* () {
                    const { version } = yield* HttpRouter.schemaPathParams(
                      Schema.Struct({ version: Schema.String }),
                    );
                    return yield* HttpServerResponse.json({
                      name: "executor",
                      version,
                      engines: { node: nodeRange },
                    });
                  }).pipe(Effect.orDie),
                ),
              ),
              { disableLogger: true, disableListenLog: true },
            ).pipe(
              Layer.provideMerge(
                NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
              ),
            ),
          );
          const registry = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
          if (!("port" in registry.address))
            return yield* Effect.die("Registry must listen on TCP");
          const registryUrl = `http://127.0.0.1:${registry.address.port}`;

          /** A launcher at `location` that starts the CLI, as a package manager's install would. */
          const installedAt = (location: string) =>
            Effect.gen(function* () {
              const directory = path.join(root, location);
              yield* fs.makeDirectory(directory, { recursive: true });
              const launcher = path.join(directory, "bin.mjs");
              yield* fs.writeFileString(
                launcher,
                `await import(${JSON.stringify((yield* path.toFileUrl(entry)).href)});\n`,
              );
              return launcher;
            });
          const data = path.join(root, "data");
          const environment = (extra: Readonly<Record<string, string>>) => ({
            // Only the fake package managers and their installed `executor` are on PATH.
            PATH: bin,
            ...(windows
              ? {
                  SystemRoot: process.env.SystemRoot ?? "",
                  ComSpec: process.env.ComSpec ?? "",
                  PATHEXT: process.env.PATHEXT ?? "",
                }
              : {}),
            HOME: root,
            // Release scenarios never send product analytics, even from a build with a baked key.
            DO_NOT_TRACK: "1",
            // A packaged CLI keeps its own release version; this one applies from source.
            EXECUTOR_BUILD_VERSION: "2.0.0-beta.2",
            EXECUTOR_NPM_REGISTRY: registryUrl,
            EXECUTOR_DATA_DIR: data,
            FAKE_PM_LOG: log,
            FAKE_PM_BIN: bin,
            ...extra,
          });
          const run = (
            launcher: string,
            args: ReadonlyArray<string>,
            extra: Readonly<Record<string, string>> = {},
          ) =>
            evidence.step(
              `executor ${args.join(" ")} (${path.relative(root, path.dirname(launcher))})`,
              Effect.scoped(
                Effect.gen(function* () {
                  const child = yield* processes.spawn(
                    ChildProcess.make(process.execPath, [launcher, ...args], {
                      cwd: root,
                      extendEnv: false,
                      env: environment(extra),
                      stdout: "pipe",
                      stderr: "pipe",
                      forceKillAfter: "3 seconds",
                    }),
                  );
                  const [code, stdout, stderr] = yield* Effect.all(
                    [
                      child.exitCode,
                      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                    ],
                    { concurrency: 3 },
                  ).pipe(Effect.timeout("60 seconds"));
                  return { code: Number(code), stdout, stderr };
                }),
              ),
            );

          const npm = yield* installedAt("npm-prefix/lib/node_modules/executor");
          const printed = yield* run(npm, ["--version"]);
          const version = printed.stdout.trim().replace(/^executor v/u, "");
          const channel = version.includes("-beta.") ? "beta" : "latest";
          // Beta installs move to stable once it is newer, so the stable release is the target.
          published = { beta: "2.999.0-beta.1", latest: "2.999.0" };
          const upgraded = `Upgraded Executor from v${version} to v2.999.0.`;

          // npm installs globally and includes the optional dependency with the native runtime.
          const byNpm = yield* run(npm, ["upgrade"]);
          yield* evidence.json("npm.json", byNpm);
          expect(byNpm.code, byNpm.stderr).toBe(0);
          expect(byNpm.stdout).toContain("installed executor@2.999.0 with fake npm");
          expect(byNpm.stdout).toContain(upgraded);
          expect(yield* calls).toEqual([
            { name: "npm", args: ["install", "-g", "executor@2.999.0", "--include=optional"] },
          ]);

          // Each global package manager is detected from where it installs packages.
          for (const [location, name, args] of [
            ["pnpm/global/5/.pnpm/executor@2.0.0/node_modules/executor", "pnpm", ["add", "-g"]],
            [".bun/install/global/node_modules/executor", "bun", ["add", "-g"]],
            [".config/yarn/global/node_modules/executor", "yarn", ["global", "add"]],
          ] as const) {
            const result = yield* run(yield* installedAt(location), ["upgrade"]);
            expect(result.code, result.stderr).toBe(0);
            expect(result.stdout).toContain(upgraded);
            expect(yield* calls).toEqual([{ name, args: [...args, "executor@2.999.0"] }]);
          }

          // --method overrides the detected package manager.
          const overridden = yield* run(npm, ["upgrade", "--method", "pnpm"]);
          expect(overridden.code, overridden.stderr).toBe(0);
          expect(yield* calls).toEqual([{ name: "pnpm", args: ["add", "-g", "executor@2.999.0"] }]);

          // One-shot runners fetch the release each time; the CLI prints the command instead.
          for (const [location, runner] of [
            [".npm/_npx/0a1b2c3d/node_modules/executor", "npx"],
            ["tmp/bunx-501-executor@beta/node_modules/executor", "bunx"],
            [
              "pnpm-cache/dlx/abc/1/node_modules/.pnpm/executor@2.0.0/node_modules/executor",
              "pnpm dlx",
            ],
          ] as const) {
            const result = yield* run(yield* installedAt(location), ["upgrade"]);
            yield* evidence.json(`${runner.replace(" ", "-")}.json`, result);
            expect(result.code, result.stderr).toBe(0);
            expect(result.stdout).toContain(`Run the release with: ${runner} executor@${channel}`);
            expect(yield* calls).toEqual([]);
          }

          // A location no package manager uses gets the exact commands, and nothing is installed.
          const unknown = yield* run(yield* installedAt("opt/tools/executor"), ["upgrade"]);
          yield* evidence.json("unknown.json", unknown);
          expect(unknown.code).toBe(1);
          expect(unknown.stderr).toContain(
            "Executor could not tell which package manager installed it",
          );
          for (const command of [
            "npm install -g executor@2.999.0 --include=optional",
            "pnpm add -g executor@2.999.0",
            "bun add -g executor@2.999.0",
            "yarn global add executor@2.999.0",
          ])
            expect(unknown.stderr).toContain(command);
          expect(yield* calls).toEqual([]);

          // A Node older than the release requires is refused before anything changes.
          nodeRange = ">=99.0.0";
          const oldNode = yield* run(npm, ["upgrade"]);
          yield* evidence.json("node-too-old.json", oldNode);
          expect(oldNode.code).toBe(1);
          expect(oldNode.stderr).toContain(
            `Executor v2.999.0 requires Node.js >=99.0.0, and this is Node.js v${process.versions.node}.`,
          );
          expect(oldNode.stderr).toContain("Nothing was changed.");
          expect(yield* calls).toEqual([]);
          nodeRange = ">=24.14.0";

          // A package manager failure is reported with what it printed.
          const failedInstall = yield* run(npm, ["upgrade"], { FAKE_PM_MODE: "fail" });
          yield* evidence.json("install-failed.json", failedInstall);
          expect(failedInstall.code).toBe(1);
          expect(failedInstall.stderr).toContain(
            "npm exited with code 1 and did not install Executor v2.999.0.",
          );
          expect(failedInstall.stderr).toContain("503 Service Unavailable from the fake registry");
          expect(failedInstall.stdout).not.toContain("Upgraded");

          // An installed command that cannot start fails the upgrade.
          const broken = yield* run(npm, ["upgrade"], { FAKE_PM_MODE: "broken" });
          yield* evidence.json("verify-failed.json", broken);
          expect(broken.code).toBe(1);
          expect(broken.stderr).toContain(
            "npm installed Executor v2.999.0, but `executor --version` failed with code 1",
          );
          expect(broken.stderr).toContain("Executor's native runtime is missing.");
          expect(broken.stdout).not.toContain("Upgraded");
          yield* calls;

          // A downgrade needs an explicit version and confirmation; without a terminal, --yes.
          const downgrade = yield* run(npm, ["upgrade", "2.0.0-beta.1"]);
          expect(downgrade.code).toBe(1);
          expect(downgrade.stderr).toContain(
            "To downgrade, run: executor upgrade 2.0.0-beta.1 --yes. Nothing was changed.",
          );
          expect(yield* calls).toEqual([]);
          const confirmed = yield* run(npm, ["upgrade", "2.0.0-beta.1", "--yes"]);
          expect(confirmed.code, confirmed.stderr).toBe(0);
          expect(confirmed.stdout).toContain(
            `Upgraded Executor from v${version} to v2.0.0-beta.1.`,
          );
          expect(yield* calls).toEqual([
            { name: "npm", args: ["install", "-g", "executor@2.0.0-beta.1", "--include=optional"] },
          ]);

          // A running server from this installation still uses the old version until restarted.
          const port = yield* freePort;
          const registryForApps = yield* Config.NonEmptyString("E2E_NPM_REGISTRY").pipe(
            Config.option,
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* processes.spawn(
                ChildProcess.make(process.execPath, [npm, "serve"], {
                  cwd: root,
                  extendEnv: false,
                  env: {
                    ...environment({}),
                    PATH: process.env.PATH ?? "",
                    EXECUTOR_ENVIRONMENT: "e2e",
                    // Keys stay in keys.json so no run touches the machine's OS credential store.
                    EXECUTOR_KEY_STORAGE: "file",
                    EXECUTOR_WORKER_BUNDLE: path.resolve(".local/test-runtime/host.json"),
                    EXECUTOR_NO_UPDATE_CHECK: "1",
                    EXECUTOR_PORT: String(port),
                    ...(Option.isSome(registryForApps)
                      ? { EXECUTOR_NPM_REGISTRY: registryForApps.value }
                      : {}),
                  },
                  stdout: "pipe",
                  stderr: "pipe",
                  forceKillAfter: "3 seconds",
                }),
              );
              const ready = yield* Deferred.make<void>();
              yield* Stream.merge(server.stdout, server.stderr).pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runForEach((line) =>
                  line === `Executor: http://127.0.0.1:${port}`
                    ? Deferred.succeed(ready, undefined)
                    : Effect.void,
                ),
                Effect.forkScoped,
              );
              yield* Effect.raceFirst(
                Deferred.await(ready),
                server.exitCode.pipe(
                  Effect.flatMap((code) =>
                    Effect.fail(new Error(`executor serve exited before readiness (${code})`)),
                  ),
                ),
              ).pipe(Effect.timeout("90 seconds"));

              const running = yield* run(npm, ["upgrade"]);
              yield* evidence.json("running-server.json", running);
              expect(running.code, running.stderr).toBe(0);
              expect(running.stdout).toContain(upgraded);
              expect(running.stdout).toContain(
                `The Executor server at http://127.0.0.1:${port} (process ${server.pid}) is still running v${version}. Stop it, then start it again with \`executor serve\` to use v2.999.0.`,
              );
            }),
          );
          // Once the server has stopped, there is nothing to restart.
          const stopped = yield* run(npm, ["upgrade"]);
          expect(stopped.code, stopped.stderr).toBe(0);
          expect(stopped.stdout).not.toContain("still running");
          yield* calls;

          // Already current: the newest release on the channel is the installed one.
          published = { beta: version, latest: version };
          const current = yield* run(npm, ["upgrade"]);
          yield* evidence.json("already-current.json", current);
          expect(current.code, current.stderr).toBe(0);
          expect(current.stdout).toContain(
            `Executor v${version} is already the newest ${channel} release.`,
          );
          const same = yield* run(npm, ["upgrade", version]);
          expect(same.code, same.stderr).toBe(0);
          expect(same.stdout).toContain(`Executor v${version} is already installed.`);
          expect(yield* calls).toEqual([]);
        }),
      ),
    // Server readiness and every command have their own timeouts.
    { timeout: 240_000 },
  );
});
