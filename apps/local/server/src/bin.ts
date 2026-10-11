#!/usr/bin/env node
import {
  appsCommand,
  describeAppFailure,
  encodeAppFailure,
  renderAppFailure,
} from "@executor-js/app-management/cli";
/** CLI composition root. Platform dependencies and raw process arguments stop here. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { fileURLToPath } from "node:url";
import { Console, Effect, Option, Schema } from "effect";
import { CliError, Command } from "effect/cli";
import {
  LegacyCommand,
  PairFailed,
  executorCommand,
  legacyCommands,
  pairCommand,
  rotateKeyCommand,
  serveCommand,
} from "./contracts/startup.ts";
import { LocalConfigurationError, rotateApiKey } from "./implementation/bootstrap.ts";
import { launch } from "./implementation/launcher.ts";
import { outdatedCli } from "./implementation/update-notice.ts";
import { pair } from "./implementation/pair.ts";

// The installed runtime's own path shows which package manager installed it.
const installation = fileURLToPath(import.meta.url);
/** Failures whose message is written for the person running the command. */
const explained = Schema.is(Schema.Union([LocalConfigurationError, PairFailed, LegacyCommand]));

const cli = executorCommand.pipe(
  Command.withHandler(({ bootstrapFd }) =>
    launch(Option.isSome(bootstrapFd) ? "desktop" : "browser", process.platform, installation),
  ),
  Command.withSubcommands([
    appsCommand(process.platform),
    serveCommand.pipe(
      Command.withHandler(() => launch("headless", process.platform, installation)),
    ),
    pairCommand.pipe(Command.withHandler(() => pair(process.platform))),
    rotateKeyCommand.pipe(
      Command.withHandler(() =>
        rotateApiKey(process.platform).pipe(
          Effect.andThen(
            Console.log(
              "Rotated the local API key. Restart Executor to use it, then update clients that used the previous key.",
            ),
          ),
        ),
      ),
    ),
    ...legacyCommands.map((legacy) =>
      legacy.pipe(
        Command.withHandler(() => Effect.fail(new LegacyCommand({ command: legacy.name }))),
      ),
    ),
  ]),
);

NodeRuntime.runMain(
  Command.run(cli, { version: process.env.EXECUTOR_BUILD_VERSION ?? "0.0.0-dev" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    // Effect CLI renders argument errors and supplies the exit status for help.
    // Operational failures retain the launcher's sanitized message. An apps command failure
    // states the host's code, status, message and recovery, and also prints them as JSON on
    // stdout when a program, not a terminal, reads it.
    Effect.catch((error) => {
      if (CliError.isCliError(error)) return Effect.fail(error);
      const described = explained(error) ? undefined : describeAppFailure(error);
      return Effect.gen(function* () {
        // A failed apps command also says when this CLI is out of date.
        const update = described === undefined ? undefined : yield* outdatedCli(installation);
        const failure =
          described === undefined || update === undefined ? described : { ...described, update };
        yield* Console.error(
          explained(error)
            ? error.message
            : failure === undefined
              ? "Executor could not start. Check the configured keys and whether the port is already in use."
              : renderAppFailure(failure),
        );
        if (failure !== undefined && !process.stdout.isTTY)
          yield* Console.log(encodeAppFailure(failure));
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      });
    }),
  ),
);
