/**
 * MODE-5 (0.4.46): the settings only `<cli> config` could change, as
 * POST /api/settings fields. Each patches user.yml in place; null clears
 * a key (back to its default), and a block left empty goes too. Nothing
 * is changed when any field is wrong.
 *
 *   local_dev: boolean | null         user.yml local_dev
 *   cli_tabs: boolean | null          user.yml cli_tabs
 *   log_window_lines: int | null      user.yml log_window_lines
 *   panes_reconnect: { seconds?, max_seconds?, max_failures?,
 *     window_seconds?, connect_timeout_seconds? }   user.yml panes.*
 *   crash_loop: { restarts?, minutes?, max_wait_seconds? }
 *                                     user.yml web.crash_loop_*
 */

/** The settings a person changes and an agent never does. */
export const PERSON_ONLY_SETTINGS = [
  "agents_default_mode",
  "local_dev",
  "cli_tabs",
  "log_window_lines",
  "panes_reconnect",
  "crash_loop",
] as const;

/** One limit: its key in user.yml, the least it may be, whole or not. */
interface Limit {
  key: string;
  min: number;
  max: number;
  int: boolean;
}

const PANES: Record<string, Limit> = {
  seconds: { key: "reconnect_seconds", min: 0.1, max: 3600, int: false },
  max_seconds: {
    key: "reconnect_max_seconds",
    min: 0.1,
    max: 3600,
    int: false,
  },
  max_failures: {
    key: "reconnect_max_failures",
    min: 1,
    max: 10_000,
    int: true,
  },
  window_seconds: {
    key: "reconnect_window_seconds",
    min: 1,
    max: 86_400,
    int: false,
  },
  connect_timeout_seconds: {
    key: "connect_timeout_seconds",
    min: 1,
    max: 600,
    int: false,
  },
};

const CRASH: Record<string, Limit> = {
  restarts: { key: "crash_loop_restarts", min: 1, max: 1000, int: true },
  minutes: { key: "crash_loop_minutes", min: 1, max: 10_080, int: true },
  max_wait_seconds: {
    key: "crash_loop_max_wait_seconds",
    min: 0,
    max: 86_400,
    int: true,
  },
};

/** The Log pane's lines: at least 1,000, at most 1,000,000. */
const LOG_LINES = { min: 1000, max: 1_000_000 };

type Patch = { ok: true } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function limitError(name: string, l: Limit, v: unknown): string | null {
  if (v === null) return null;
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < l.min ||
    v > l.max ||
    (l.int && !Number.isInteger(v))
  )
    return `${name} is ${l.int ? "a whole number" : "a number"} from ${l.min} to ${l.max}`;
  return null;
}

/** A block's limits: checked first, then written (null deletes). */
function patchBlock(
  user: Record<string, unknown>,
  field: string,
  block: string,
  limits: Record<string, Limit>,
  value: unknown,
  apply: (() => void)[],
): string | null {
  if (value === undefined) return null;
  if (!isObj(value))
    return `${field} is an object: ${Object.keys(limits).join(", ")}`;
  for (const [k, v] of Object.entries(value)) {
    const l = limits[k];
    if (!l)
      return `${field}.${k} is not a limit (${Object.keys(limits).join(", ")})`;
    const e = limitError(`${field}.${k}`, l, v);
    if (e) return e;
  }
  apply.push(() => {
    const b = isObj(user[block]) ? { ...user[block] } : {};
    for (const [k, v] of Object.entries(value)) {
      const key = limits[k]!.key;
      if (v === null) delete b[key];
      else b[key] = v;
    }
    if (Object.keys(b).length) user[block] = b;
    else delete user[block];
  });
  return null;
}

/**
 * The limits Settings has a row for, per field. `config` takes the rest
 * too (the first wait, the connect timeout): they have no row.
 */
export const PAGE_LIMITS = {
  panes_reconnect: ["max_failures", "window_seconds", "max_seconds"],
  crash_loop: ["restarts", "minutes", "max_wait_seconds"],
} as const;

const only = (all: Record<string, Limit>, names: readonly string[]) =>
  Object.fromEntries(names.map((n) => [n, all[n]!]));

/**
 * Patches `user` with the fields in `body`, or says what is wrong (and
 * changes nothing). `cli`: `config`'s, which takes every limit.
 */
export function patchCliRows(
  user: Record<string, unknown>,
  body: Record<string, unknown>,
  { cli = false }: { cli?: boolean } = {},
): Patch {
  const panes = cli ? PANES : only(PANES, PAGE_LIMITS.panes_reconnect);
  const crash = cli ? CRASH : only(CRASH, PAGE_LIMITS.crash_loop);
  const apply: (() => void)[] = [];
  for (const k of ["local_dev", "cli_tabs"] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "boolean")
      return { ok: false, error: `${k} is true, false or null` };
    apply.push(() => {
      if (v === null) delete user[k];
      else user[k] = v;
    });
  }
  const lines = body.log_window_lines;
  if (lines !== undefined) {
    if (
      lines !== null &&
      !(
        typeof lines === "number" &&
        Number.isInteger(lines) &&
        lines >= LOG_LINES.min &&
        lines <= LOG_LINES.max
      )
    )
      return {
        ok: false,
        error: `log_window_lines is a whole number from ${LOG_LINES.min} to ${LOG_LINES.max}`,
      };
    apply.push(() => {
      if (lines === null) delete user.log_window_lines;
      else user.log_window_lines = lines;
    });
  }
  const e =
    patchBlock(
      user,
      "panes_reconnect",
      "panes",
      panes,
      body.panes_reconnect,
      apply,
    ) ?? patchBlock(user, "crash_loop", "web", crash, body.crash_loop, apply);
  if (e) return { ok: false, error: e };
  for (const f of apply) f();
  return { ok: true };
}
