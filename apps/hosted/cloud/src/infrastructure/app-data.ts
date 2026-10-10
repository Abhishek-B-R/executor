/** Native Alchemy resource; product authorization remains on the calling Worker. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { Effect } from "effect";
import type { makeFacetSupervisor } from "@executor-js/app-data/cloudflare";
import { AppData } from "./app-data-worker.ts";

type FacetSupervisor = Effect.Success<ReturnType<typeof makeFacetSupervisor>>;
type Supervisor = Pick<FacetSupervisor, "invoke" | "cancel" | "evaluated"> & {
  /**
   * A cache command. `trace` is the caller's trace ID, compared with the call that woke the
   * supervisor; the reply also says how the supervisor ran.
   */
  readonly cache: (
    namespace: string,
    command: unknown,
    trace?: string,
  ) => Effect.Effect<unknown, Effect.Error<ReturnType<FacetSupervisor["observedCache"]>>>;
};
/**
 * One supervisor name is one immutable configured-app ID, across deployments. The namespace, with
 * every app's data, moved here from the API Worker.
 */
export class AppDataSupervisor extends Cloudflare.DurableObject<AppDataSupervisor, Supervisor>()(
  "AppDataSupervisor",
  { transferredFrom: "Api" },
) {}

/** Every other Worker binds the namespace across scripts. */
export const appDataSupervisors = AppDataSupervisor.from(AppData);
