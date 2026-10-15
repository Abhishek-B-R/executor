/**
 * One-off data step: pin every existing app to an explicit `apps` framework by declaring it in
 * the app's working source. It never redeploys; the next deploy resolves the declared release.
 */
import { Schema } from "effect";

/**
 * The release `1_app_framework_pin` declares: the protocol-1 framework hosts ran before routers.
 * All existing source is written for it; earlier hosts built undeclared source with it. The step
 * has shipped, so this never changes.
 */
export const frameworkPinRelease = "0.0.1-beta.2";

/**
 * The release `2_app_framework_pin_catch_up` declares: the last framework before routers. Apps
 * created without a declaration after the first pin were built by hosts shipping beta.2 through
 * beta.5, which share the `queries`/`mutations` authoring API, so the latest one covers them all.
 */
export const frameworkPinCatchUpRelease = "0.0.1-beta.5";

/**
 * Where the working branch (`main`) stands against the running version decides which files
 * carry the pin. Every position is pinned on top of `main`:
 * - `current`: main holds the running source.
 * - `behind`: main holds exactly the source of an earlier version that the running one
 *   replaced, as a direct file deploy leaves it. The pin commit saves the running source with the
 *   pin, so the next deploy from main keeps what runs today.
 * - `unpublished`: main has moved on from the running source, which is in its recent history.
 * - `diverged`: main and the running source each have changes the other lacks, or the running
 *   source is outside main's recent history.
 * - `undeployed`: nothing runs yet.
 *
 * Report mode names the pin it would make (`pin`, `pin-behind`, ...); apply mode names the pin it
 * committed (`pinned`, `pinned-behind`, ...). Other outcomes:
 * - `declared`: the working source (or, when behind, the running source) declares `dependencies.apps`.
 * - `invalid-manifest`: `package.json` is not a JSON object with object `dependencies`.
 * - `conflict`: the working source changed while this app was being pinned. Retried.
 * - `failed`: storage or Git failed for this app; other apps continue. Retried.
 * - `removed`: the app was deleted before it could be handled.
 */
export const FrameworkPinOutcome = Schema.Literals([
  "pin",
  "pin-behind",
  "pin-unpublished",
  "pin-diverged",
  "pin-undeployed",
  "pinned",
  "pinned-behind",
  "pinned-unpublished",
  "pinned-diverged",
  "pinned-undeployed",
  "declared",
  "invalid-manifest",
  "conflict",
  "failed",
  "removed",
]);
export type FrameworkPinOutcome = typeof FrameworkPinOutcome.Type;

/** The commit message identifies the system edit in the app's Git history. */
export const frameworkPinMessage = (apps: string) =>
  `Pin the apps framework to ${apps}\n\nExecutor declared the framework release this app was built with, so host upgrades do not change it.`;

/** A behind workspace also receives the running source, which the message records. */
export const frameworkPinBehindMessage = (apps: string) =>
  `Pin the apps framework to ${apps}\n\nExecutor saved the source of the running version, which this branch did not have yet, and declared the framework release it was built with, so host upgrades do not change it.`;
