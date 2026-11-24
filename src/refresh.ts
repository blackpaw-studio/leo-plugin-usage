/** What a refresh pass may fetch. The default is a timer-style pass: due and stale accounts only. */
export interface RefreshOptions {
  /** Only these accounts. Omitted: all. */
  ids?: readonly string[];
  /** The user asked: accept data older than a minute instead of older than four. */
  manual?: boolean;
  /** Accounts allowed to skip their backoff, each at most once per `BYPASS_INTERVAL_MS`. */
  bypassBackoff?: readonly string[];
}

/** A successful fetch younger than this is not fetched again by a timer or launch pass. */
export const FRESH_MS = 4 * 60_000;
/** Same, for a user-requested refresh. */
export const MANUAL_FRESH_MS = 60_000;
/** An account's backoff can be bypassed at most this often. */
export const BYPASS_INTERVAL_MS = 60_000;

const union = (a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | undefined =>
  a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined;

/** Folds requests that arrived during a pass into one follow-up; it covers everything either asked for. */
export const mergeRefresh = (a: RefreshOptions, b: RefreshOptions): RefreshOptions => {
  const ids = a.ids && b.ids ? union(a.ids, b.ids) : undefined;
  const bypassBackoff = union(a.bypassBackoff, b.bypassBackoff);
  return {
    ...(ids ? { ids } : {}),
    ...(a.manual || b.manual ? { manual: true } : {}),
    ...(bypassBackoff ? { bypassBackoff } : {}),
  };
};
