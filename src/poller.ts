import type { TimerHandle } from "../sdk/leo";
import type { CredentialKind, Handle, LeoV2 } from "./api";
import type { Clock } from "./clock";
import { parseClaude } from "./parse/claude";
import { parseCodex } from "./parse/codex";
import { BYPASS_INTERVAL_MS, FRESH_MS, MANUAL_FRESH_MS, mergeRefresh, type RefreshOptions } from "./refresh";
import { MAX_RETRY_MS, headerValue, isThrottle, parseRetryAfter, throttleDelayMs } from "./retry";
import { initialState, isDue, isFresh, reduce, type AccountState, type Outcome } from "./state";
import { loadPersisted, savePersisted, type Persisted, type StoredOutcome } from "./store";
import type { UsageWindow } from "./window";

export const CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
export const POLL_INTERVAL_SEC = 300;

interface Provider {
  url: string;
  parse(body: unknown): UsageWindow[];
}

const PROVIDERS: Record<CredentialKind, Provider> = {
  "claude-code": { url: CLAUDE_URL, parse: parseClaude },
  codex: { url: CODEX_URL, parse: parseCodex },
};

export interface Account {
  handle: Handle;
  /** The user's custom name, else the host's label. */
  label: string;
  state: AccountState;
}

export interface Poller {
  /** Reconcile with `credentials.list()` and restore persisted state. */
  sync(): Promise<void>;
  /** Refresh every due, stale account, one request at a time. Concurrent calls share one pass. */
  refresh(options?: RefreshOptions): Promise<void>;
  /** Local setup only, no network: register the 5-minute timer (once) and do the first sync. */
  init(): Promise<void>;
  /** init + the first refresh pass; polling continues every 5 minutes. */
  start(): Promise<void>;
  accounts(): readonly Account[];
  rename(id: string, label: string): Promise<void>;
}

/** The host label is the directory basename (".codex"); drop one leading dot for display. */
export const defaultLabel = (handle: Handle): string => (handle.label.startsWith(".") ? handle.label.slice(1) : handle.label);

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function fetchOutcome(leo: LeoV2, handle: Handle, nowMs: number): Promise<Outcome> {
  const provider = PROVIDERS[handle.kind];
  try {
    const res = await leo.fetch(provider.url, { credential: handle.id, headers: { Accept: "application/json" } });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 429) return { kind: "rateLimited", retryAfterMs: parseRetryAfter(headerValue(res.headers, "retry-after"), nowMs) };
    if (res.status !== 200) return { kind: "failed", message: "HTTP " + res.status };
    try {
      return { kind: "ok", windows: provider.parse(JSON.parse(res.body)) };
    } catch {
      return { kind: "failed", message: "Unreadable response" };
    }
  } catch (e) {
    const message = errorMessage(e);
    if (message.includes("credentialNeedsAuthorization")) return { kind: "needsAuthorization" };
    if (message.includes("credentialMachineUnavailable")) return { kind: "offline" };
    return isThrottle(message) ? { kind: "throttled", retryAfterMs: throttleDelayMs(message) } : { kind: "failed", message };
  }
}

export type { RefreshOptions };

const storedOutcome = (state: AccountState): StoredOutcome[] =>
  state.status === "stale" || state.status === "error" || state.status === "expired"
    ? [state.message === undefined ? { status: state.status } : { status: state.status, message: state.message }]
    : [];

/** Puts back what the account showed when it was last backed off. Values come from the snapshot, if any. */
const restoreOutcome = (state: AccountState, outcome: StoredOutcome | undefined): AccountState => {
  if (!outcome) return state;
  const message = outcome.message === undefined ? {} : { message: outcome.message };
  if (outcome.status === "expired") return { status: "expired", windows: [], nextAttemptAtMs: state.nextAttemptAtMs };
  return state.windows.length > 0 ? { ...state, ...message, status: "stale" } : { ...state, ...message, status: "error" };
};

export function createPoller(leo: LeoV2, clock: Clock, onChange: () => void): Poller {
  let entries: Array<{ handle: Handle; state: AccountState }> = [];
  let persisted: Persisted | null = null;
  let inFlight: Promise<void> | null = null;
  /** When each account last used its once-a-minute backoff bypass. */
  const lastBypassAt = new Map<string, number>();

  const backedOff = () => entries.filter((e) => e.state.nextAttemptAtMs !== undefined && e.state.nextAttemptAtMs > clock.now());

  const persist = async (): Promise<void> => {
    const base = persisted ?? (await loadPersisted(leo));
    persisted = {
      order: entries.map((e) => e.handle.id),
      labels: Object.fromEntries(Object.entries(base.labels).filter(([id]) => entries.some((e) => e.handle.id === id))),
      snapshots: Object.fromEntries(
        entries.flatMap((e) =>
          e.state.windows.length > 0 && e.state.updatedAtMs !== undefined
            ? [[e.handle.id, { windows: [...e.state.windows], updatedAtMs: e.state.updatedAtMs }] as const]
            : [],
        ),
      ),
      nextAttempts: Object.fromEntries(backedOff().map((e) => [e.handle.id, e.state.nextAttemptAtMs ?? 0] as const)),
      outcomes: Object.fromEntries(backedOff().flatMap((e) => storedOutcome(e.state).map((o) => [e.handle.id, o] as const))),
    };
    await savePersisted(leo, persisted);
  };

  const setState = (id: string, state: AccountState): void => {
    entries = entries.map((e) => (e.handle.id === id ? { ...e, state } : e));
    onChange();
  };

  const restore = (handle: Handle, saved: Persisted): AccountState => {
    const snap = saved.snapshots[handle.id];
    const saidAt = saved.nextAttempts[handle.id];
    const base: AccountState = snap ? { status: "ok", windows: snap.windows, updatedAtMs: snap.updatedAtMs } : initialState();
    if (saidAt === undefined || saidAt <= clock.now()) return base; // a backoff that already ended restores nothing
    // A time saved under a skewed clock must not park the account for longer than any real backoff.
    const nextAttemptAtMs = Math.min(saidAt, clock.now() + MAX_RETRY_MS);
    return restoreOutcome({ ...base, nextAttemptAtMs }, saved.outcomes[handle.id]);
  };

  const sync = async (): Promise<void> => {
    persisted = persisted ?? (await loadPersisted(leo));
    const saved = persisted;
    const handles = await leo.credentials.list();
    const rank = (h: Handle): number => {
      const i = saved.order.indexOf(h.id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const ordered = handles.map((h, i) => ({ h, i })).sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i).map((x) => x.h);
    entries = ordered.map((handle) => ({
      handle,
      state: entries.find((e) => e.handle.id === handle.id)?.state ?? restore(handle, saved),
    }));
    if (JSON.stringify(entries.map((e) => e.handle.id)) !== JSON.stringify(saved.order)) await persist();
    onChange();
  };

  /** True when `id` may skip its backoff now; spends its once-a-minute allowance. */
  const claimBypass = (id: string, options: RefreshOptions): boolean => {
    if (!options.bypassBackoff?.includes(id)) return false;
    const last = lastBypassAt.get(id);
    if (last !== undefined && clock.now() - last < BYPASS_INTERVAL_MS) return false;
    lastBypassAt.set(id, clock.now());
    return true;
  };

  const shouldFetch = (state: AccountState, id: string, options: RefreshOptions): boolean =>
    claimBypass(id, options) || (isDue(state, clock.now()) && !isFresh(state, clock.now(), options.manual ? MANUAL_FRESH_MS : FRESH_MS));

  const pass = async (options: RefreshOptions): Promise<void> => {
    for (const { handle } of [...entries]) {
      const current = entries.find((e) => e.handle.id === handle.id);
      if (!current || (options.ids && !options.ids.includes(handle.id)) || !shouldFetch(current.state, handle.id, options)) continue;
      const outcome = await fetchOutcome(leo, handle, clock.now());
      if (entries.some((e) => e.handle.id === handle.id)) {
        setState(handle.id, reduce(entries.find((e) => e.handle.id === handle.id)?.state ?? initialState(), outcome, clock.now()));
      }
    }
    await persist();
  };

  /** Requests that arrived during a pass; they collapse into one follow-up covering all of them. */
  let queued: RefreshOptions | null = null;

  const run = async (first: RefreshOptions): Promise<void> => {
    await pass(first);
    while (queued !== null) {
      const next = queued;
      queued = null;
      await pass(next);
    }
  };

  const refresh = (options: RefreshOptions = {}): Promise<void> => {
    if (inFlight) {
      queued = queued === null ? options : mergeRefresh(queued, options);
      return inFlight;
    }
    inFlight = run(options).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  let timer: TimerHandle | null = null;

  const init = async (): Promise<void> => {
    // The timer goes first and only once, so a failed first sync (or a retried init) still ends up polling.
    timer ??= leo.timer(POLL_INTERVAL_SEC, async () => {
      try {
        await sync();
        await refresh();
      } catch (e) {
        leo.log("error", "poll failed: " + errorMessage(e));
      }
    });
    await sync();
  };

  return {
    sync,
    refresh,
    init,
    start: async () => {
      await init();
      await refresh();
    },
    accounts: () =>
      entries.map((e) => ({ handle: e.handle, label: persisted?.labels[e.handle.id] ?? defaultLabel(e.handle), state: e.state })),
    rename: async (id, label) => {
      const base = persisted ?? (await loadPersisted(leo));
      const trimmed = label.trim();
      const { [id]: _dropped, ...rest } = base.labels;
      persisted = { ...base, labels: trimmed === "" ? rest : { ...rest, [id]: trimmed } };
      await savePersisted(leo, persisted);
      onChange();
    },
  };
}
