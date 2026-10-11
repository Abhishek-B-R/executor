/**
 * `executor upgrade`: install a newer release with the package manager that installed this copy.
 * It runs only on request, checks Node before changing anything, confirms the new command works,
 * and says when a running server still uses the old version. It never restarts a server.
 */
import {
  compareReleaseVersions,
  releaseChannel,
  ReleaseVersion,
} from "@executor-js/utils/release-version";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  Console,
  Duration,
  Effect,
  Option,
  Path,
  Ref,
  Result,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { Prompt } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dataDirectoryConfig } from "../contracts/config.ts";
import { UpgradeFailed } from "../contracts/startup.ts";
import { runningServer } from "./server-record.ts";
import {
  currentRelease,
  fetchReleases,
  type GlobalInstaller,
  installMethod,
  isOneShot,
  newerRelease,
  npmRegistry,
} from "./update-notice.ts";

/** The process facts the entry point supplies. */
export interface UpgradeHost {
  /** The script Node started, whose location shows how the CLI was installed. */
  readonly entry: string | undefined;
  /** The running Node.js version, without the leading v. */
  readonly node: string;
  readonly platform: string;
}

export interface UpgradeOptions {
  readonly version: Option.Option<string>;
  readonly method: Option.Option<GlobalInstaller>;
  readonly yes: boolean;
}

/**
 * Each package manager's global install. npm can skip the optional dependency that carries the
 * native runtime, which leaves a launcher that cannot start, so it must be asked to include it.
 */
const installArgs = (method: GlobalInstaller, version: string): ReadonlyArray<string> => {
  const spec = `executor@${version}`;
  switch (method) {
    case "npm":
      return ["install", "-g", spec, "--include=optional"];
    case "pnpm":
      return ["add", "-g", spec];
    case "bun":
      return ["add", "-g", spec];
    case "yarn":
      return ["global", "add", spec];
  }
};
const installCommand = (method: GlobalInstaller, version: string) =>
  [method, ...installArgs(method, version)].join(" ");

const failed = (reason: UpgradeFailed["reason"], message: string) =>
  new UpgradeFailed({ reason, message });

const Release = Schema.Struct({
  version: Schema.String,
  engines: Schema.optional(Schema.Struct({ node: Schema.optional(Schema.String) })),
});

/** The release's published manifest, or undefined when the registry has no such version. */
const fetchRelease = (version: string) =>
  Effect.gen(function* () {
    const registry = yield* npmRegistry;
    return yield* HttpClient.get(`${registry}/executor/${version}`).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.succeed(undefined)
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap((ok) => ok.json),
              Effect.flatMap(Schema.decodeUnknownEffect(Release)),
            ),
      ),
      Effect.timeout(Duration.seconds(10)),
      // The body is read before the client's connections close with this layer.
      Effect.provide(NodeHttpClient.layerNodeHttp),
    );
  });

const numbers = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10));

/**
 * Whether `node` meets an engines range. Releases publish `>=major.minor.patch`; any other range
 * is reported as one this command cannot check rather than guessed at.
 */
const meetsNode = (node: string, range: string) => {
  const match = /^>=\s*v?(\d+(?:\.\d+){0,2})$/u.exec(range.trim());
  if (match === null) return undefined;
  const minimum = numbers(match[1] ?? "");
  const current = numbers(node);
  for (const [index, part] of minimum.entries()) {
    const have = current[index] ?? 0;
    if (have !== part) return have > part;
  }
  return true;
};

/** Run one command with its output streamed through; resolves to its exit code and stderr. */
const runStreaming = (command: string, args: ReadonlyArray<string>, platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const stdio = yield* Stdio.Stdio;
      const captured = yield* Ref.make("");
      const decoder = new TextDecoder();
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          // Windows package managers are .cmd scripts that only a shell starts.
          shell: platform === "win32",
          extendEnv: true,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "pipe",
        }),
      );
      const [code] = yield* Effect.all(
        [
          child.exitCode,
          child.stderr.pipe(
            Stream.tap((chunk) =>
              Ref.update(captured, (text) => text + decoder.decode(chunk, { stream: true })),
            ),
            Stream.run(stdio.stderr({ endOnDone: false })),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), stderr: yield* Ref.get(captured) };
    }),
  );

/** Start `executor --version` the way a shell would, through PATH. */
const installedVersion = (platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("executor", ["--version"], {
          shell: platform === "win32",
          extendEnv: true,
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [code, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout(Duration.seconds(60)));
      return { code: Number(code), stdout: stdout.trim(), stderr: stderr.trim() };
    }),
  );

const lastLines = (text: string, count: number) =>
  text.trimEnd().split("\n").slice(-count).join("\n");

/** Ask on a terminal. Without one, `whenNotInteractive` decides: proceed, or stop with its error. */
const confirm = (
  message: string,
  initial: boolean,
  yes: boolean,
  whenNotInteractive: UpgradeFailed | undefined,
) =>
  Effect.gen(function* () {
    if (yes) return;
    const stdio = yield* Stdio.Stdio;
    const interactive = (yield* stdio.stdinIsTerminal) && (yield* stdio.stdoutIsTerminal);
    if (!interactive) {
      if (whenNotInteractive !== undefined) return yield* whenNotInteractive;
      return;
    }
    const accepted = yield* Prompt.Confirm({ message, initial }).pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!accepted) return yield* failed("cancelled", "Upgrade cancelled. Nothing was changed.");
  });

export const upgrade = (options: UpgradeOptions, host: UpgradeHost) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const current = yield* currentRelease;
    const method = Option.isSome(options.method)
      ? options.method.value
      : yield* installMethod(host.entry);
    const given = Option.getOrUndefined(options.version);
    const requested =
      given === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(ReleaseVersion)(given.replace(/^v/u, "")).pipe(
            Effect.mapError(() =>
              failed(
                "invalid-version",
                `${given} is not an Executor release version, such as 2.0.0-beta.16. Nothing was changed.`,
              ),
            ),
          );

    // A one-shot runner fetches the release each run; there is no installed copy to replace.
    if (isOneShot(method)) {
      const spec = requested ?? (Option.isSome(current) ? releaseChannel(current.value) : "beta");
      yield* Console.log(
        `This Executor runs through ${method}, which fetches the release each time, so there is nothing to upgrade. Run the release with: ${method} executor@${spec}`,
      );
      return;
    }
    if (Option.isNone(current))
      return yield* failed(
        "development-build",
        "This is a development build of Executor without a release version, so it cannot upgrade itself. Install a release with: npm install -g executor@beta --include=optional",
      );

    const registry = yield* npmRegistry;
    const unavailable = (what: string) =>
      failed(
        "registry-unavailable",
        `Executor could not read ${what} from ${registry}. Check your connection or EXECUTOR_NPM_REGISTRY, then try again. Nothing was changed.`,
      );
    const target =
      requested ??
      newerRelease(
        current.value,
        yield* fetchReleases(Duration.seconds(10)).pipe(
          Effect.mapError(() => unavailable("the newest release")),
        ),
      );
    if (target === undefined) {
      yield* Console.log(
        `Executor v${current.value} is already the newest ${releaseChannel(current.value)} release.`,
      );
      return;
    }
    if (target === current.value) {
      yield* Console.log(`Executor v${current.value} is already installed.`);
      return;
    }

    const release = yield* fetchRelease(target).pipe(
      Effect.mapError(() => unavailable(`release v${target}`)),
    );
    if (release === undefined)
      return yield* failed(
        "unknown-release",
        `${registry} has no Executor release v${target}. Nothing was changed.`,
      );

    const range = release.engines?.node;
    if (range !== undefined) {
      const meets = meetsNode(host.node, range);
      if (meets === undefined)
        return yield* failed(
          "node-too-old",
          `Executor v${target} requires Node.js ${range}, which executor upgrade cannot check. Check that Node.js v${host.node} meets it, then install the release yourself. Nothing was changed.`,
        );
      if (!meets)
        return yield* failed(
          "node-too-old",
          `Executor v${target} requires Node.js ${range}, and this is Node.js v${host.node}. Upgrade Node.js, then run executor upgrade again. Nothing was changed.`,
        );
    }

    if (method === "unknown")
      return yield* failed(
        "unknown-install",
        [
          `Executor could not tell which package manager installed it${host.entry === undefined ? "" : ` (${path.dirname(host.entry)})`}, so it did not install anything.`,
          `Install v${target} with the one you used:`,
          ...(["npm", "pnpm", "bun", "yarn"] as const).map(
            (installer) => `  ${installCommand(installer, target)}`,
          ),
          "Or run: executor upgrade --method <npm|pnpm|bun|yarn>",
        ].join("\n"),
      );

    const command = installCommand(method, target);
    if (compareReleaseVersions(target, current.value) < 0)
      yield* confirm(
        `Downgrade Executor from v${current.value} to v${target} with ${method}?`,
        false,
        options.yes,
        failed(
          "downgrade-unconfirmed",
          `v${target} is older than the installed v${current.value}. To downgrade, run: executor upgrade ${target} --yes. Nothing was changed.`,
        ),
      );
    else
      yield* confirm(
        `Upgrade Executor from v${current.value} to v${target} with ${method}?`,
        true,
        options.yes,
        undefined,
      );

    yield* Console.log(`Upgrading Executor v${current.value} to v${target}: ${command}`);
    const installed = yield* runStreaming(method, installArgs(method, target), host.platform).pipe(
      Effect.mapError(() =>
        failed(
          "install-failed",
          `${method} could not be started. Check that it is installed and on your PATH, or choose another with --method. Nothing was changed.`,
        ),
      ),
    );
    if (installed.code !== 0)
      return yield* failed(
        "install-failed",
        [
          `${method} exited with code ${installed.code} and did not install Executor v${target}.`,
          ...(installed.stderr.trim() === ""
            ? []
            : [`${method} reported:`, lastLines(installed.stderr, 40)]),
          `Fix the problem it reports, then run executor upgrade again, or run: ${command}`,
        ].join("\n"),
      );

    const verify = (detail: string) =>
      failed(
        "verify-failed",
        `${method} installed Executor v${target}, but ${detail} Run \`${host.platform === "win32" ? "where.exe executor" : "type -a executor"}\` to see which executable your shell starts, or reinstall with: ${command}`,
      );
    const check = yield* installedVersion(host.platform).pipe(Effect.result);
    if (Result.isFailure(check)) return yield* verify("`executor --version` could not be started.");
    if (check.success.code !== 0)
      return yield* verify(
        `\`executor --version\` failed with code ${check.success.code}${check.success.stderr === "" ? "." : `:\n${lastLines(check.success.stderr, 20)}\n`}`,
      );
    if (check.success.stdout !== `executor v${target}`)
      return yield* verify(
        `\`executor --version\` printed "${check.success.stdout}". Another installation may come first on your PATH.`,
      );
    yield* Console.log(`Upgraded Executor from v${current.value} to v${target}.`);

    const server = yield* runningServer(path.resolve(yield* dataDirectoryConfig));
    if (server !== undefined && server.version !== target)
      yield* Console.log(
        `The Executor server at ${server.url} (process ${server.pid}) is still running ${server.version === undefined ? "a development build" : `v${server.version}`}. Stop it, then start it again with \`${server.command}\` to use v${target}.`,
      );
  });
