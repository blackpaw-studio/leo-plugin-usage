import { FAILURE_BACKOFF_MS, rateLimitDelayMs } from "./retry";
import type { UsageWindow } from "./window";

export type AccountStatus = "loading" | "ok" | "stale" | "expired" | "needsAuthorization" | "error";

export interface AccountState {
  status: AccountStatus;
  /** Last good windows. Empty while loading, expired, locked or when the provider reported none. */
  windows: readonly UsageWindow[];
  /** Epoch ms of the last good fetch. */
  updatedAtMs?: number;
  /** Failure reason for stale/error states. */
  message?: string;
  /** Epoch ms before which the poller leaves this account alone (after a 429 or another failure). */
  nextAttemptAtMs?: number;
  /** Consecutive 429s, for the doubling default wait. */
  rateLimitStreak?: number;
}

export type Outcome =
  | { kind: "ok"; windows: readonly UsageWindow[] }
  | { kind: "unauthorized" }
  | { kind: "needsAuthorization" }
  | { kind: "rateLimited"; retryAfterMs?: number }
  | { kind: "throttled"; retryAfterMs: number }
  | { kind: "failed"; message: string };

export const RATE_LIMITED = "Rate limited";
export const NO_DATA = "No usage data";

export const initialState = (): AccountState => ({ status: "loading", windows: [] });

/** A failure keeps the last good values (stale) or, with none, becomes an error. */
const degrade = (state: AccountState, message: string, extra: Partial<AccountState> = {}): AccountState =>
  state.windows.length > 0
    ? { ...state, ...extra, status: "stale", message }
    : { windows: [], ...extra, status: "error", message };

export function reduce(state: AccountState, outcome: Outcome, nowMs: number): AccountState {
  const { nextAttemptAtMs: _wait, rateLimitStreak, ...settled } = state;
  const failure = { nextAttemptAtMs: nowMs + FAILURE_BACKOFF_MS };
  switch (outcome.kind) {
    case "ok":
      return outcome.windows.length === 0
        ? { status: "error", windows: [], message: NO_DATA, ...failure }
        : { status: "ok", windows: outcome.windows, updatedAtMs: nowMs };
    case "unauthorized":
      return { status: "expired", windows: [], ...failure };
    case "needsAuthorization":
      return { status: "needsAuthorization", windows: [] };
    case "rateLimited": {
      const streak = (rateLimitStreak ?? 0) + 1;
      const wait = rateLimitDelayMs(outcome.retryAfterMs, streak);
      return degrade(settled, RATE_LIMITED, { nextAttemptAtMs: nowMs + wait, rateLimitStreak: streak });
    }
    case "throttled":
      return degrade(settled, RATE_LIMITED, { nextAttemptAtMs: nowMs + outcome.retryAfterMs });
    case "failed":
      return degrade(settled, outcome.message, failure);
  }
}

export const isDue = (state: AccountState, nowMs: number): boolean =>
  state.nextAttemptAtMs === undefined || nowMs >= state.nextAttemptAtMs;

export const isFresh = (state: AccountState, nowMs: number, maxAgeMs: number): boolean =>
  state.updatedAtMs !== undefined && nowMs - state.updatedAtMs < maxAgeMs;
