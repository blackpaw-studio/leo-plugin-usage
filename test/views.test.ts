import { describe, expect, it } from "vitest";
import { fullRoot, sidebarRoot } from "../src/views";
import type { Account } from "../src/poller";
import { OFFLINE } from "../src/state";
import type { GroupNode, MeterNode } from "../src/api";
import type { Accessory } from "../sdk/leo";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const session = { key: "session", label: "Session", percent: 42, resetsAtMs: NOW + (2 * 60 + 14) * 60_000 } as const;
const weekly = { key: "weekly", label: "Weekly", percent: 91, resetsAtMs: NOW + 3 * 24 * 3_600_000 } as const;

const account = (over: Partial<Omit<Account, "state">> & { state?: Partial<Account["state"]> } = {}): Account => ({
  handle: { id: "a1", kind: "claude-code", label: ".claude-work", path: "~/.claude-work" },
  label: ".claude-work",
  ...over,
  state: { status: "ok", windows: [session, weekly], updatedAtMs: NOW - 3 * 60_000, ...over.state },
});

const groups = (root: unknown): GroupNode[] => (Array.isArray(root) ? root : [root]).filter((n): n is GroupNode => n.type === "Group");
const meters = (g: GroupNode): MeterNode[] => g.children.filter((c): c is MeterNode => c.type === "Meter");

describe("sidebarRoot", () => {
  it("shows an empty state with both add actions when there are no accounts", () => {
    const root = sidebarRoot([], NOW);
    expect(root).toMatchObject({ type: "EmptyState" });
    expect(JSON.stringify(root)).toContain("add");
  });

  it("shows only the highest window per account as a toned Meter", () => {
    const [g] = groups(sidebarRoot([account()], NOW));
    expect(g.title).toBe(".claude-work"); // views show Account.label verbatim; the poller owns the default
    expect(meters(g)).toEqual([
      { type: "Meter", label: "Weekly", value: 0.91, valueText: "91%", detail: "Resets in 3d", tone: "failure" },
    ]);
  });

  it("leads with a header accessory for the worst meter across accounts", () => {
    const root = sidebarRoot([account(), account({ handle: { id: "b", kind: "codex", label: ".codex", path: "~/.codex" }, state: { windows: [session] } })], NOW);
    const first = (root as unknown[])[0] as Accessory;
    expect(first).toMatchObject({ type: "Accessory", text: "91%", color: "failure" });
  });

  it("omits the header accessory when no account has data", () => {
    const root = sidebarRoot([account({ state: { status: "loading", windows: [] } })], NOW) as unknown[];
    expect((root[0] as { type: string }).type).toBe("Group");
  });

  it("always leads the subtitle with the account kind, for VoiceOver (title, subtitle, state)", () => {
    const codexAcct = account({ handle: { id: "b", kind: "codex", label: ".codex", path: "~/.codex" } });
    expect(groups(sidebarRoot([account()], NOW))[0].subtitle).toBe("Claude Code");
    expect(groups(sidebarRoot([codexAcct], NOW))[0].subtitle).toBe("Codex");
    expect(groups(fullRoot([account()], NOW))[0].subtitle).toBe("~/.claude-work · Updated 3m ago");
  });

  it("marks a stale account and explains the old values", () => {
    const [g] = groups(sidebarRoot([account({ state: { status: "stale", message: "HTTP 500" } })], NOW));
    expect(g.accessory).toMatchObject({ text: "Stale", color: "warning" });
    expect(meters(g)[0].detail).toBe("Couldn't refresh · values from 6:57 AM");
  });

  it("a rate-limited account says when it retries, in place of the bare reason", () => {
    const retry = NOW + 5 * 60_000; // 7:05 AM in the suite's pinned zone
    const stale = groups(sidebarRoot([account({ state: { status: "stale", message: "Rate limited", nextAttemptAtMs: retry } })], NOW))[0];
    expect(meters(stale)[0].detail).toBe("Rate limited · retrying at 7:05 AM");
    const bare = account({ state: { status: "error", windows: [], message: "Rate limited", nextAttemptAtMs: retry } });
    expect(groups(sidebarRoot([bare], NOW))[0].subtitle).toBe("Claude Code · Rate limited · retrying at 7:05 AM");
    expect(groups(fullRoot([bare], NOW))[0].subtitle).toBe("~/.claude-work · Rate limited · retrying at 7:05 AM");
    expect("Rate limited · retrying at 12:05 PM".length).toBeLessThanOrEqual(80);
  });

  it("an expired account says how to sign in again and leads with Copy Sign-in Command", () => {
    const [g] = groups(sidebarRoot([account({ state: { status: "expired", windows: [] } })], NOW));
    expect(g.accessory).toMatchObject({ text: "Expired", color: "failure" });
    expect(g.subtitle).toBe("Claude Code · Token expired — use this account in Claude Code to renew");
    expect(g.actions?.[0]).toMatchObject({ type: "copy", title: "Copy Sign-in Command", text: "CLAUDE_CONFIG_DIR=~/.claude-work claude" });
  });

  it("a locked account leads with Grant Access…", () => {
    const [g] = groups(sidebarRoot([account({ state: { status: "needsAuthorization", windows: [] } })], NOW));
    expect(g.accessory).toMatchObject({ text: "Locked", color: "warning" });
    expect(g.actions?.[0]).toMatchObject({ type: "callback", id: "authorize", payload: { id: "a1" }, title: "Grant Access…" });
  });

  it("an error account shows the reason, loading shows Loading…", () => {
    const err = groups(sidebarRoot([account({ state: { status: "error", windows: [], message: "No usage data" } })], NOW))[0];
    expect(err).toMatchObject({ subtitle: "Claude Code · No usage data", accessory: { text: "Error" } });
    const loading = groups(sidebarRoot([account({ state: { status: "loading", windows: [] } })], NOW))[0];
    expect(loading.subtitle).toBe("Claude Code · Loading…");
  });

  it("every group offers Refresh, both add actions and Remove Account", () => {
    const [g] = groups(sidebarRoot([account()], NOW));
    expect((g.actions ?? []).map((a) => a.title)).toEqual(["Refresh", "Add Claude Account…", "Add Codex Account…", "Remove Account"]);
    expect(g.actions?.[0]).toMatchObject({ type: "callback", id: "refresh", payload: { id: "a1" } }); // per-account refresh
    expect(g.actions?.[3]).toMatchObject({ type: "callback", id: "remove", payload: { id: "a1" }, sfSymbol: "minus.circle" });
  });
});

describe("fullRoot", () => {
  it("shows every window with path and update time", () => {
    const [g] = groups(fullRoot([account()], NOW));
    expect(g.subtitle).toBe("~/.claude-work · Updated 3m ago");
    expect(meters(g).map((m) => [m.label, m.valueText, m.tone])).toEqual([
      ["Session", "42%", "success"],
      ["Weekly", "91%", "failure"],
    ]);
  });

  it("adds Rename and Remove actions", () => {
    const [g] = groups(fullRoot([account()], NOW));
    const titles = (g.actions ?? []).map((a) => a.title);
    expect(titles).toEqual(expect.arrayContaining(["Refresh", "Rename…", "Remove"]));
    const rename = g.actions?.find((a) => a.title === "Rename…");
    expect(rename).toMatchObject({ type: "pushView", node: { type: "Form" } });
  });

  it("uses the custom label as the title", () => {
    expect(groups(fullRoot([account({ label: "Work" })], NOW))[0].title).toBe("Work");
  });

  it("an empty list is the same empty state as the sidebar", () => {
    expect(fullRoot([], NOW)).toMatchObject({ type: "EmptyState" });
  });
});

describe("plain-text copy", () => {
  it("no user-visible string contains markdown backticks", () => {
    const states = ["loading", "ok", "stale", "expired", "needsAuthorization", "error"] as const;
    const accounts = states.flatMap((status) =>
      (["claude-code", "codex"] as const).map((kind) =>
        account({ handle: { id: status + kind, kind, label: "l", path: "~/p" }, state: { status, message: "m", windows: status === "ok" || status === "stale" ? [session] : [] } }),
      ),
    );
    const texts = JSON.stringify([sidebarRoot(accounts, NOW), fullRoot(accounts, NOW)]).replace(/"text":"[^"]*"/g, "");
    expect(texts).not.toContain("`"); // copy-action text (a shell command) is exempt
  });
});

describe("host limits on raw error text", () => {
  const long = "x".repeat(300);
  const walk = (node: unknown, visit: (n: Record<string, unknown>) => void): void => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
    if (typeof node !== "object" || node === null) return;
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  };

  it.each(["stale", "error"] as const)("a 300-char %s message still yields a valid tree", (status) => {
    const a = account({ state: { status, message: long, windows: status === "stale" ? [session] : [] } });
    for (const root of [sidebarRoot([a], NOW), fullRoot([a], NOW)]) {
      walk(root, (n) => {
        if (n.type === "Accessory") {
          expect((n.help as string | undefined)?.length ?? 0).toBeLessThanOrEqual(80);
          expect((n.text as string).length).toBeLessThanOrEqual(8);
        }
        for (const key of ["subtitle", "detail", "message"]) {
          expect((n[key] as string | undefined)?.length ?? 0).toBeLessThanOrEqual(120);
        }
      });
    }
  });
});

describe("remote accounts", () => {
  const remote = (over: Partial<Omit<Account, "state">> & { state?: Partial<Account["state"]> } = {}, kind: "claude-code" | "codex" = "claude-code") =>
    account({ handle: { id: "r1", kind, label: ".claude", path: "~/.claude", machine: "Dionysus" }, ...over });

  it("full subtitle leads with the machine", () => {
    expect(groups(fullRoot([remote()], NOW))[0].subtitle).toBe("Dionysus · ~/.claude · Updated 3m ago");
  });

  it("an offline account with values reads '<machine> is offline · values from …'", () => {
    const state = { status: "stale", message: OFFLINE, windows: [session] } as const;
    const [g] = groups(sidebarRoot([remote({ state })], NOW));
    expect(meters(g)[0].detail).toMatch(/^Dionysus is offline · values from /);
  });

  it("an offline account without values says the machine is offline", () => {
    const state = { status: "error", message: OFFLINE, windows: [] } as const;
    const [g] = groups(fullRoot([remote({ state })], NOW));
    expect(g.subtitle).toBe("Dionysus · ~/.claude · Dionysus is offline");
  });

  it("expired remote copy names the machine and tool, and keeps the sign-in command", () => {
    const state = { status: "expired", windows: [] } as const;
    const [g] = groups(sidebarRoot([remote({ state })], NOW));
    expect(g.subtitle).toBe("Claude Code · Token expired — use this account in Claude Code (on Dionysus) to renew");
    expect(g.actions?.[0]).toMatchObject({ type: "copy", title: "Copy Sign-in Command" });
  });

  it("expired Codex copy says Codex", () => {
    const state = { status: "expired", windows: [] } as const;
    const [g] = groups(sidebarRoot([remote({ state }, "codex")], NOW));
    expect(g.subtitle).toBe("Codex · Token expired — use this account in Codex (on Dionysus) to renew");
  });

  it("each remote copy string fits the 80-char help limit", () => {
    for (const s of ["Token expired — use this account in Claude Code (on Dionysus) to renew", "Dionysus is offline · values from 12:00 PM"]) {
      expect(s.length).toBeLessThanOrEqual(80);
    }
  });

  it("expired local copy drops the machine", () => {
    const state = { status: "expired", windows: [] } as const;
    const [g] = groups(sidebarRoot([account({ state })], NOW));
    expect(g.subtitle).toBe("Claude Code · Token expired — use this account in Claude Code to renew");
  });

  it("clips long machine names to the host line limit", () => {
    const state = { status: "error", message: OFFLINE, windows: [] } as const;
    const long = remote({ state, handle: { id: "r", kind: "claude-code", label: "x", path: "~/.claude", machine: "M".repeat(120) } });
    for (const root of [fullRoot([long], NOW), sidebarRoot([long], NOW)]) expect(groups(root)[0].subtitle!.length).toBeLessThanOrEqual(120);
  });
});
