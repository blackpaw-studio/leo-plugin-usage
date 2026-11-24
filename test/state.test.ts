import { describe, expect, it } from "vitest";
import { FAILURE_BACKOFF_MS } from "../src/retry";
import { OFFLINE, initialState, isDue, reduce } from "../src/state";
import type { UsageWindow } from "../src/window";

const NOW = 1_000_000;
const w: UsageWindow[] = [{ key: "session", label: "Session", percent: 40 }];

describe("account state reducer", () => {
  it("starts loading with no data", () => {
    expect(initialState()).toMatchObject({ status: "loading", windows: [] });
  });

  it("ok replaces windows and stamps the update time", () => {
    const s = reduce(initialState(), { kind: "ok", windows: w }, NOW);
    expect(s).toMatchObject({ status: "ok", windows: w, updatedAtMs: NOW });
  });

  it("an ok response without windows reads as no usage data", () => {
    const s = reduce(initialState(), { kind: "ok", windows: [] }, NOW);
    expect(s).toMatchObject({ status: "error", message: "No usage data", windows: [] });
  });

  it("a failure after a good fetch goes stale and keeps the last values", () => {
    const good = reduce(initialState(), { kind: "ok", windows: w }, NOW);
    const s = reduce(good, { kind: "failed", message: "HTTP 500" }, NOW + 5);
    expect(s).toMatchObject({ status: "stale", windows: w, updatedAtMs: NOW, message: "HTTP 500" });
  });

  it("a failure with nothing to show is an error", () => {
    expect(reduce(initialState(), { kind: "failed", message: "HTTP 500" }, NOW)).toMatchObject({
      status: "error",
      message: "HTTP 500",
    });
  });

  it("401 is expired and drops values", () => {
    const good = reduce(initialState(), { kind: "ok", windows: w }, NOW);
    expect(reduce(good, { kind: "unauthorized" }, NOW)).toMatchObject({ status: "expired", windows: [] });
  });

  it("an offline machine goes stale with values, backing off like other failures", () => {
    const good = reduce(initialState(), { kind: "ok", windows: w }, NOW);
    expect(reduce(good, { kind: "offline" }, NOW + 5)).toMatchObject({
      status: "stale",
      windows: w,
      message: OFFLINE,
      nextAttemptAtMs: NOW + 5 + FAILURE_BACKOFF_MS,
    });
  });

  it("an offline machine with nothing to show is an error", () => {
    expect(reduce(initialState(), { kind: "offline" }, NOW)).toMatchObject({ status: "error", message: OFFLINE });
  });

  it("credentialNeedsAuthorization is needsAuthorization", () => {
    expect(reduce(initialState(), { kind: "needsAuthorization" }, NOW).status).toBe("needsAuthorization");
  });

  it("a success clears an earlier backoff and message", () => {
    const limited = reduce(initialState(), { kind: "rateLimited" }, NOW);
    const s = reduce(limited, { kind: "ok", windows: w }, NOW + 1);
    expect(s.nextAttemptAtMs).toBeUndefined();
    expect(s.message).toBeUndefined();
  });

  it("429 backs the account off for the stated delay and keeps stale values", () => {
    const good = reduce(initialState(), { kind: "ok", windows: w }, NOW);
    const s = reduce(good, { kind: "rateLimited", retryAfterMs: 120_000 }, NOW + 10);
    expect(s).toMatchObject({ status: "stale", message: "Rate limited", nextAttemptAtMs: NOW + 10 + 120_000 });
    expect(isDue(s, NOW + 10 + 120_000 - 1)).toBe(false);
    expect(isDue(s, NOW + 10 + 120_000)).toBe(true);
  });

  it("consecutive 429s without a delay double the default and a success resets it", () => {
    const first = reduce(initialState(), { kind: "rateLimited" }, NOW);
    const second = reduce(first, { kind: "rateLimited" }, NOW);
    expect([first.nextAttemptAtMs, second.nextAttemptAtMs]).toEqual([NOW + 300_000, NOW + 600_000]);
    const ok = reduce(second, { kind: "ok", windows: w }, NOW);
    expect(reduce(ok, { kind: "rateLimited" }, NOW).nextAttemptAtMs).toBe(NOW + 300_000);
  });

  it("an account with no backoff is always due", () => {
    expect(isDue(initialState(), NOW)).toBe(true);
  });
});
