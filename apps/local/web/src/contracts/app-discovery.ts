/**
 * An app page discovers its tools, skills, workflows, schedules and webhooks with the app's linked
 * accounts, in one cache per app and version. Linking, unlinking or connecting an account reads
 * it again; the page's normal refresh covers the rest.
 */
import type { AppId, VersionId } from "@executor-js/sdk";
import type { Atom } from "effect/reactivity";
import { toolsAtom } from "./api.ts";
import { refreshSkillDiscovery } from "./app-browser.ts";
import { refreshResourceDiscovery } from "./resources.ts";
import { refreshScheduleDiscovery } from "./schedules.ts";

/** The app and version whose discovery a page shows. */
export interface DiscoveryTarget {
  readonly app: AppId;
  readonly version: VersionId | null;
}

export const refreshAppDiscovery = (get: Atom.FnContext, target: DiscoveryTarget) => {
  get.refresh(toolsAtom({ app: target.app, version: target.version }));
  refreshSkillDiscovery(get, target);
  refreshResourceDiscovery(get, {
    app: target.app,
    version: target.version ?? undefined,
  });
  refreshScheduleDiscovery(get, target.app);
};
