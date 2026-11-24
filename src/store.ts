import type { LeoV2 } from "./api";
import { finiteNumber, isRecord, type UsageWindow } from "./window";

/** Last good reading of one account. */
export interface Snapshot {
  windows: UsageWindow[];
  updatedAtMs: number;
}

/** Everything the plugin persists. Never tokens: the host keeps those. */
export interface Persisted {
  order: string[];
  labels: Record<string, string>;
  snapshots: Record<string, Snapshot>;
  /** Epoch ms before which an account is left alone. Absent in state saved by v0.1.0. */
  nextAttempts: Record<string, number>;
  /** What a backed-off account last showed, so a restart doesn't turn it into ok/Loading. Absent before 0.1.1. */
  outcomes: Record<string, StoredOutcome>;
}

export type StoredStatus = "stale" | "error" | "expired";

export interface StoredOutcome {
  status: StoredStatus;
  message?: string;
}

export const STATE_KEY = "state";
/** The host caps a secret value at 16 KB; stay under it with room for multi-byte labels. */
export const MAX_STATE_CHARS = 15_000;
const MAX_LABEL_CHARS = 60;
const MAX_MESSAGE_CHARS = 80;
const STORED_STATUSES: ReadonlySet<string> = new Set<StoredStatus>(["stale", "error", "expired"]);

export const emptyPersisted = (): Persisted => ({ order: [], labels: {}, snapshots: {}, nextAttempts: {}, outcomes: {} });

const WINDOW_KEYS: ReadonlySet<string> = new Set(["session", "weekly", "weekly-opus", "weekly-sonnet"]);

const readWindow = (v: unknown): UsageWindow[] => {
  if (!isRecord(v) || typeof v.key !== "string" || !WINDOW_KEYS.has(v.key) || typeof v.label !== "string") return [];
  const percent = finiteNumber(v.percent);
  if (percent === undefined) return [];
  const resetsAtMs = finiteNumber(v.resetsAtMs);
  const base = { key: v.key as UsageWindow["key"], label: v.label, percent };
  return [resetsAtMs === undefined ? base : { ...base, resetsAtMs }];
};

const readOutcome = (v: unknown): StoredOutcome[] => {
  if (!isRecord(v) || typeof v.status !== "string" || !STORED_STATUSES.has(v.status)) return [];
  const status = v.status as StoredStatus;
  return [typeof v.message === "string" ? { status, message: v.message.slice(0, MAX_MESSAGE_CHARS) } : { status }];
};

const readSnapshot = (v: unknown): Snapshot[] => {
  if (!isRecord(v) || !Array.isArray(v.windows)) return [];
  const updatedAtMs = finiteNumber(v.updatedAtMs);
  return updatedAtMs === undefined ? [] : [{ windows: v.windows.flatMap(readWindow), updatedAtMs }];
};

/** Keeps only well-formed entries; the stored value may come from an older or damaged version. */
export function sanitize(raw: unknown): Persisted {
  if (!isRecord(raw)) return emptyPersisted();
  const order = Array.isArray(raw.order) ? raw.order.filter((id): id is string => typeof id === "string") : [];
  const labels = isRecord(raw.labels)
    ? Object.fromEntries(
        Object.entries(raw.labels)
          .filter((e): e is [string, string] => typeof e[1] === "string")
          .map(([id, label]) => [id, label.slice(0, MAX_LABEL_CHARS)]),
      )
    : {};
  const snapshots = isRecord(raw.snapshots)
    ? Object.fromEntries(Object.entries(raw.snapshots).flatMap(([id, s]) => readSnapshot(s).map((snap) => [id, snap] as const)))
    : {};
  const nextAttempts = isRecord(raw.nextAttempts)
    ? Object.fromEntries(Object.entries(raw.nextAttempts).flatMap(([id, at]) => (finiteNumber(at) === undefined ? [] : [[id, Number(at)] as const])))
    : {};
  const outcomes = isRecord(raw.outcomes)
    ? Object.fromEntries(Object.entries(raw.outcomes).flatMap(([id, o]) => readOutcome(o).map((out) => [id, out] as const)))
    : {};
  return { order, labels, snapshots, nextAttempts, outcomes };
}

export async function loadPersisted(leo: Pick<LeoV2, "secrets">): Promise<Persisted> {
  const raw = await leo.secrets.get(STATE_KEY);
  if (raw === null) return emptyPersisted();
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return emptyPersisted();
  }
}

/**
 * Drops the oldest snapshots, then the outcomes, until the JSON fits.
 * Order, labels and retry times always survive: they are what keeps requests from bursting.
 */
export function fit(state: Persisted): Persisted {
  const byAge = Object.entries(state.snapshots).sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
  const trimmed = (dropped: number, outcomes: Persisted["outcomes"]): Persisted => ({
    ...state,
    outcomes,
    snapshots: Object.fromEntries(byAge.slice(dropped)),
  });
  const fits = (candidate: Persisted): boolean => JSON.stringify(candidate).length <= MAX_STATE_CHARS;
  for (let dropped = 0; dropped <= byAge.length; dropped += 1) {
    const candidate = trimmed(dropped, state.outcomes);
    if (fits(candidate)) return candidate;
  }
  const bare = trimmed(byAge.length, {});
  const kept = Object.entries(state.outcomes);
  for (let count = kept.length - 1; count > 0; count -= 1) {
    const candidate = { ...bare, outcomes: Object.fromEntries(kept.slice(0, count)) };
    if (fits(candidate)) return candidate;
  }
  return bare;
}

export async function savePersisted(leo: Pick<LeoV2, "secrets">, state: Persisted): Promise<void> {
  await leo.secrets.set(STATE_KEY, JSON.stringify(fit(sanitize(state))));
}
