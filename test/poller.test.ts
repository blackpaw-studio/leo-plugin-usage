import { describe, expect, it } from "vitest";
import { createPoller, CLAUDE_URL, CODEX_URL, POLL_INTERVAL_SEC } from "../src/poller";
import type { Handle } from "../src/api";
import { OFFLINE } from "../src/state";
import claudeFull from "./fixtures/claude-full.json";
import codexFull from "./fixtures/codex-full.json";
import { createStubLeo } from "./stubLeo";

const claude: Handle = { id: "c1", kind: "claude-code", label: ".claude-work", path: "~/.claude-work" };
const claude2: Handle = { id: "c2", kind: "claude-code", label: ".claude", path: "~/.claude" };
const codex: Handle = { id: "x1", kind: "codex", label: ".codex", path: "~/.codex" };

const setup = (handles: Handle[]) => {
  const stub = createStubLeo();
  stub.setCredentials(handles);
  const changes: number[] = [];
  const poller = createPoller(stub.leo, stub.clock, () => changes.push(stub.clock.now()));
  return { stub, poller, changes };
};

const MIN = 60_000;
const refreshOne = (id: string) => ({ ids: [id], manual: true, bypassBackoff: [id] });

const stateOf = (p: ReturnType<typeof createPoller>, id: string) => p.accounts().find((a) => a.handle.id === id)?.state;

describe("poller", () => {
  it("fetches each account's endpoint with its credential and parses windows", async () => {
    const { stub, poller } = setup([claude, codex]);
    stub.route("GET", CLAUDE_URL, { body: claudeFull });
    stub.route("GET", CODEX_URL, { body: codexFull });
    await poller.sync();
    await poller.refresh();
    expect(stub.fetches.map((f) => [f.url, f.credential])).toEqual([[CLAUDE_URL, "c1"], [CODEX_URL, "x1"]]);
    expect(stateOf(poller, "c1")).toMatchObject({ status: "ok" });
    expect(stateOf(poller, "c1")?.windows).toHaveLength(4);
    expect(stateOf(poller, "x1")?.windows).toHaveLength(2);
  });

  it("never sends its own Authorization headers", async () => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, { body: claudeFull });
    await poller.sync();
    await poller.refresh();
    expect(Object.keys(stub.fetches[0].headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("is loading before the first fetch finishes", async () => {
    const { poller } = setup([claude]);
    await poller.sync();
    expect(stateOf(poller, "c1")?.status).toBe("loading");
  });

  it("never overlaps requests, even with accounts queued and concurrent refreshes", async () => {
    const { stub, poller } = setup([claude, claude2, codex]);
    stub.route("GET", CLAUDE_URL, { body: claudeFull });
    stub.route("GET", CODEX_URL, { body: codexFull });
    await poller.sync();
    await Promise.all([poller.refresh(), poller.refresh()]);
    expect(stub.maxInFlight).toBe(1);
    expect(stub.fetches).toHaveLength(3); // the follow-up pass found every account fresh
  });

  it.each([
    [{ status: 401 }, "expired"],
    [{ status: 500 }, "error"],
    [{ status: 200, body: "not json" }, "error"],
    [{ status: 200, body: {} }, "error"],
    [{ reject: "credentialNeedsAuthorization" }, "needsAuthorization"],
    [{ reject: "network down" }, "error"],
  ])("maps %j to %s", async (entry, status) => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, entry);
    await poller.sync();
    await poller.refresh();
    expect(stateOf(poller, "c1")?.status).toBe(status);
  });

  it("an unreachable machine is an offline error that backs off for 5 minutes", async () => {
    const remote: Handle = { ...claude, machine: "Dionysus" };
    const { stub, poller } = setup([remote]);
    stub.route("GET", CLAUDE_URL, { reject: "credentialMachineUnavailable: Dionysus is offline" }, { body: claudeFull });
    await poller.sync();
    await poller.refresh();
    expect(stateOf(poller, "c1")).toMatchObject({ status: "error", message: OFFLINE, nextAttemptAtMs: stub.clock.now() + 5 * MIN });
    stub.clock.advance(5 * MIN - 1_000);
    await poller.refresh();
    expect(stub.fetches).toHaveLength(1);
    stub.clock.advance(1_000);
    await poller.refresh();
    expect(stateOf(poller, "c1")?.status).toBe("ok");
  });

  it("goes stale, keeping values, when a later fetch fails", async () => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, { body: claudeFull }, { status: 503 });
    await poller.sync();
    await poller.refresh();
    stub.clock.advance(5 * MIN);
    await poller.refresh();
    expect(stateOf(poller, "c1")).toMatchObject({ status: "stale", message: "HTTP 503" });
    expect(stateOf(poller, "c1")?.windows).toHaveLength(4);
  });

  it("429 skips that account until its backoff ends but keeps polling the others", async () => {
    const { stub, poller } = setup([claude, codex]);
    stub.route("GET", CLAUDE_URL, { status: 429 }, { body: claudeFull });
    stub.route("GET", CODEX_URL, { body: codexFull });
    await poller.sync();
    await poller.refresh();
    expect(stub.fetches).toHaveLength(2);
    stub.clock.advance(5 * MIN - 1_000); // inside c1's backoff; x1's data is old enough to refetch
    await poller.refresh();
    expect(stub.fetches.map((f) => f.credential)).toEqual(["c1", "x1", "x1"]);
    stub.clock.advance(1_000);
    await poller.refresh();
    expect(stub.fetches.filter((f) => f.credential === "c1")).toHaveLength(2);
    expect(stateOf(poller, "c1")?.status).toBe("ok");
  });

  it("a refresh during a pass queues exactly one follow-up that picks up accounts added mid-pass", async () => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, { body: claudeFull });
    stub.route("GET", CODEX_URL, { body: codexFull });
    await poller.sync();
    const first = poller.refresh();
    stub.setCredentials([claude, codex]);
    const added = poller.sync().then(() => poller.refresh());
    const again = poller.refresh();
    const third = poller.refresh();
    await Promise.all([first, added, again, third]);
    expect(stub.fetches.filter((f) => f.credential === "x1")).toHaveLength(1);
    expect(stub.fetches.filter((f) => f.credential === "c1")).toHaveLength(1); // fresh from the first pass
    expect(stub.maxInFlight).toBe(1);
  });

  it("a per-account refresh queued during a pass still bypasses that account's backoff", async () => {
    const { stub, poller } = setup([claude, codex]);
    stub.route("GET", CLAUDE_URL, { status: 429 }, { body: claudeFull });
    stub.route("GET", CODEX_URL, { body: codexFull });
    await poller.sync();
    await poller.refresh();
    stub.clock.advance(MIN);
    const timerPass = poller.refresh();
    const manual = poller.refresh(refreshOne("c1"));
    await Promise.all([timerPass, manual]);
    expect(stateOf(poller, "c1")?.status).toBe("ok");
    expect(stub.maxInFlight).toBe(1);
  });

  it("start() refreshes now and then every 5 minutes on leo.timer", async () => {
    const { stub, poller } = setup([codex]);
    stub.route("GET", CODEX_URL, { body: codexFull });
    await poller.start();
    expect(stub.fetches).toHaveLength(1);
    expect(POLL_INTERVAL_SEC).toBe(300);
    await stub.tick(300);
    expect(stub.fetches).toHaveLength(2);
  });

  it("notifies on every state change", async () => {
    const { stub, poller, changes } = setup([codex]);
    stub.route("GET", CODEX_URL, { body: codexFull });
    await poller.sync();
    const before = changes.length;
    await poller.refresh();
    expect(changes.length).toBeGreaterThan(before);
  });

  it("sync drops removed accounts and adds new ones, in stored order", async () => {
    const { stub, poller } = setup([claude, codex]);
    await poller.sync();
    stub.setCredentials([codex, claude2]);
    await poller.sync();
    expect(poller.accounts().map((a) => a.handle.id)).toEqual(["x1", "c2"]);
  });

  it("defaults the label to the host's basename without a single leading dot, and a rename wins", async () => {
    const dotted: Handle = { id: "d", kind: "claude-code", label: "..odd", path: "~/..odd" };
    const { stub, poller } = setup([claude, codex, dotted]);
    await poller.sync();
    expect(poller.accounts().map((a) => a.label)).toEqual(["claude-work", "codex", ".odd"]);
    await poller.rename("x1", "Codex Home");
    expect(poller.accounts().map((a) => a.label)[1]).toBe("Codex Home");
    expect(stub.credentialCalls).not.toContain("remove:x1");
  });

  it("persists order, custom labels and last-good snapshots, and restores them", async () => {
    const first = setup([claude, codex]);
    first.stub.route("GET", CLAUDE_URL, { body: claudeFull });
    first.stub.route("GET", CODEX_URL, { body: codexFull });
    await first.poller.sync();
    await first.poller.refresh();
    await first.poller.rename("c1", "Work");
    const second = createPoller(first.stub.leo, first.stub.clock, () => {});
    await second.sync();
    const restored = second.accounts().find((a) => a.handle.id === "c1");
    expect(restored?.label).toBe("Work");
    expect(restored?.state.windows).toHaveLength(4);
    expect(restored?.state.status).toBe("ok");
  });
});

describe("rate limiting", () => {
  const limited = (headers?: Record<string, string>) => ({ status: 429, ...(headers ? { headers } : {}) });
  const fetchCount = (stub: ReturnType<typeof setup>["stub"]) => stub.fetches.length;

  /** Refreshes `ms - 1` into the wait (must not fetch), then at `ms` (must fetch). */
  const expectRetryAfter = async (ctx: ReturnType<typeof setup>, ms: number): Promise<void> => {
    const before = fetchCount(ctx.stub);
    ctx.stub.clock.advance(ms - 1);
    await ctx.poller.refresh();
    expect(fetchCount(ctx.stub)).toBe(before);
    ctx.stub.clock.advance(1);
    await ctx.poller.refresh();
    expect(fetchCount(ctx.stub)).toBe(before + 1);
  };

  it.each([
    ["Retry-After", "120", 2 * MIN],
    ["retry-after", "120", 2 * MIN],
    ["RETRY-AFTER", "300", 5 * MIN],
    ["Retry-After", "5", MIN], // floor of one minute
    ["Retry-After", "0", MIN],
    ["Retry-After", "86400", 60 * MIN], // cap of one hour
  ])("429 with %s: %s waits %d ms", async (name, value, wait) => {
    const ctx = setup([claude]);
    ctx.stub.route("GET", CLAUDE_URL, limited({ [name]: value }));
    await ctx.poller.sync();
    await ctx.poller.refresh();
    await expectRetryAfter(ctx, wait);
  });

  it("reads an HTTP-date Retry-After", async () => {
    const ctx = setup([claude]);
    ctx.stub.route("GET", CLAUDE_URL, limited({ "retry-after": new Date(ctx.stub.clock.now() + 10 * MIN).toUTCString() }));
    await ctx.poller.sync();
    await ctx.poller.refresh();
    await expectRetryAfter(ctx, 10 * MIN);
  });

  it("a Retry-After date in the past still waits the one-minute floor", async () => {
    const ctx = setup([claude]);
    ctx.stub.route("GET", CLAUDE_URL, limited({ "retry-after": new Date(ctx.stub.clock.now() - 10 * MIN).toUTCString() }));
    await ctx.poller.sync();
    await ctx.poller.refresh();
    await expectRetryAfter(ctx, MIN);
  });

  it.each([[undefined], [{ "retry-after": "soon" }], [{ "retry-after": "-5" }]])(
    "429 without a usable Retry-After (%j) waits 5 minutes, then doubles, capped at an hour",
    async (headers) => {
      const ctx = setup([claude]);
      ctx.stub.route("GET", CLAUDE_URL, limited(headers));
      await ctx.poller.sync();
      await ctx.poller.refresh();
      for (const minutes of [5, 10, 20, 40, 60, 60]) await expectRetryAfter(ctx, minutes * MIN);
    },
  );

  it("a 200 clears the backoff and the doubling", async () => {
    const ctx = setup([claude]);
    ctx.stub.route("GET", CLAUDE_URL, limited(), limited(), { body: claudeFull }, limited());
    await ctx.poller.sync();
    await ctx.poller.refresh();
    await expectRetryAfter(ctx, 5 * MIN);
    await expectRetryAfter(ctx, 10 * MIN); // third request is the 200
    expect(stateOf(ctx.poller, "c1")).toMatchObject({ status: "ok", updatedAtMs: ctx.stub.clock.now() });
    expect(stateOf(ctx.poller, "c1")?.nextAttemptAtMs).toBeUndefined();
    ctx.stub.clock.advance(4 * MIN);
    await ctx.poller.refresh(); // the 429 after the success starts over at 5 minutes
    await expectRetryAfter(ctx, 5 * MIN);
  });

  it("a restarted poller honours the persisted backoff", async () => {
    const first = setup([claude]);
    first.stub.route("GET", CLAUDE_URL, limited({ "retry-after": "600" }));
    await first.poller.sync();
    await first.poller.refresh();
    const second = createPoller(first.stub.leo, first.stub.clock, () => {});
    await second.start();
    expect(first.stub.fetches).toHaveLength(1);
    first.stub.clock.advance(10 * MIN - 1);
    await second.refresh();
    expect(first.stub.fetches).toHaveLength(1);
    first.stub.clock.advance(1);
    await second.refresh();
    expect(first.stub.fetches).toHaveLength(2);
  });

  it("refresh-all never bypasses a backoff", async () => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, limited(), { body: claudeFull });
    await poller.sync();
    await poller.refresh();
    await poller.refresh({ manual: true });
    expect(stub.fetches).toHaveLength(1);
  });

  it("a per-account refresh bypasses the backoff, but only once per account per minute", async () => {
    const { stub, poller } = setup([claude, claude2]);
    stub.route("GET", CLAUDE_URL, limited());
    await poller.sync();
    await poller.refresh();
    expect(stub.fetches).toHaveLength(2);
    await poller.refresh(refreshOne("c1"));
    expect(stub.fetches.map((f) => f.credential)).toEqual(["c1", "c2", "c1"]); // c2's backoff untouched
    stub.clock.advance(MIN - 1_000);
    await poller.refresh(refreshOne("c1"));
    expect(stub.fetches).toHaveLength(3);
    stub.clock.advance(1_000);
    await poller.refresh(refreshOne("c1"));
    expect(stub.fetches).toHaveLength(4);
    await poller.refresh(refreshOne("c2")); // its own allowance
    expect(stub.fetches.map((f) => f.credential).slice(-1)).toEqual(["c2"]);
  });

  it("shows the rate-limit reason and the retry time on the account state", async () => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, limited({ "retry-after": "600" }));
    await poller.sync();
    await poller.refresh();
    expect(stateOf(poller, "c1")).toMatchObject({ status: "error", message: "Rate limited", nextAttemptAtMs: stub.clock.now() + 10 * MIN });
  });
});

describe("freshness", () => {
  it("a pass skips an account fetched less than 4 minutes ago", async () => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, { body: claudeFull });
    await poller.sync();
    await poller.refresh();
    stub.clock.advance(4 * MIN - 1);
    await poller.refresh();
    expect(stub.fetches).toHaveLength(1);
    stub.clock.advance(1);
    await poller.refresh();
    expect(stub.fetches).toHaveLength(2);
  });

  it("the launch pass after a restart skips accounts whose stored snapshot is fresh", async () => {
    const first = setup([claude, codex]);
    first.stub.route("GET", CLAUDE_URL, { body: claudeFull });
    first.stub.route("GET", CODEX_URL, { body: codexFull });
    await first.poller.start();
    expect(first.stub.fetches).toHaveLength(2);
    first.stub.clock.advance(3 * MIN);
    const relaunched = createPoller(first.stub.leo, first.stub.clock, () => {});
    await relaunched.start();
    expect(first.stub.fetches).toHaveLength(2);
    expect(relaunched.accounts().map((a) => a.state.status)).toEqual(["ok", "ok"]);
    first.stub.clock.advance(MIN);
    const later = createPoller(first.stub.leo, first.stub.clock, () => {});
    await later.start();
    expect(first.stub.fetches).toHaveLength(4);
  });

  it("a manual refresh-all skips accounts fetched in the last minute and refreshes the rest", async () => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, { body: claudeFull });
    await poller.sync();
    await poller.refresh();
    stub.clock.advance(MIN - 1_000);
    await poller.refresh({ manual: true });
    expect(stub.fetches).toHaveLength(1);
    stub.clock.advance(1_000);
    await poller.refresh({ manual: true });
    expect(stub.fetches).toHaveLength(2);
  });

  it("refreshing named accounts fetches only those", async () => {
    const { stub, poller } = setup([claude, claude2]);
    stub.route("GET", CLAUDE_URL, { body: claudeFull });
    await poller.sync();
    await poller.refresh({ ids: ["c2"] });
    expect(stub.fetches.map((f) => f.credential)).toEqual(["c2"]);
  });
});

describe("failure backoff", () => {
  it("a host limiter rejection backs the account off for the stated seconds", async () => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, { reject: "rate limited: retry in 90 s" });
    await poller.sync();
    await poller.refresh();
    expect(stateOf(poller, "c1")).toMatchObject({ status: "error", message: "Rate limited" });
    stub.clock.advance(89_000);
    await poller.refresh();
    expect(stub.fetches).toHaveLength(1);
    stub.clock.advance(1_000);
    await poller.refresh();
    expect(stub.fetches).toHaveLength(2);
  });

  it("a host limiter rejection without a number backs off 60 seconds", async () => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, { reject: "stubLeo host: rate limited" });
    await poller.sync();
    await poller.refresh();
    stub.clock.advance(MIN - 1);
    await poller.refresh();
    expect(stub.fetches).toHaveLength(1);
    stub.clock.advance(1);
    await poller.refresh();
    expect(stub.fetches).toHaveLength(2);
  });

  it.each([[{ status: 401 }], [{ status: 500 }], [{ reject: "network down" }]])("%j backs off 5 minutes instead of retrying on every trigger", async (entry) => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, entry);
    await poller.sync();
    await poller.refresh();
    stub.clock.advance(5 * MIN - 1);
    await poller.refresh();
    expect(stub.fetches).toHaveLength(1);
    stub.clock.advance(1);
    await poller.refresh();
    expect(stub.fetches).toHaveLength(2);
  });

  it("a locked account is not backed off, so granting access retries at once", async () => {
    const { stub, poller } = setup([claude]);
    stub.route("GET", CLAUDE_URL, { reject: "credentialNeedsAuthorization" }, { body: claudeFull });
    await poller.sync();
    await poller.refresh();
    await poller.refresh();
    expect(stateOf(poller, "c1")?.status).toBe("ok");
  });
});

describe("restart recovery of a backed-off account", () => {
  const relaunch = (ctx: ReturnType<typeof setup>) => {
    const poller = createPoller(ctx.stub.leo, ctx.stub.clock, () => {});
    return poller;
  };

  it("keeps showing a rate limit, with its snapshot, as stale", async () => {
    const ctx = setup([claude]);
    ctx.stub.route("GET", CLAUDE_URL, { body: claudeFull }, { status: 429, headers: { "retry-after": "600" } });
    await ctx.poller.sync();
    await ctx.poller.refresh();
    ctx.stub.clock.advance(5 * MIN);
    await ctx.poller.refresh();
    const again = relaunch(ctx);
    await again.start();
    expect(stateOf(again, "c1")).toMatchObject({ status: "stale", message: "Rate limited", nextAttemptAtMs: ctx.stub.clock.now() + 10 * MIN });
    expect(stateOf(again, "c1")?.windows).toHaveLength(4);
    expect(ctx.stub.fetches).toHaveLength(2);
  });

  it("shows a rate limit with no snapshot as an error, not Loading", async () => {
    const ctx = setup([claude]);
    ctx.stub.route("GET", CLAUDE_URL, { status: 429 });
    await ctx.poller.sync();
    await ctx.poller.refresh();
    const again = relaunch(ctx);
    await again.sync();
    expect(stateOf(again, "c1")).toMatchObject({ status: "error", message: "Rate limited", windows: [] });
  });

  it("keeps a signed-out account expired", async () => {
    const ctx = setup([claude]);
    ctx.stub.route("GET", CLAUDE_URL, { status: 401 });
    await ctx.poller.sync();
    await ctx.poller.refresh();
    const again = relaunch(ctx);
    await again.sync();
    expect(stateOf(again, "c1")).toMatchObject({ status: "expired", windows: [] });
  });

  it("restores a failure message, and an expired backoff restores as plain ok/loading", async () => {
    const ctx = setup([claude, codex]);
    ctx.stub.route("GET", CLAUDE_URL, { status: 500 });
    ctx.stub.route("GET", CODEX_URL, { body: codexFull });
    await ctx.poller.sync();
    await ctx.poller.refresh();
    const again = relaunch(ctx);
    await again.sync();
    expect(stateOf(again, "c1")).toMatchObject({ status: "error", message: "HTTP 500" });
    expect(stateOf(again, "x1")).toMatchObject({ status: "ok" });
    ctx.stub.clock.advance(5 * MIN);
    const later = relaunch(ctx);
    await later.sync();
    expect(stateOf(later, "c1")).toMatchObject({ status: "loading" });
  });

  it("caps a persisted retry time at one hour from now", async () => {
    const ctx = setup([claude]);
    ctx.stub.secretStore.set("state", JSON.stringify({ order: ["c1"], nextAttempts: { c1: ctx.stub.clock.now() + 10 * 60 * MIN } }));
    ctx.stub.route("GET", CLAUDE_URL, { body: claudeFull });
    await ctx.poller.sync();
    ctx.stub.clock.advance(60 * MIN - 1);
    await ctx.poller.refresh();
    expect(ctx.stub.fetches).toHaveLength(0);
    ctx.stub.clock.advance(1);
    await ctx.poller.refresh();
    expect(ctx.stub.fetches).toHaveLength(1);
  });
});
