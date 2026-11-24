const SEC = 1_000;
const MIN = 60 * SEC;

/** A 429's Retry-After is never trusted below this, nor above `MAX_RETRY_MS`. */
export const MIN_RETRY_MS = MIN;
export const MAX_RETRY_MS = 60 * MIN;
/** First wait after a 429 with no usable Retry-After; doubles on each consecutive 429. */
export const DEFAULT_RATE_LIMIT_MS = 5 * MIN;
/** Wait after a 401 or any other failure, so a trigger storm cannot retry it. */
export const FAILURE_BACKOFF_MS = 5 * MIN;
/** Wait after the host's own limiter refuses a request without saying for how long. */
export const THROTTLE_DEFAULT_MS = MIN;

/** Case-insensitive header lookup. */
export const headerValue = (headers: Readonly<Record<string, string>>, name: string): string | undefined =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];

/** A Retry-After header as milliseconds from `nowMs`: delta-seconds or an HTTP-date. Undefined when unusable. */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  const text = value?.trim() ?? "";
  if (/^\d+$/.test(text)) return Number(text) * SEC;
  if (!/[A-Za-z]/.test(text)) return undefined; // Date.parse is lenient about bare numbers and signs
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

const clamp = (ms: number, min: number, max: number): number => Math.min(max, Math.max(min, ms));

/** The wait after the `streak`-th consecutive 429. Retry-After wins when present; otherwise 5 min, doubling. */
export const rateLimitDelayMs = (retryAfterMs: number | undefined, streak: number): number =>
  retryAfterMs !== undefined
    ? clamp(retryAfterMs, MIN_RETRY_MS, MAX_RETRY_MS)
    : Math.min(MAX_RETRY_MS, DEFAULT_RATE_LIMIT_MS * 2 ** Math.max(0, streak - 1));

/** The host limiter rejects with "rate limited: retry in N s". */
export const isThrottle = (message: string): boolean => /rate limited/i.test(message);

export const throttleDelayMs = (message: string): number => {
  const seconds = /retry in (\d+)\s*s/i.exec(message)?.[1];
  return seconds === undefined ? THROTTLE_DEFAULT_MS : Math.min(MAX_RETRY_MS, Number(seconds) * SEC);
};
