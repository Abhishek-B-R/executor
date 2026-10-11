/**
 * One process's copy of a catalog source. Every request the process serves reads it, so the feed
 * is fetched and decoded once per refresh instead of on every read, and a burst of reads shares
 * one fetch.
 *
 * Requests of one Workers isolate can share this copy: they read settled plain values, and a
 * reader that waits for another request's fetch waits on a native promise, which resumes it in its
 * own request. An Effect `Deferred` would resume it inside the fetching request instead.
 */
import { Clock, Effect, Exit, Option } from "effect";
import { getDomain } from "tldts";
import {
  CatalogUnavailable,
  catalogFreshness,
  type CatalogBackground,
  type CatalogEntry,
  type CatalogIcons,
  type CatalogSource,
  type KeptCatalog,
  type KeptCatalogSnapshot,
} from "../contracts/catalog.ts";
import { applyCatalogOverride } from "./overrides.ts";

interface Snapshot extends KeptCatalogSnapshot {
  /** When the fetch that produced it finished. */
  readonly at: number;
}

/** A fetch in progress. It settles with its exit, or with none when it was interrupted. */
interface Fetch {
  /** Registration order; a fetch's result only replaces the result of an earlier one. */
  readonly order: number;
  readonly started: number;
  readonly settled: Promise<Option.Option<Exit.Exit<Snapshot, CatalogUnavailable>>>;
}

/** Exact catalog names supply logo domains; a name listed with two domains never guesses one. */
export const catalogIcons = (entries: readonly CatalogEntry[]): CatalogIcons => {
  const domains = new Map<string, string | null>();
  for (const entry of entries) {
    const name = entry.name.trim().toLowerCase();
    const domain = getDomain(entry.domain);
    if (domain === null) continue;
    domains.set(name, domains.has(name) && domains.get(name) !== domain ? null : domain);
  }
  const icons: [string, string][] = [];
  for (const [name, domain] of domains) if (domain !== null) icons.push([name, domain]);
  return icons;
};

/**
 * Keep `source` with `catalogFreshness`. Construction performs no I/O. Create one per process (or
 * Workers isolate) and share it; each request supplies how it may run a refresh in the background.
 */
export const keepCatalog = (source: CatalogSource): KeptCatalog => {
  let kept: Snapshot | undefined;
  let current: Fetch | undefined;
  let registered = 0;
  // The newest registered fetch whose result was recorded: kept snapshot or failure.
  let recorded = 0;
  let failedAt = Number.NEGATIVE_INFINITY;

  const snapshot = source.list.pipe(
    Effect.flatMap((listed) =>
      Effect.map(Clock.currentTimeMillis, (at): Snapshot => {
        const entries = listed.map(applyCatalogOverride);
        return { entries, icons: catalogIcons(entries), at };
      }),
    ),
    Effect.withSpan("catalog.fetch"),
  );

  /** The registered fetch, unless it has run so long that it no longer holds back others. */
  const pending = (now: number) =>
    current !== undefined && now - current.started < catalogFreshness.loadMillis
      ? current
      : undefined;

  /**
   * Join the pending fetch, or register a new one and hand it over: to the host's background work
   * when given, otherwise run it in this fiber. The check and the registration run synchronously
   * together, so two readers cannot both register; the registration and the handover both happen
   * while uninterruptible, so an interrupted reader cannot leave a registration nothing settles.
   */
  const join = (now: number, background: CatalogBackground | undefined) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const joined = pending(now);
        if (joined !== undefined) return Effect.succeed(joined);
        let settle: (result: Option.Option<Exit.Exit<Snapshot, CatalogUnavailable>>) => void = () =>
          undefined;
        const fetch: Fetch = {
          order: (registered += 1),
          started: now,
          settled: new Promise((resolve) => {
            settle = resolve;
          }),
        };
        current = fetch;
        // Settling updates every field without yielding, so no reader sees the fetch gone but its
        // result unrecorded. A fetch that overran `loadMillis` can finish after a later one; only a
        // result newer than the recorded one replaces it.
        const finish = (exit: Exit.Exit<Snapshot, CatalogUnavailable>) =>
          Effect.map(Clock.currentTimeMillis, (settledAt) => {
            if (current === fetch) current = undefined;
            if (!Exit.hasInterrupts(exit) && fetch.order > recorded) {
              recorded = fetch.order;
              if (Exit.isSuccess(exit)) kept = exit.value;
              else failedAt = settledAt;
            }
            settle(Exit.hasInterrupts(exit) ? Option.none() : Option.some(exit));
          });
        return Effect.gen(function* () {
          if (background === undefined)
            yield* restore(snapshot).pipe(Effect.onExit(finish), Effect.ignore);
          else if (!(yield* background(snapshot.pipe(Effect.onExit(finish), Effect.ignore))))
            yield* finish(Exit.interrupt());
          return fetch;
        });
      }),
    );

  /** Join the registered fetch or start one, and wait for it in this fiber. */
  const fetched = (
    background: CatalogBackground | undefined,
  ): Effect.Effect<Snapshot, CatalogUnavailable> =>
    Effect.gen(function* () {
      const fetch = yield* join(yield* Clock.currentTimeMillis, background);
      const settled = yield* Effect.promise(() => fetch.settled).pipe(
        Effect.timeoutOption(catalogFreshness.loadMillis),
      );
      if (Option.isNone(settled)) return yield* new CatalogUnavailable();
      // The fetch's reader was interrupted before it finished; this reader fetches instead.
      if (Option.isNone(settled.value)) return yield* fetched(background);
      const exit = settled.value.value;
      return Exit.isSuccess(exit) ? exit.value : yield* Effect.failCause(exit.cause);
    });

  return {
    read: (background) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const copy = kept;
        if (copy === undefined || now - copy.at >= catalogFreshness.maxStaleMillis) {
          yield* Effect.annotateCurrentSpan("catalog.cache", "miss");
          return yield* fetched(background);
        }
        const age = now - copy.at;
        yield* Effect.annotateCurrentSpan("catalog.cache.age_ms", age);
        if (age < catalogFreshness.freshMillis || now - failedAt < catalogFreshness.retryMillis) {
          yield* Effect.annotateCurrentSpan("catalog.cache", "hit");
          return copy;
        }
        yield* Effect.annotateCurrentSpan("catalog.cache", "stale");
        // Without background work this read refreshes, keeping the copy if the feed fails.
        if (background === undefined)
          return yield* fetched(undefined).pipe(Effect.orElseSucceed(() => copy));
        yield* join(now, background);
        return copy;
      }),
  };
};
