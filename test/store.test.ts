import { describe, expect, it } from "vitest";
import { MAX_STATE_CHARS, emptyPersisted, loadPersisted, savePersisted, type Persisted } from "../src/store";
import { createStubLeo } from "./stubLeo";

const sample: Persisted = {
  order: ["a", "b"],
  labels: { a: "Work" },
  snapshots: { a: { windows: [{ key: "session", label: "Session", percent: 10 }], updatedAtMs: 5 } },
  nextAttempts: { b: 9_000 },
  outcomes: { b: { status: "expired" }, a: { status: "stale", message: "Rate limited" } },
};

describe("persisted state", () => {
  it("round-trips through leo.secrets under the `state` key", async () => {
    const { leo, secretStore } = createStubLeo();
    await savePersisted(leo, sample);
    expect(secretStore.has("state")).toBe(true);
    expect(await loadPersisted(leo)).toEqual(sample);
  });

  it("loads empty when nothing is stored", async () => {
    expect(await loadPersisted(createStubLeo().leo)).toEqual(emptyPersisted());
  });

  it("loads empty when the stored value is corrupt", async () => {
    const stub = createStubLeo();
    stub.secretStore.set("state", "{nope");
    expect(await loadPersisted(stub.leo)).toEqual(emptyPersisted());
  });

  it("drops malformed entries but keeps good ones", async () => {
    const stub = createStubLeo();
    stub.secretStore.set("state", JSON.stringify({ order: ["a", 3], labels: { a: "x", b: 4 }, snapshots: { a: 7 } }));
    expect(await loadPersisted(stub.leo)).toEqual({ order: ["a"], labels: { a: "x" }, snapshots: {}, nextAttempts: {}, outcomes: {} });
  });

  it("trims the oldest snapshots to stay under the host's value cap, keeping order and labels", async () => {
    const stub = createStubLeo();
    const ids = Array.from({ length: 120 }, (_, i) => "acct-" + i);
    const snapshots = Object.fromEntries(
      ids.map((id, i) => [
        id,
        {
          windows: ["session", "weekly", "weekly-opus", "weekly-sonnet"].map((key) => ({ key, label: key, percent: 50, resetsAtMs: 1767276840000 })),
          updatedAtMs: i,
        },
      ]),
    ) as Persisted["snapshots"];
    await savePersisted(stub.leo, { order: ids, labels: { "acct-0": "Zero" }, snapshots, nextAttempts: {}, outcomes: {} });
    const raw = stub.secretStore.get("state") ?? "";
    expect(raw.length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    const back = await loadPersisted(stub.leo);
    expect(back.order).toEqual(ids);
    expect(back.labels).toEqual({ "acct-0": "Zero" });
    expect(back.snapshots["acct-119"]).toBeDefined(); // newest kept
    expect(back.snapshots["acct-0"]).toBeUndefined(); // oldest dropped
  });

  it("never persists anything token-shaped: only order, labels and snapshots", async () => {
    const stub = createStubLeo();
    await savePersisted(stub.leo, { ...sample, token: "secret" } as Persisted);
    expect(Object.keys(JSON.parse(stub.secretStore.get("state") ?? "{}")).sort()).toEqual(["labels", "nextAttempts", "order", "outcomes", "snapshots"]);
  });

  it("loads state stored by v0.1.0, which had no retry times", async () => {
    const stub = createStubLeo();
    const v010 = { order: ["a"], labels: { a: "Work" }, snapshots: sample.snapshots };
    stub.secretStore.set("state", JSON.stringify(v010));
    expect(await loadPersisted(stub.leo)).toEqual({ ...v010, nextAttempts: {}, outcomes: {} });
  });

  it("drops retry times that are not finite numbers", async () => {
    const stub = createStubLeo();
    stub.secretStore.set("state", JSON.stringify({ nextAttempts: { a: 5, b: "soon", c: null } }));
    expect((await loadPersisted(stub.leo)).nextAttempts).toEqual({ a: 5 });
  });

  it("keeps every retry time when trimming snapshots to the value cap", async () => {
    const stub = createStubLeo();
    const ids = Array.from({ length: 120 }, (_, i) => "acct-" + i);
    const snapshots = Object.fromEntries(
      ids.map((id, i) => [id, { windows: [{ key: "session", label: "Session", percent: 50, resetsAtMs: 1767276840000 }], updatedAtMs: i }]),
    ) as Persisted["snapshots"];
    const nextAttempts = Object.fromEntries(ids.map((id) => [id, 1767276840000]));
    await savePersisted(stub.leo, { order: ids, labels: {}, snapshots, nextAttempts, outcomes: {} });
    expect((stub.secretStore.get("state") ?? "").length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect((await loadPersisted(stub.leo)).nextAttempts).toEqual(nextAttempts);
  });

  it("drops malformed outcomes, unknown statuses and over-long messages", async () => {
    const stub = createStubLeo();
    const outcomes = { a: { status: "error", message: "x".repeat(300) }, b: { status: "ok" }, c: { status: "stale", message: 4 }, d: "stale" };
    stub.secretStore.set("state", JSON.stringify({ outcomes }));
    const back = (await loadPersisted(stub.leo)).outcomes;
    expect(Object.keys(back).sort()).toEqual(["a", "c"]);
    expect(back.a.message?.length).toBeLessThanOrEqual(80);
    expect(back.c).toEqual({ status: "stale" });
  });

  it("sheds outcomes before retry times when even bare snapshots-free state is too big", async () => {
    const stub = createStubLeo();
    const ids = Array.from({ length: 120 }, (_, i) => "acct-" + i);
    const nextAttempts = Object.fromEntries(ids.map((id) => [id, 1767276840000]));
    const outcomes = Object.fromEntries(ids.map((id) => [id, { status: "error" as const, message: "m".repeat(80) }]));
    await savePersisted(stub.leo, { order: ids, labels: {}, snapshots: {}, nextAttempts, outcomes });
    expect((stub.secretStore.get("state") ?? "").length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect((await loadPersisted(stub.leo)).nextAttempts).toEqual(nextAttempts);
  });
});
