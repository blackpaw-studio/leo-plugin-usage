const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const percentText = (percent: number): string => Math.round(percent) + "%";

const pair = (big: number, unit: string, rest: number, restUnit: string): string =>
  rest === 0 ? big + unit : big + unit + " " + rest + restUnit;

const span = (ms: number): string => {
  if (ms < MIN) return "<1m";
  if (ms < HOUR) return Math.floor(ms / MIN) + "m";
  if (ms < DAY) return pair(Math.floor(ms / HOUR), "h", Math.floor((ms % HOUR) / MIN), "m");
  return pair(Math.floor(ms / DAY), "d", Math.floor((ms % DAY) / HOUR), "h");
};

export const resetsIn = (resetsAtMs: number, nowMs: number): string =>
  resetsAtMs <= nowMs ? "Resetting now" : "Resets in " + span(resetsAtMs - nowMs);

/** Bare time to a reset ("34m", "3d 5h"), for the compact sidebar line under a meter. */
export const resetsCompact = (resetsAtMs: number, nowMs: number): string => (resetsAtMs <= nowMs ? "now" : span(resetsAtMs - nowMs));

/** Short age for the stale accessory ("2h ago"); the accessory text limit is 8 characters. */
export const agoShort = (updatedAtMs: number, nowMs: number): string => {
  const age = Math.max(0, nowMs - updatedAtMs);
  if (age < MIN) return "now";
  if (age < HOUR) return Math.floor(age / MIN) + "m ago";
  if (age < DAY) return Math.floor(age / HOUR) + "h ago";
  return Math.floor(age / DAY) + "d ago";
};

export const updatedAgo = (updatedAtMs: number, nowMs: number): string => {
  const age = Math.max(0, nowMs - updatedAtMs);
  if (age < MIN) return "Updated just now";
  if (age < HOUR) return "Updated " + Math.floor(age / MIN) + "m ago";
  if (age < DAY) return "Updated " + Math.floor(age / HOUR) + "h ago";
  return "Updated " + Math.floor(age / DAY) + "d ago";
};

/** Limits the host enforces on tree text; raw error text must fit them or the whole render is refused. */
export const MAX_HELP_CHARS = 80;
export const MAX_LINE_CHARS = 120;

/** Truncates to at most `max` characters, the ellipsis included. */
export const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max - 1) + "…");

/** Local 12-hour clock time, such as "8:57 PM". Built by hand: no locale APIs in the plugin sandbox. */
export const clockTime = (ms: number): string => {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  return (h % 12 === 0 ? 12 : h % 12) + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? " AM" : " PM");
};
