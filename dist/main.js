"use strict";
(() => {
  // src/clock.ts
  var systemClock = { now: () => Date.now() };

  // src/window.ts
  var clampPercent = (n) => Math.min(100, Math.max(0, n));
  var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  var finiteNumber = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  var makeWindow = (key, label, percent, resetsAtMs) => resetsAtMs === void 0 ? { key, label, percent: clampPercent(percent) } : { key, label, percent: clampPercent(percent), resetsAtMs };

  // src/parse/claude.ts
  var WINDOWS = [
    ["five_hour", "session", "Session"],
    ["seven_day", "weekly", "Weekly"],
    ["seven_day_opus", "weekly-opus", "Weekly Opus"],
    ["seven_day_sonnet", "weekly-sonnet", "Weekly Sonnet"]
  ];
  var parseIso = (v) => {
    if (typeof v !== "string") return void 0;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? void 0 : ms;
  };
  function parseClaude(body) {
    if (!isRecord(body)) return [];
    return WINDOWS.flatMap(([field, key, label]) => {
      const w = body[field];
      if (!isRecord(w)) return [];
      const percent = finiteNumber(w.utilization);
      return percent === void 0 ? [] : [makeWindow(key, label, percent, parseIso(w.resets_at))];
    });
  }

  // src/parse/codex.ts
  var WINDOWS2 = [
    ["primary_window", "session", "Session"],
    ["secondary_window", "weekly", "Weekly"]
  ];
  function parseCodex(body) {
    if (!isRecord(body) || !isRecord(body.rate_limit)) return [];
    const limit = body.rate_limit;
    return WINDOWS2.flatMap(([field, key, label]) => {
      const w = limit[field];
      if (!isRecord(w)) return [];
      const percent = finiteNumber(w.used_percent);
      const resetAt = finiteNumber(w.reset_at);
      return percent === void 0 ? [] : [makeWindow(key, label, percent, resetAt === void 0 ? void 0 : resetAt * 1e3)];
    });
  }

  // src/refresh.ts
  var FRESH_MS = 4 * 6e4;
  var MANUAL_FRESH_MS = 6e4;
  var BYPASS_INTERVAL_MS = 6e4;
  var union = (a, b) => a || b ? [.../* @__PURE__ */ new Set([...a ?? [], ...b ?? []])] : void 0;
  var mergeRefresh = (a, b) => {
    const ids = a.ids && b.ids ? union(a.ids, b.ids) : void 0;
    const bypassBackoff = union(a.bypassBackoff, b.bypassBackoff);
    return {
      ...ids ? { ids } : {},
      ...a.manual || b.manual ? { manual: true } : {},
      ...bypassBackoff ? { bypassBackoff } : {}
    };
  };

  // src/retry.ts
  var SEC = 1e3;
  var MIN = 60 * SEC;
  var MIN_RETRY_MS = MIN;
  var MAX_RETRY_MS = 60 * MIN;
  var DEFAULT_RATE_LIMIT_MS = 5 * MIN;
  var FAILURE_BACKOFF_MS = 5 * MIN;
  var THROTTLE_DEFAULT_MS = MIN;
  var headerValue = (headers, name) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  function parseRetryAfter(value, nowMs) {
    const text = value?.trim() ?? "";
    if (/^\d+$/.test(text)) return Number(text) * SEC;
    if (!/[A-Za-z]/.test(text)) return void 0;
    const at = Date.parse(text);
    return Number.isFinite(at) ? Math.max(0, at - nowMs) : void 0;
  }
  var clamp = (ms, min, max) => Math.min(max, Math.max(min, ms));
  var rateLimitDelayMs = (retryAfterMs, streak) => retryAfterMs !== void 0 ? clamp(retryAfterMs, MIN_RETRY_MS, MAX_RETRY_MS) : Math.min(MAX_RETRY_MS, DEFAULT_RATE_LIMIT_MS * 2 ** Math.max(0, streak - 1));
  var isThrottle = (message) => /rate limited/i.test(message);
  var throttleDelayMs = (message) => {
    const seconds = /retry in (\d+)\s*s/i.exec(message)?.[1];
    return seconds === void 0 ? THROTTLE_DEFAULT_MS : Math.min(MAX_RETRY_MS, Number(seconds) * SEC);
  };

  // src/state.ts
  var RATE_LIMITED = "Rate limited";
  var OFFLINE = "Machine offline";
  var NO_DATA = "No usage data";
  var initialState = () => ({ status: "loading", windows: [] });
  var degrade = (state, message, extra = {}) => state.windows.length > 0 ? { ...state, ...extra, status: "stale", message } : { windows: [], ...extra, status: "error", message };
  function reduce(state, outcome, nowMs) {
    const { nextAttemptAtMs: _wait, rateLimitStreak, ...settled } = state;
    const failure = { nextAttemptAtMs: nowMs + FAILURE_BACKOFF_MS };
    switch (outcome.kind) {
      case "ok":
        return outcome.windows.length === 0 ? { status: "error", windows: [], message: NO_DATA, ...failure } : { status: "ok", windows: outcome.windows, updatedAtMs: nowMs };
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
      case "offline":
        return degrade(settled, OFFLINE, failure);
      case "failed":
        return degrade(settled, outcome.message, failure);
    }
  }
  var isDue = (state, nowMs) => state.nextAttemptAtMs === void 0 || nowMs >= state.nextAttemptAtMs;
  var isFresh = (state, nowMs, maxAgeMs) => state.updatedAtMs !== void 0 && nowMs - state.updatedAtMs < maxAgeMs;

  // src/store.ts
  var STATE_KEY = "state";
  var MAX_STATE_CHARS = 15e3;
  var MAX_LABEL_CHARS = 60;
  var MAX_MESSAGE_CHARS = 80;
  var STORED_STATUSES = /* @__PURE__ */ new Set(["stale", "error", "expired"]);
  var emptyPersisted = () => ({ order: [], labels: {}, snapshots: {}, nextAttempts: {}, outcomes: {} });
  var WINDOW_KEYS = /* @__PURE__ */ new Set(["session", "weekly", "weekly-opus", "weekly-sonnet"]);
  var readWindow = (v) => {
    if (!isRecord(v) || typeof v.key !== "string" || !WINDOW_KEYS.has(v.key) || typeof v.label !== "string") return [];
    const percent = finiteNumber(v.percent);
    if (percent === void 0) return [];
    const resetsAtMs = finiteNumber(v.resetsAtMs);
    const base = { key: v.key, label: v.label, percent };
    return [resetsAtMs === void 0 ? base : { ...base, resetsAtMs }];
  };
  var readOutcome = (v) => {
    if (!isRecord(v) || typeof v.status !== "string" || !STORED_STATUSES.has(v.status)) return [];
    const status = v.status;
    return [typeof v.message === "string" ? { status, message: v.message.slice(0, MAX_MESSAGE_CHARS) } : { status }];
  };
  var readSnapshot = (v) => {
    if (!isRecord(v) || !Array.isArray(v.windows)) return [];
    const updatedAtMs = finiteNumber(v.updatedAtMs);
    return updatedAtMs === void 0 ? [] : [{ windows: v.windows.flatMap(readWindow), updatedAtMs }];
  };
  function sanitize(raw) {
    if (!isRecord(raw)) return emptyPersisted();
    const order = Array.isArray(raw.order) ? raw.order.filter((id) => typeof id === "string") : [];
    const labels = isRecord(raw.labels) ? Object.fromEntries(
      Object.entries(raw.labels).filter((e) => typeof e[1] === "string").map(([id, label]) => [id, label.slice(0, MAX_LABEL_CHARS)])
    ) : {};
    const snapshots = isRecord(raw.snapshots) ? Object.fromEntries(Object.entries(raw.snapshots).flatMap(([id, s]) => readSnapshot(s).map((snap) => [id, snap]))) : {};
    const nextAttempts = isRecord(raw.nextAttempts) ? Object.fromEntries(Object.entries(raw.nextAttempts).flatMap(([id, at]) => finiteNumber(at) === void 0 ? [] : [[id, Number(at)]])) : {};
    const outcomes = isRecord(raw.outcomes) ? Object.fromEntries(Object.entries(raw.outcomes).flatMap(([id, o]) => readOutcome(o).map((out) => [id, out]))) : {};
    return { order, labels, snapshots, nextAttempts, outcomes };
  }
  async function loadPersisted(leo2) {
    const raw = await leo2.secrets.get(STATE_KEY);
    if (raw === null) return emptyPersisted();
    try {
      return sanitize(JSON.parse(raw));
    } catch {
      return emptyPersisted();
    }
  }
  function fit(state) {
    const byAge = Object.entries(state.snapshots).sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
    const trimmed = (dropped, outcomes) => ({
      ...state,
      outcomes,
      snapshots: Object.fromEntries(byAge.slice(dropped))
    });
    const fits = (candidate) => JSON.stringify(candidate).length <= MAX_STATE_CHARS;
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
  async function savePersisted(leo2, state) {
    await leo2.secrets.set(STATE_KEY, JSON.stringify(fit(sanitize(state))));
  }

  // src/poller.ts
  var CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage";
  var CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
  var POLL_INTERVAL_SEC = 300;
  var PROVIDERS = {
    "claude-code": { url: CLAUDE_URL, parse: parseClaude },
    codex: { url: CODEX_URL, parse: parseCodex }
  };
  var defaultLabel = (handle) => handle.label.startsWith(".") ? handle.label.slice(1) : handle.label;
  var errorMessage = (e) => e instanceof Error ? e.message : String(e);
  async function fetchOutcome(leo2, handle, nowMs) {
    const provider = PROVIDERS[handle.kind];
    try {
      const res = await leo2.fetch(provider.url, { credential: handle.id, headers: { Accept: "application/json" } });
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
  var storedOutcome = (state) => state.status === "stale" || state.status === "error" || state.status === "expired" ? [state.message === void 0 ? { status: state.status } : { status: state.status, message: state.message }] : [];
  var restoreOutcome = (state, outcome) => {
    if (!outcome) return state;
    const message = outcome.message === void 0 ? {} : { message: outcome.message };
    if (outcome.status === "expired") return { status: "expired", windows: [], nextAttemptAtMs: state.nextAttemptAtMs };
    return state.windows.length > 0 ? { ...state, ...message, status: "stale" } : { ...state, ...message, status: "error" };
  };
  function createPoller(leo2, clock, onChange) {
    let entries = [];
    let persisted = null;
    let inFlight = null;
    const lastBypassAt = /* @__PURE__ */ new Map();
    const backedOff = () => entries.filter((e) => e.state.nextAttemptAtMs !== void 0 && e.state.nextAttemptAtMs > clock.now());
    const persist = async () => {
      const base = persisted ?? await loadPersisted(leo2);
      persisted = {
        order: entries.map((e) => e.handle.id),
        labels: Object.fromEntries(Object.entries(base.labels).filter(([id]) => entries.some((e) => e.handle.id === id))),
        snapshots: Object.fromEntries(
          entries.flatMap(
            (e) => e.state.windows.length > 0 && e.state.updatedAtMs !== void 0 ? [[e.handle.id, { windows: [...e.state.windows], updatedAtMs: e.state.updatedAtMs }]] : []
          )
        ),
        nextAttempts: Object.fromEntries(backedOff().map((e) => [e.handle.id, e.state.nextAttemptAtMs ?? 0])),
        outcomes: Object.fromEntries(backedOff().flatMap((e) => storedOutcome(e.state).map((o) => [e.handle.id, o])))
      };
      await savePersisted(leo2, persisted);
    };
    const setState = (id, state) => {
      entries = entries.map((e) => e.handle.id === id ? { ...e, state } : e);
      onChange();
    };
    const restore = (handle, saved) => {
      const snap = saved.snapshots[handle.id];
      const saidAt = saved.nextAttempts[handle.id];
      const base = snap ? { status: "ok", windows: snap.windows, updatedAtMs: snap.updatedAtMs } : initialState();
      if (saidAt === void 0 || saidAt <= clock.now()) return base;
      const nextAttemptAtMs = Math.min(saidAt, clock.now() + MAX_RETRY_MS);
      return restoreOutcome({ ...base, nextAttemptAtMs }, saved.outcomes[handle.id]);
    };
    const sync = async () => {
      persisted = persisted ?? await loadPersisted(leo2);
      const saved = persisted;
      const handles = await leo2.credentials.list();
      const rank = (h) => {
        const i = saved.order.indexOf(h.id);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      const ordered = handles.map((h, i) => ({ h, i })).sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i).map((x) => x.h);
      entries = ordered.map((handle) => ({
        handle,
        state: entries.find((e) => e.handle.id === handle.id)?.state ?? restore(handle, saved)
      }));
      if (JSON.stringify(entries.map((e) => e.handle.id)) !== JSON.stringify(saved.order)) await persist();
      onChange();
    };
    const claimBypass = (id, options) => {
      if (!options.bypassBackoff?.includes(id)) return false;
      const last = lastBypassAt.get(id);
      if (last !== void 0 && clock.now() - last < BYPASS_INTERVAL_MS) return false;
      lastBypassAt.set(id, clock.now());
      return true;
    };
    const shouldFetch = (state, id, options) => claimBypass(id, options) || isDue(state, clock.now()) && !isFresh(state, clock.now(), options.manual ? MANUAL_FRESH_MS : FRESH_MS);
    const pass = async (options) => {
      for (const { handle } of [...entries]) {
        const current = entries.find((e) => e.handle.id === handle.id);
        if (!current || options.ids && !options.ids.includes(handle.id) || !shouldFetch(current.state, handle.id, options)) continue;
        const outcome = await fetchOutcome(leo2, handle, clock.now());
        if (entries.some((e) => e.handle.id === handle.id)) {
          setState(handle.id, reduce(entries.find((e) => e.handle.id === handle.id)?.state ?? initialState(), outcome, clock.now()));
        }
      }
      await persist();
    };
    let queued = null;
    const run = async (first) => {
      await pass(first);
      while (queued !== null) {
        const next = queued;
        queued = null;
        await pass(next);
      }
    };
    const refresh = (options = {}) => {
      if (inFlight) {
        queued = queued === null ? options : mergeRefresh(queued, options);
        return inFlight;
      }
      inFlight = run(options).finally(() => {
        inFlight = null;
      });
      return inFlight;
    };
    let timer = null;
    const init = async () => {
      timer ?? (timer = leo2.timer(POLL_INTERVAL_SEC, async () => {
        try {
          await sync();
          await refresh();
        } catch (e) {
          leo2.log("error", "poll failed: " + errorMessage(e));
        }
      }));
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
      accounts: () => entries.map((e) => ({ handle: e.handle, label: persisted?.labels[e.handle.id] ?? defaultLabel(e.handle), state: e.state })),
      rename: async (id, label) => {
        const base = persisted ?? await loadPersisted(leo2);
        const trimmed = label.trim();
        const { [id]: _dropped, ...rest } = base.labels;
        persisted = { ...base, labels: trimmed === "" ? rest : { ...rest, [id]: trimmed } };
        await savePersisted(leo2, persisted);
        onChange();
      }
    };
  }

  // src/format.ts
  var MIN2 = 6e4;
  var HOUR = 60 * MIN2;
  var DAY = 24 * HOUR;
  var percentText = (percent) => Math.round(percent) + "%";
  var pair = (big, unit, rest, restUnit) => rest === 0 ? big + unit : big + unit + " " + rest + restUnit;
  var span = (ms) => {
    if (ms < MIN2) return "<1m";
    if (ms < HOUR) return Math.floor(ms / MIN2) + "m";
    if (ms < DAY) return pair(Math.floor(ms / HOUR), "h", Math.floor(ms % HOUR / MIN2), "m");
    return pair(Math.floor(ms / DAY), "d", Math.floor(ms % DAY / HOUR), "h");
  };
  var resetsIn = (resetsAtMs, nowMs) => resetsAtMs <= nowMs ? "Resetting now" : "Resets in " + span(resetsAtMs - nowMs);
  var resetsCompact = (resetsAtMs, nowMs) => resetsAtMs <= nowMs ? "now" : span(resetsAtMs - nowMs);
  var agoShort = (updatedAtMs, nowMs) => {
    const age = Math.max(0, nowMs - updatedAtMs);
    if (age < MIN2) return "now";
    if (age < HOUR) return Math.floor(age / MIN2) + "m ago";
    if (age < DAY) return Math.floor(age / HOUR) + "h ago";
    return Math.floor(age / DAY) + "d ago";
  };
  var updatedAgo = (updatedAtMs, nowMs) => {
    const age = Math.max(0, nowMs - updatedAtMs);
    if (age < MIN2) return "Updated just now";
    if (age < HOUR) return "Updated " + Math.floor(age / MIN2) + "m ago";
    if (age < DAY) return "Updated " + Math.floor(age / HOUR) + "h ago";
    return "Updated " + Math.floor(age / DAY) + "d ago";
  };
  var MAX_HELP_CHARS = 80;
  var MAX_LINE_CHARS = 120;
  var clip = (text, max) => text.length <= max ? text : text.slice(0, max - 1) + "\u2026";
  var clockTime = (ms) => {
    const d = new Date(ms);
    const h = d.getHours();
    const m = d.getMinutes();
    return (h % 12 === 0 ? 12 : h % 12) + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? " AM" : " PM");
  };

  // src/tone.ts
  var WARNING_AT = 75;
  var FAILURE_AT = 90;
  var toneFor = (percent) => percent >= FAILURE_AT ? "failure" : percent >= WARNING_AT ? "warning" : "neutral";
  var RANK = { neutral: 0, success: 1, warning: 2, failure: 3 };
  var worstTone = (tones) => tones.reduce((worst, t) => worst === void 0 || RANK[t] > RANK[worst] ? t : worst, void 0);
  var highestWindow = (windows) => windows.reduce((best, w) => best === void 0 || w.percent > best.percent ? w : best, void 0);

  // src/views.ts
  var CALLBACKS = {
    refresh: "refresh",
    add: "add",
    authorize: "authorize",
    remove: "remove",
    rename: "rename"
  };
  var KIND_SYMBOL = { "claude-code": "sparkle", codex: "terminal" };
  var KIND_NAME = { "claude-code": "Claude Code", codex: "Codex" };
  var HEADER_SYMBOL = "speedometer";
  var callback = (id, title, sfSymbol, payload) => ({
    type: "callback",
    id,
    title,
    sfSymbol,
    ...payload ? { payload } : {}
  });
  var addActions = [
    callback(CALLBACKS.add, "Add Claude Account\u2026", "plus.circle", { kind: "claude-code" }),
    callback(CALLBACKS.add, "Add Codex Account\u2026", "plus.circle", { kind: "codex" })
  ];
  var removeAction = (account) => callback(CALLBACKS.remove, "Remove Account", "minus.circle", { id: account.handle.id });
  var refreshAction = (account) => callback(CALLBACKS.refresh, "Refresh", "arrow.clockwise", { id: account.handle.id });
  var accessory = (sfSymbol, text, color) => ({ type: "Accessory", sfSymbol, text, color });
  var emptyState = () => ({
    type: "EmptyState",
    title: "No accounts yet",
    message: "Add a Claude Code or Codex account to see its rate-limit usage.",
    sfSymbol: "plus.circle",
    actions: addActions
  });
  var meter = (w, nowMs, detail) => ({
    type: "Meter",
    label: w.label,
    value: w.percent / 100,
    valueText: percentText(w.percent),
    ...detail !== void 0 ? { detail } : w.resetsAtMs !== void 0 ? { detail: resetsIn(w.resetsAtMs, nowMs) } : {},
    tone: toneFor(w.percent)
  });
  var MISSING = "\u2014";
  var compactMeter = (w, label, nowMs) => w === void 0 ? { type: "Meter", label, value: 0, valueText: MISSING, tone: "neutral" } : {
    type: "Meter",
    label,
    value: w.percent / 100,
    valueText: percentText(w.percent),
    ...w.resetsAtMs !== void 0 ? { detail: resetsCompact(w.resetsAtMs, nowMs) } : {},
    tone: toneFor(w.percent)
  };
  var SIDEBAR_WINDOWS = [
    ["session", "5h"],
    ["weekly", "7d"]
  ];
  var sidebarMeters = (windows, nowMs) => windows.length === 0 ? [] : SIDEBAR_WINDOWS.map(([key, label]) => compactMeter(windows.find((w) => w.key === key), label, nowMs));
  var missingMeter = (label) => ({
    type: "Meter",
    label,
    value: 0,
    valueText: MISSING,
    detail: MISSING,
    tone: "neutral"
  });
  var REQUIRED = [
    ["session", "Session"],
    ["weekly", "Weekly"]
  ];
  var requiredMeters = (windows, nowMs, detail) => windows.length === 0 ? [] : REQUIRED.map(([key, label]) => {
    const w = windows.find((x) => x.key === key);
    return w ? meter(w, nowMs, detail) : missingMeter(label);
  });
  var fullMeters = (windows, nowMs, detail) => {
    const extras = windows.filter((w) => !REQUIRED.some(([key]) => key === w.key)).map((w) => meter(w, nowMs, detail));
    return [...requiredMeters(windows, nowMs, detail), ...extras];
  };
  var stateAccessory = (state) => {
    switch (state.status) {
      case "stale":
        return { ...accessory("arrow.clockwise", "Stale", "warning"), ...state.message !== void 0 ? { help: clip(state.message, MAX_HELP_CHARS) } : {} };
      case "expired":
        return accessory("xmark.circle", "Expired", "failure");
      case "needsAuthorization":
        return accessory("lock.fill", "Locked", "warning");
      case "error":
        return accessory("exclamationmark.triangle", "Error", "warning");
      default:
        return void 0;
    }
  };
  var retryDetail = (state) => state.message === RATE_LIMITED && state.nextAttemptAtMs !== void 0 ? RATE_LIMITED + " \xB7 retrying at " + clockTime(state.nextAttemptAtMs) : void 0;
  var isOffline = (state) => state.message === OFFLINE;
  var machineName = (handle) => handle.machine ?? "This machine";
  var expiredText = ({ handle }) => "Token expired \u2014 use this account in " + KIND_NAME[handle.kind] + (handle.machine !== void 0 ? " (on " + handle.machine + ")" : "") + " to renew";
  var stateText = (account) => {
    const { handle, state } = account;
    switch (state.status) {
      case "loading":
        return "Loading\u2026";
      case "expired":
        return expiredText(account);
      case "needsAuthorization":
        return handle.kind === "claude-code" ? "Leo needs Keychain access to read this account" : "Leo needs access to read this account";
      case "error":
        return retryDetail(state) ?? (isOffline(state) ? machineName(handle) + " is offline" : clip(state.message ?? NO_DATA, MAX_LINE_CHARS));
      default:
        return void 0;
    }
  };
  var signInCommand = (account) => {
    const { kind, path } = account.handle;
    return kind === "claude-code" ? "CLAUDE_CONFIG_DIR=" + path + " claude" : "CODEX_HOME=" + path + " codex login";
  };
  var leadingActions = (account) => {
    switch (account.state.status) {
      case "expired":
        return [{ type: "copy", title: "Copy Sign-in Command", sfSymbol: "doc", text: signInCommand(account) }];
      case "needsAuthorization":
        return [callback(CALLBACKS.authorize, "Grant Access\u2026", "key", { id: account.handle.id })];
      default:
        return [];
    }
  };
  var staleDetail = ({ handle, state }) => {
    if (state.status !== "stale") return void 0;
    if (retryDetail(state) !== void 0) return retryDetail(state);
    if (state.updatedAtMs === void 0) return void 0;
    const lead = isOffline(state) ? machineName(handle) + " is offline" : "Couldn't refresh";
    return clip(lead + " \xB7 values from " + clockTime(state.updatedAtMs), MAX_LINE_CHARS);
  };
  var renameForm = (account) => ({
    type: "Form",
    id: CALLBACKS.rename,
    title: "Rename Account",
    fields: [
      { id: "label", type: "text", label: "Name", value: account.label },
      {
        id: "submit",
        type: "submit",
        label: "Rename",
        action: { type: "callback", id: CALLBACKS.rename, payload: { id: account.handle.id } }
      }
    ]
  });
  var group = (account, children, subtitle, actions, acc = stateAccessory(account.state), layout = void 0) => {
    return {
      type: "Group",
      title: account.label,
      ...subtitle !== void 0 ? { subtitle } : {},
      sfSymbol: KIND_SYMBOL[account.handle.kind],
      ...layout !== void 0 ? { meterLayout: layout } : {},
      ...acc ? { accessory: acc } : {},
      children,
      actions
    };
  };
  var sidebarAccessory = (account, nowMs) => {
    const { state } = account;
    if (state.status !== "stale") return stateAccessory(state);
    const help = staleDetail(account);
    return {
      ...accessory("clock", state.updatedAtMs !== void 0 ? agoShort(state.updatedAtMs, nowMs) : "Stale", "neutral"),
      ...help !== void 0 ? { help: clip(help, MAX_HELP_CHARS) } : {}
    };
  };
  var sidebarGroup = (account, nowMs) => {
    const children = sidebarMeters(account.state.windows, nowMs);
    const text = children.length === 0 ? stateText(account) : void 0;
    const subtitle = clip(text ?? KIND_NAME[account.handle.kind], MAX_LINE_CHARS);
    const actions = [...leadingActions(account), refreshAction(account), ...addActions, removeAction(account)];
    return group(account, children, subtitle, actions, sidebarAccessory(account, nowMs), "inline");
  };
  var fullGroup = (account, nowMs) => {
    const { state, handle } = account;
    const updated = state.updatedAtMs !== void 0 && state.windows.length > 0 ? updatedAgo(state.updatedAtMs, nowMs) : stateText(account);
    const where = handle.machine !== void 0 ? handle.machine + " \xB7 " + handle.path : handle.path;
    const subtitle = clip(updated === void 0 ? where : where + " \xB7 " + updated, MAX_LINE_CHARS);
    const detail = staleDetail(account);
    return group(
      account,
      fullMeters(state.windows, nowMs, detail),
      subtitle,
      [
        ...leadingActions(account),
        refreshAction(account),
        { type: "pushView", title: "Rename\u2026", sfSymbol: "tag", node: renameForm(account) },
        callback(CALLBACKS.remove, "Remove", "minus.circle", { id: handle.id })
      ]
    );
  };
  var ACCESSORY_COLOR = {
    neutral: "neutral",
    success: "success",
    warning: "warning",
    failure: "failure"
  };
  var headerAccessory = (accounts) => {
    const tops = accounts.flatMap((a) => {
      const top = highestWindow(a.state.windows);
      return top ? [top] : [];
    });
    const worst = highestWindow(tops);
    if (!worst) return [];
    const tone = worstTone(tops.map((w) => toneFor(w.percent))) ?? "neutral";
    return [
      {
        type: "Accessory",
        sfSymbol: HEADER_SYMBOL,
        text: percentText(worst.percent),
        color: ACCESSORY_COLOR[tone],
        help: "Highest usage across accounts: " + worst.label
      }
    ];
  };
  function sidebarRoot(accounts, nowMs) {
    if (accounts.length === 0) return emptyState();
    const nodes = [...headerAccessory(accounts), ...accounts.map((a) => sidebarGroup(a, nowMs))];
    return nodes;
  }
  function fullRoot(accounts, nowMs) {
    if (accounts.length === 0) return emptyState();
    return accounts.map((a) => fullGroup(a, nowMs));
  }

  // src/plugin.ts
  var SECTION_ID = "usage";
  var COMMANDS = {
    show: "show",
    addClaude: "add-claude",
    addCodex: "add-codex",
    refresh: "refresh"
  };
  var KINDS = ["claude-code", "codex"];
  var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  var asKind = (v) => KINDS.find((k) => k === v) ?? null;
  var str = (v) => typeof v === "string" ? v : null;
  var note = (title, message, sfSymbol) => ({
    type: "EmptyState",
    title,
    ...message !== void 0 ? { message } : {},
    ...sfSymbol !== void 0 ? { sfSymbol } : {}
  });
  function createPlugin(leo2, clock) {
    const sections = /* @__PURE__ */ new Map();
    let showSlot = null;
    let started = null;
    let initialized = null;
    const draw = () => {
      const accounts = poller.accounts();
      sections.forEach((slot) => leo2.render(slot, sidebarRoot(accounts, clock.now())));
      if (showSlot) leo2.render(showSlot, fullRoot(accounts, clock.now()));
    };
    const poller = createPoller(leo2, clock, draw);
    const ready = () => {
      initialized = initialized ?? poller.init().catch((e) => {
        initialized = null;
        throw e;
      });
      return initialized;
    };
    const start = () => {
      started = started ?? ready().then(() => poller.refresh()).catch((e) => {
        started = null;
        throw e;
      });
      return started;
    };
    const safely = (what, fn) => async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        leo2.log("error", what + " failed: " + (e instanceof Error ? e.message : String(e)));
        return void 0;
      }
    };
    const addAccount = async (kind, slot) => {
      const pending = leo2.credentials.add(kind);
      const handle = await pending;
      if (slot?.kind === "palette") {
        leo2.render(slot, handle ? note("Added " + handle.label, handle.path, "checkmark.circle.fill") : note("No account added", void 0, "xmark.circle"));
      }
      if (!handle) return;
      await poller.sync();
      await poller.refresh({ ids: [handle.id] });
    };
    const authorize = async (id) => {
      const pending = leo2.credentials.authorize(id);
      await pending;
      await poller.refresh({ ids: [id] });
    };
    const activate = async (slot) => {
      if (slot?.kind === "section" && slot.id === SECTION_ID) sections.set(JSON.stringify(slot), slot);
      await start();
      draw();
    };
    const command = (id, slot) => {
      switch (id) {
        case COMMANDS.addClaude:
          return addAccount("claude-code", slot);
        case COMMANDS.addCodex:
          return addAccount("codex", slot);
        case COMMANDS.show:
          return showUsage(slot);
        case COMMANDS.refresh:
          return refreshNow(slot);
        default:
          return Promise.resolve();
      }
    };
    const showUsage = async (slot) => {
      if (slot?.kind === "palette") showSlot = slot;
      await start();
      draw();
    };
    const refreshNow = async (slot) => {
      await start();
      await poller.refresh({ manual: true });
      if (slot?.kind === "palette") leo2.render(slot, note("Usage refreshed", void 0, "checkmark.circle.fill"));
    };
    const refreshAccount = async (id) => {
      await start();
      await poller.refresh({ ids: [id], manual: true, bypassBackoff: [id] });
    };
    const callbackHandler = (id, payload) => {
      const body = isObj(payload) ? payload : {};
      switch (id) {
        case CALLBACKS.add: {
          const kind = asKind(body.kind);
          return kind ? addAccount(kind).then(() => null) : Promise.resolve(null);
        }
        case CALLBACKS.authorize: {
          const target = str(body.id);
          return target ? authorize(target).then(() => null) : Promise.resolve(null);
        }
        case CALLBACKS.refresh: {
          const target = str(body.id);
          return (target ? refreshAccount(target) : refreshNow()).then(() => null);
        }
        case CALLBACKS.remove: {
          const target = str(body.id);
          return target ? removeAccount(target).then(() => null) : Promise.resolve(null);
        }
        case CALLBACKS.rename: {
          const inner = isObj(body.payload) ? body.payload : {};
          const target = str(inner.id);
          const values = isObj(body.values) ? body.values : {};
          const label = str(values.label);
          return target && label !== null ? poller.rename(target, label).then(() => null) : Promise.resolve(null);
        }
        default:
          return Promise.resolve(null);
      }
    };
    const removeAccount = async (id) => {
      await leo2.credentials.remove(id);
      await poller.sync();
    };
    const credentialsChanged = async () => {
      await ready();
      await poller.sync();
      void poller.refresh().catch((e) => leo2.log("error", "refresh failed: " + (e instanceof Error ? e.message : String(e))));
    };
    leo2.on("credentialsChanged", safely("credentialsChanged", credentialsChanged));
    leo2.on("activate", safely("activate", activate));
    leo2.on("command", safely("command", command));
    leo2.on("callback", safely("callback", callbackHandler));
  }

  // src/main.ts
  createPlugin(leo, systemClock);
})();
