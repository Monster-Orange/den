/**
 * Issue 625: test boxes. A team often has idle machines that can run
 * browser tests. Each one the person sets up here is a source of browser
 * slots, beside this machine's own:
 *
 *   boxes (settings.json, `boxes`): a list, empty by default, so nothing
 *     changes for an install without boxes. Each box: a name, how Den
 *     reaches it (ssh, and/or a Playwright server address), how many
 *     browser slots it has, where its hold file is, and its time scale
 *     (how much longer its browsers take than this machine's).
 *   boxes-state.json: what the last check of each box found (open, held,
 *     unreachable, with why and when). Shown in the queue and in doctor.
 *
 * A box is checked only when a slot on it is about to be given: never on a
 * timer. The check is a read over the box's own connection (an sftp `ls`
 * of the hold file, or a WebSocket upgrade to the Playwright server, closed
 * at once); nothing on the box is run. An open answer is good for one assignment; a held or
 * unreachable answer is remembered for `box_recheck_seconds`, then read
 * again the next time a slot on that box is wanted.
 *
 * Who may take a box's slot: a run says where it may go (`where`): this
 * machine only (the default, as before), any box or this machine
 * (`any`), or one box by name (a run that executes on that box, such as
 * its CI runner). The queue stays first come, first served: a waiter
 * that can't start keeps the slots it waits for from the runs behind it,
 * and never blocks a slot it could not use.
 *
 * When a box may be used: its window (`window: "00:00-08:00"`, this
 * machine's local time, may wrap past midnight) and its switch (`enabled`,
 * on unless set false). Outside its window, or turned off, a box gets no
 * new slot and Den makes no contact with it at all: no check, no doctor
 * read. A run already holding a slot on it finishes. A fragile box can
 * keep its own `recheck_seconds`: the least time between two contacts
 * while it says no (box_recheck_seconds when unset).
 *
 * Nothing here holds a secret: ssh names a key file, never its contents.
 */
import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { connect as tlsConnect } from "tls";
import { writeFileAtomic } from "../atomic-write.js";
import {
  clockText,
  glob,
  inWindow,
  items,
  parseWindow,
  windowHeld,
  windowOpens,
} from "./classes.js";
import {
  loadHold,
  memoryHold,
  localRoom,
  queueOrder,
  type GateEntry,
  type GateSettings,
} from "./rules.js";

export const BOX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A test box as the person sets it up (settings.json, snake_case). */
export interface GateBox {
  name: string;
  /** ssh destination, `user@host` or `host` (keys only: BatchMode). */
  ssh?: string;
  ssh_port?: number;
  /** A key file's path (a reference; Den never reads its contents). */
  ssh_identity?: string;
  /** The box's Playwright server, ws:// or wss://: a run gets DEN_PW_WS. */
  playwright?: string;
  /** Browser runs the box takes at once. */
  browser_slots: number;
  /** A file on the box that, while present, stops new slots (ssh only). */
  hold_file?: string;
  /** Its browsers take this many times as long as this machine's. */
  time_scale?: number;
  /** Clause 8: no slot while the box has less free memory (MB). */
  min_free_mem_mb?: number;
  /** Clause 11: the box's Playwright server version; a client must match. */
  playwright_version?: string;
  /**
   * Issue 1017: the box's Playwright servers, version → ws:// or wss://
   * address ("1.61" serves any 1.61.x client). A run gets the one whose
   * version matches its own. Instead of `playwright` and
   * `playwright_version`, which stay as they were for a box with one.
   */
  playwright_endpoints?: Record<string, string>;
  /** When it may be used, "HH:MM-HH:MM" in this machine's local time. */
  window?: string;
  /** false: turned off, no slot and no contact. Absent: on. */
  enabled?: boolean;
  /** Least seconds between contacts while it says no (else the global). */
  recheck_seconds?: number;
}

export const BOX_LIMITS = {
  browser_slots: { min: 1, max: 64 },
  ssh_port: { min: 1, max: 65535 },
  time_scale: { min: 1, max: 10 },
  min_free_mem_mb: { min: 0, max: 1024 * 1024 },
  recheck_seconds: { min: 1, max: 24 * 3600 },
} as const;

/** Clause 8: free memory a box keeps by default (MB). */
export const BOX_MIN_FREE_MEM_MB = 2048;

/** Clause 12: a box check never takes longer than this, whatever is set. */
export const BOX_CHECK_CAP_MS = 25_000;

const PW_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,40})?$/;
/** Issue 1017: an endpoint's version: major.minor, or a full version. */
const PW_ENDPOINT_VERSION =
  /^\d{1,4}\.\d{1,4}(?:\.\d{1,4}(?:-[A-Za-z0-9.-]{1,40})?)?$/;

/**
 * Issue 1017: whether an endpoint's version serves a client's: the same,
 * or one names the other's major.minor (1.61 serves 1.61.2).
 */
export function pwServes(endpoint: string, client: string): boolean {
  return (
    endpoint === client ||
    client.startsWith(endpoint + ".") ||
    endpoint.startsWith(client + ".")
  );
}

/**
 * Issue 1017: a box's Playwright endpoints, in the order set. A box with
 * one (`playwright`, maybe `playwright_version`) reads as a list of one,
 * so a settings.json written before keeps working as it is; nothing is
 * rewritten.
 */
export function boxEndpoints(
  b: Pick<
    GateBox,
    "playwright" | "playwright_version" | "playwright_endpoints"
  >,
): { version?: string; ws: string }[] {
  if (b.playwright_endpoints)
    return Object.entries(b.playwright_endpoints).map(([version, ws]) => ({
      version,
      ws,
    }));
  return b.playwright
    ? [
        {
          ...(b.playwright_version ? { version: b.playwright_version } : {}),
          ws: b.playwright,
        },
      ]
    : [];
}

/**
 * The endpoint a run with this client version gets on the box: the one
 * whose version serves it; with no version, none. A one-endpoint box
 * gives its one address, as before.
 */
export function boxEndpointFor(
  b: Pick<
    GateBox,
    "playwright" | "playwright_version" | "playwright_endpoints"
  >,
  pwVersion?: string,
): string | undefined {
  if (!b.playwright_endpoints) return b.playwright;
  // An unknown version gets none: which server it needs can't be said.
  if (!pwVersion) return undefined;
  return boxEndpoints(b).find((x) => pwServes(x.version!, pwVersion))?.ws;
}

/**
 * Clause 11: why a run can't use a box's browser (its Playwright client
 * isn't the box server's version), or "" when it can. Issue 1017: a box
 * with several endpoints is skipped only when none serves the client.
 */
export function boxSkipReason(
  e: { pwVersion?: string },
  b: Pick<GateBox, "playwright_version" | "playwright_endpoints">,
): string {
  return versionSkip(
    e.pwVersion,
    b.playwright_endpoints
      ? { versions: Object.keys(b.playwright_endpoints) }
      : { version: b.playwright_version },
  );
}

/** boxSkipReason over what a BoxCap carries (one version, or several). */
function versionSkip(
  client: string | undefined,
  b: { version?: string; versions?: string[] },
): string {
  // A box with one address checks no unknown version, as before; one with
  // several can't pick a server for it.
  if (!client)
    return b.versions ? "Playwright version unknown: pass --pw-version" : "";
  if (b.versions)
    return b.versions.some((v) => pwServes(v, client))
      ? ""
      : `client ${client}: box serves ${b.versions.join(", ")}`;
  // Issue 1033: Playwright's remote connect needs the same major.minor
  // only, so a 1.61.0 client takes a box that declares 1.61.1.
  return b.version && majorMinor(client) !== majorMinor(b.version)
    ? `client ${client} ≠ server ${b.version}`
    : "";
}

/** Issue 1033: a version's major.minor ("1.61.2" → "1.61"). */
const majorMinor = (v: string) =>
  v.split("-")[0]!.split(".").slice(0, 2).join(".");

/** A ws:// or wss:// address with a host and no login; or what is wrong. */
function wsProblem(pw: string): string {
  let u: URL | null = null;
  try {
    u = new URL(pw);
  } catch {
    /* below */
  }
  if (!u || (u.protocol !== "ws:" && u.protocol !== "wss:") || !u.hostname)
    return "is a ws:// or wss:// address";
  if (u.username || u.password) return "address carries no login or password";
  return "";
}

/** Box settings: how long a check may take, and how long a no is kept. */
export interface BoxSettings {
  boxCheckTimeoutSeconds: number;
  boxRecheckSeconds: number;
}

export const BOX_DEFAULTS: BoxSettings = {
  boxCheckTimeoutSeconds: 8,
  boxRecheckSeconds: 30,
};

const SSH_DEST = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
/** A plain path: no option dash, no quote, no glob, no control character. */
// eslint-disable-next-line no-control-regex
const PLAIN_PATH = /^(?!-)[^"'*?[\]\u0000-\u001f\u007f]{1,512}$/;

/** A box from the web, the CLI or the file, checked; or what is wrong. */
export function checkBox(
  v: unknown,
): { ok: true; box: GateBox } | { ok: false; error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { ok: false, error: "a box is an object" };
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!BOX_NAME_RE.test(name))
    return {
      ok: false,
      error:
        "a box's name is letters, digits, dot, dash or underscore (at most 64)",
    };
  const box: GateBox = { name, browser_slots: 1 };
  const str = (k: string) =>
    typeof o[k] === "string" && (o[k] as string).trim()
      ? (o[k] as string).trim()
      : undefined;
  const ssh = str("ssh");
  if (ssh !== undefined) {
    if (!SSH_DEST.test(ssh))
      return {
        ok: false,
        error: `box ${name}: ssh is login@host or host (no options)`,
      };
    box.ssh = ssh;
  }
  const pw = str("playwright");
  if (pw !== undefined) {
    const bad = wsProblem(pw);
    if (bad)
      return {
        ok: false,
        error: `box ${name}: playwright ${bad}`,
      };
    box.playwright = pw;
  }
  // Issue 1017: several Playwright servers, version → address.
  const eps = o.playwright_endpoints;
  if (eps !== undefined && eps !== null) {
    if (typeof eps !== "object" || Array.isArray(eps))
      return {
        ok: false,
        error: `box ${name}: playwright_endpoints is version → ws:// address`,
      };
    const list = Object.entries(eps as Record<string, unknown>);
    if (!list.length)
      return {
        ok: false,
        error: `box ${name}: playwright_endpoints names at least one version`,
      };
    if (box.playwright || str("playwright_version") !== undefined)
      return {
        ok: false,
        error: `box ${name}: give playwright_endpoints, or playwright (and playwright_version), not both`,
      };
    const map: Record<string, string> = {};
    for (const [v, ws] of list) {
      const version = v.trim();
      if (!PW_ENDPOINT_VERSION.test(version))
        return {
          ok: false,
          error: `box ${name}: playwright_endpoints: ${version.slice(0, 48)} is not a version like 1.61 or 1.61.0`,
        };
      const bad =
        typeof ws === "string" && ws.trim()
          ? wsProblem(ws.trim())
          : "is a ws:// or wss:// address";
      if (bad)
        return {
          ok: false,
          error: `box ${name}: playwright_endpoints ${version} ${bad}`,
        };
      map[version] = (ws as string).trim();
    }
    box.playwright_endpoints = map;
  }
  if (!box.ssh && !box.playwright && !box.playwright_endpoints)
    return {
      ok: false,
      error: `box ${name}: say how Den reaches it (ssh, or a playwright address)`,
    };
  for (const k of ["ssh_identity", "hold_file"] as const) {
    const p = str(k);
    if (p === undefined) continue;
    if (!PLAIN_PATH.test(p))
      return {
        ok: false,
        error: `box ${name}: ${k} is a plain path (no quotes, wildcards or leading dash)`,
      };
    box[k] = p;
  }
  if (box.hold_file && !box.ssh)
    return {
      ok: false,
      error: `box ${name}: a hold file is read over ssh; set ssh too`,
    };
  const pv = str("playwright_version");
  if (pv !== undefined) {
    if (!PW_VERSION.test(pv))
      return {
        ok: false,
        error: `box ${name}: playwright_version is a version like 1.48.0`,
      };
    box.playwright_version = pv;
  }
  const win = o.window;
  if (typeof win === "string" && win.trim()) {
    const w = parseWindow(win);
    if (!w)
      return {
        ok: false,
        error: `box ${name}: window is HH:MM-HH:MM, this machine's time (like 00:00-08:00)`,
      };
    if (w.from === w.to)
      return {
        ok: false,
        error: `box ${name}: its window opens and closes at the same time`,
      };
    box.window = `${clockText(w.from)}-${clockText(w.to)}`;
  } else if (win !== undefined && win !== null && win !== "")
    return {
      ok: false,
      error: `box ${name}: window is HH:MM-HH:MM, this machine's time (like 00:00-08:00)`,
    };
  if (o.enabled !== undefined && o.enabled !== null) {
    if (typeof o.enabled !== "boolean")
      return { ok: false, error: `box ${name}: enabled is true or false` };
    // Only "off" is written: an old box, and one turned on, look the same.
    if (!o.enabled) box.enabled = false;
  }
  for (const k of [
    "browser_slots",
    "ssh_port",
    "time_scale",
    "min_free_mem_mb",
    "recheck_seconds",
  ] as const) {
    const x = o[k];
    if (x === undefined || x === null) continue;
    const l = BOX_LIMITS[k];
    if (
      typeof x !== "number" ||
      !Number.isFinite(x) ||
      x < l.min ||
      x > l.max ||
      (k !== "time_scale" && !Number.isInteger(x))
    )
      return {
        ok: false,
        error: `box ${name}: ${k} is ${k === "time_scale" ? "a number" : "a whole number"} from ${l.min} to ${l.max}`,
      };
    box[k] = x;
  }
  return { ok: true, box };
}

/** The boxes a settings.json holds; a malformed one is left out. */
export function boxesOf(raw: unknown): GateBox[] {
  if (!Array.isArray(raw)) return [];
  const out: GateBox[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const c = checkBox(v);
    if (!c.ok || seen.has(c.box.name)) continue;
    seen.add(c.box.name);
    out.push(c.box);
  }
  return out;
}

/**
 * Why a box takes no slot and gets no contact now, or null when it may be
 * used: turned off, or outside its window (with when it opens: "HH:MM",
 * this machine's time, and the moment).
 */
export type BoxOff =
  | { why: "off" }
  | { why: "window"; opens: string; opensAt: number };

export function boxOff(
  box: Pick<GateBox, "enabled" | "window">,
  now: number,
): BoxOff | null {
  if (box.enabled === false) return { why: "off" };
  const w = box.window ? parseWindow(box.window) : undefined;
  if (!w || w.from === w.to || inWindow(w, now)) return null;
  return {
    why: "window",
    opens: clockText(w.from),
    opensAt: windowOpens(w, now),
  };
}

/** Least seconds between two contacts while a box says no. */
export function boxRecheckSeconds(
  box: Pick<GateBox, "recheck_seconds">,
  s: Pick<BoxSettings, "boxRecheckSeconds">,
): number {
  return box.recheck_seconds ?? s.boxRecheckSeconds;
}

/** What the last check of a box found. */
export interface BoxState {
  /**
   * Clause 8: "low", the box has less free memory than it keeps. Issue
   * 857: "unknown", its free memory couldn't be read (never free).
   */
  state: "open" | "held" | "unreachable" | "low" | "unknown";
  /** Why it takes no slot (held, unreachable), in words. */
  reason?: string;
  /** When it was checked (ISO). */
  at: string;
}

/** A box as the queue sees it at one assignment. */
export interface BoxCap {
  name: string;
  slots: number;
  /** Checked just now and open: a slot on it may be given. */
  open: boolean;
  /** Clause 11: its Playwright server's version, when set. */
  version?: string;
  /** Issue 1017: the versions its endpoints serve, when it lists several. */
  versions?: string[];
}

/** Issue 1017: a box as one assignment sees it (BoxCap), from its settings. */
export function boxCapOf(b: GateBox, open: boolean): BoxCap {
  return {
    name: b.name,
    slots: b.browser_slots,
    open,
    ...(b.playwright_endpoints
      ? { versions: Object.keys(b.playwright_endpoints) }
      : b.playwright_version
        ? { version: b.playwright_version }
        : {}),
  };
}

/**
 * Where a waiter may run: "local", or the boxes it may take. A box whose
 * Playwright server isn't the run's client version is never one (clause
 * 11), and the waiter doesn't hold it from the runs behind it.
 */
function placesOf(e: GateEntry, boxes: BoxCap[]): string[] {
  if (e.kind !== "browser") return ["local"];
  const w = e.where ?? "local";
  if (w === "local") return ["local"];
  // Issue 1033: a default pick names the boxes that can serve it.
  const fits = boxes.filter(
    (b) =>
      !versionSkip(e.pwVersion, b) &&
      (!e.onlyBoxes || e.onlyBoxes.includes(b.name)),
  );
  if (w === "any") return ["local", ...fits.map((b) => b.name)];
  return fits.some((b) => b.name === w) ? [w] : [];
}

/**
 * Issue 625: which waiters start now, and where (`box` absent: this
 * machine). With no boxes it gives exactly what `grants` gives. A browser
 * run that may go anywhere takes this machine first, then the first open
 * box with a free slot. A waiter that can't start keeps every slot it
 * waits for from the waiters of its kind behind it (first come, first
 * served, in each kind's line: issue 751), and leaves the others free.
 * This machine's room is `localRoom` (rules.ts): cpu runs beside a browser
 * run up to the beside count; a browser run on a box holds no room here.
 * Issue 803: a waiter its class's window holds back is passed over and
 * holds no slot from the runs behind it.
 * Issue 1009: `load` is the machine's 5-minute load; at or above
 * cpuHoldLoad under a release browser run, cpu waiters are passed over.
 */
export function assign(
  entries: GateEntry[],
  s: Pick<GateSettings, "cpuSlots"> &
    Partial<
      Pick<
        GateSettings,
        | "cpuSlotsBesideBrowser"
        | "cpuSlotsBesideReleaseBrowser"
        | "localBrowserSlots"
        | "priorityMax"
        | "priorityPassLimitMinutes"
        | "classes"
        | "cpuHoldLoad"
        | "loadHoldPerCore"
        | "memoryFreeMinPercent"
      >
    >,
  now: number,
  boxes: BoxCap[] = [],
  load?: number,
  cores?: number,
  /** Issue 1274: this machine's free memory, percent. */
  freeMem?: number,
): { id: string; box?: string }[] {
  const holders = entries.filter((e) => e.grantedAt);
  const room = localRoom(entries, s);
  const used: Record<string, number> = {};
  for (const h of holders) if (h.box) used[h.box] = (used[h.box] ?? 0) + 1;
  // Issue 751: this machine is reserved per kind; a box is browser only.
  const key = (place: string, kind: GateEntry["kind"]) =>
    place === "local" ? `local:${kind}` : place;
  const reserved = new Set<string>();
  const out: { id: string; box?: string }[] = [];
  const cap = (n: string) => boxes.find((b) => b.name === n);
  // Issue 1274: low memory here: new runs here wait; boxes still take theirs.
  const memHeld = !!memoryHold(entries, s, freeMem);
  const free = (place: string, w: GateEntry): boolean => {
    if (reserved.has(key(place, w.kind))) return false;
    if (place === "local") return !memHeld && room.fits(w);
    const b = cap(place);
    return !!b && b.open && (used[place] ?? 0) < b.slots;
  };
  const held = windowHeld(entries, s.classes, now);
  // Issues 1009, 1048: a loaded machine: plain cpu asks wait; a release
  // one goes through.
  const cpuHeld = !!loadHold(entries, s, load, cores);
  for (const w of queueOrder(entries, s, now)) {
    if (held.has(w.id)) continue; // issue 803: it waits for its window
    if (cpuHeld && w.kind === "cpu" && !w.priority) continue;
    const places = placesOf(w, boxes);
    const at = places.find((p) => free(p, w));
    if (at === undefined) {
      for (const p of places) reserved.add(key(p, w.kind));
      if (places.includes("local")) room.wait(w);
      continue;
    }
    if (at === "local") {
      room.take(w);
      out.push({ id: w.id });
    } else {
      used[at] = (used[at] ?? 0) + 1;
      out.push({ id: w.id, box: at });
    }
  }
  return out;
}

/**
 * The boxes a waiter would be given a slot on now, if each were open:
 * the ones to check before the next assignment.
 */
export function boxesWanted(
  entries: GateEntry[],
  s: Pick<GateSettings, "cpuSlots"> &
    Partial<
      Pick<
        GateSettings,
        | "cpuSlotsBesideBrowser"
        | "cpuSlotsBesideReleaseBrowser"
        | "localBrowserSlots"
        | "priorityMax"
        | "priorityPassLimitMinutes"
        | "classes"
      >
    >,
  now: number,
  boxes: BoxCap[],
): string[] {
  const asIfOpen = boxes.map((b) => ({ ...b, open: true }));
  const got = new Set<string>();
  for (const a of assign(entries, s, now, asIfOpen)) if (a.box) got.add(a.box);
  return [...got];
}

/** What one check of a box says. */
export type BoxProbe = (
  box: GateBox,
  timeoutMs: number,
) => Promise<{
  state: BoxState["state"];
  reason?: string;
  /** Clause 8: the box's available memory (MB), when it could be read. */
  freeMemMb?: number;
}>;

/**
 * Clause 8: an open answer with less free memory than the box keeps is
 * "low", and gives no slot.
 */
export function withMemory(
  box: GateBox,
  r: Awaited<ReturnType<BoxProbe>>,
): Awaited<ReturnType<BoxProbe>> {
  const min = box.min_free_mem_mb ?? BOX_MIN_FREE_MEM_MB;
  if (r.state !== "open" || r.freeMemMb === undefined || r.freeMemMb >= min)
    return r;
  return {
    state: "low",
    reason: `box low on memory: ${Math.floor(r.freeMemMb)} MB free, needs ${min} MB`,
    freeMemMb: r.freeMemMb,
  };
}

const oneLine = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, 200);

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * The check of a box's Playwright server: a WebSocket upgrade (an HTTP GET
 * with Upgrade: websocket), open only on "101 Switching Protocols" with
 * the right Sec-WebSocket-Accept. A bare TCP connect isn't enough: a relay
 * or port forward in front of a dead server still accepts it. The socket
 * is closed as soon as the answer's head is read, and never later than
 * the check's time (capped at BOX_CHECK_CAP_MS). No frame is ever sent.
 */
function wsReach(
  u: URL,
  timeoutMs: number,
): Promise<{ state: BoxState["state"]; reason?: string }> {
  const tls = u.protocol === "wss:";
  const port = Number(u.port) || (tls ? 443 : 80);
  const capMs = Math.max(1, Math.min(timeoutMs, BOX_CHECK_CAP_MS));
  const key = randomBytes(16).toString("base64");
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  const where = `${u.hostname}:${port}`;
  return new Promise((resolve) => {
    const sock: net.Socket = tls
      ? tlsConnect({ host: u.hostname, port, servername: u.hostname })
      : net.connect({ host: u.hostname, port });
    let head = "";
    let settled = false;
    const done = (v: { state: BoxState["state"]; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(
      () =>
        done({
          state: "unreachable",
          reason: `no websocket upgrade from ${where} in ${Math.max(1, Math.round(capMs / 1000))} s`,
        }),
      capMs,
    );
    sock.once(tls ? "secureConnect" : "connect", () => {
      const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
      sock.write(
        `GET ${u.pathname || "/"}${u.search} HTTP/1.1\r\n` +
          `Host: ${host}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    sock.on("data", (d: Buffer) => {
      head += d.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0 && head.length < 8192) return;
      const lines = head.slice(0, end < 0 ? 8192 : end).split("\r\n");
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "")?.[1];
      const got = lines
        .map((l) => /^sec-websocket-accept:\s*(\S+)/i.exec(l)?.[1])
        .find(Boolean);
      if (status === "101" && got === accept) return done({ state: "open" });
      done({
        state: "unreachable",
        reason: oneLine(
          status === "101"
            ? `${where}: a websocket upgrade with the wrong accept key`
            : `${where}: no websocket upgrade (${lines[0] || "no answer"})`,
        ),
      });
    });
    sock.once("end", () =>
      done({
        state: "unreachable",
        reason: `${where}: no websocket upgrade (closed without an answer)`,
      }),
    );
    sock.once("error", (e) =>
      done({
        state: "unreachable",
        reason: oneLine(`${where}: ${e.message}`),
      }),
    );
  });
}

/** Clause 8: MemAvailable (MB) from a /proc/meminfo text, if there. */
export function memAvailableMb(text: string): number | undefined {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) / 1024 : undefined;
}

/**
 * Issue 857: free memory on macOS (MB) from `vm_stat` and, after it,
 * `sysctl -n hw.pagesize`: free + inactive + speculative pages times the
 * page size (sysctl's, else the one in vm_stat's header). Undefined when
 * the text isn't that: memory unknown, never free.
 */
export function macFreeMb(text: string): number | undefined {
  const pages = (label: string) => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const free = pages("free");
  if (free === undefined) return undefined;
  const sysctl = /^\s*(\d{3,7})\s*$/m.exec(text)?.[1];
  const header = /page size of (\d+) bytes/.exec(text)?.[1];
  const size = Number(sysctl ?? header);
  if (!Number.isInteger(size) || size < 512) return undefined;
  const n = free + (pages("inactive") ?? 0) + (pages("speculative") ?? 0);
  return (n * size) / (1024 * 1024);
}

/** Issue 857: the one command a macOS box runs for its memory. */
export const MAC_MEM_COMMAND =
  "/usr/bin/vm_stat && /usr/sbin/sysctl -n hw.pagesize";

/** One process, its output, killed at the time given. */
function runOnce(
  start: typeof spawn,
  cmd: string,
  args: string[],
  stdin: string,
  capMs: number,
): Promise<{
  code: number | null;
  out: string;
  err: string;
  failed?: string;
  timedOut?: boolean;
}> {
  return new Promise((resolve) => {
    let err = "";
    let out = "";
    let settled = false;
    const finish = (v: Awaited<ReturnType<typeof runOnce>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const k = start(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      k.kill("SIGKILL");
      finish({ code: null, out, err, timedOut: true });
    }, capMs);
    k.stdout?.on("data", (d: Buffer) => {
      if (out.length < 65536) out += d.toString("utf-8");
    });
    k.stderr?.on("data", (d: Buffer) => {
      if (err.length < 4096) err += d.toString("utf-8");
    });
    k.on("error", (e: Error) =>
      finish({ code: null, out, err, failed: e.message }),
    );
    k.on("close", (code: number | null) => finish({ code, out, err }));
    k.stdin?.end(stdin);
  });
}

/**
 * The check over ssh, with the process starter given (tests pass a
 * stub). It is one sftp read: `ls` of the hold file, and the box's
 * /proc/meminfo (clause 8); the box runs nothing for it. Issue 857: a
 * box with no /proc/meminfo (macOS) is then read with one ssh exec of
 * MAC_MEM_COMMAND, nothing else. Memory that can't be read is "unknown":
 * the box is skipped with that reason, never counted as free (unless it
 * keeps no free memory: min_free_mem_mb 0). Keys only (BatchMode): a box
 * that asks for a password is unreachable. Clause 12: the whole check is
 * killed at the time given, and never later than BOX_CHECK_CAP_MS, so an
 * ssh that connects but stalls at the banner is unreachable and never
 * hangs its callers.
 */
export function sftpProbe(start: typeof spawn): BoxProbe {
  return async (box, timeoutMs) => {
    // Issue 1017: with several Playwright servers, the first is reached.
    // Issue 625: by a WebSocket upgrade, never a bare TCP connect.
    if (!box.ssh) return wsReach(new URL(boxEndpoints(box)[0]!.ws), timeoutMs);
    const capMs = Math.max(1, Math.min(timeoutMs, BOX_CHECK_CAP_MS));
    const deadline = Date.now() + capMs;
    const secs = Math.max(1, Math.round(capMs / 1000));
    const conn = (port: string) => [
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${secs}`,
      ...(box.ssh_port ? [port, String(box.ssh_port)] : []),
      ...(box.ssh_identity ? ["-i", box.ssh_identity] : []),
      "--",
      box.ssh!,
    ];
    const noAnswer = {
      state: "unreachable" as const,
      reason: `no answer over ssh in ${secs} s`,
    };
    // A leading "-" lets the batch go on when a file is absent.
    const r = await runOnce(
      start,
      "sftp",
      ["-q", "-b", "-", ...conn("-P")],
      (box.hold_file ? `-ls "${box.hold_file}"\n` : "") +
        "-get /proc/meminfo /dev/stdout\n",
      capMs,
    );
    if (r.timedOut) return noAnswer;
    if (r.failed)
      return { state: "unreachable", reason: oneLine(`sftp: ${r.failed}`) };
    if (r.code !== 0)
      return {
        state: "unreachable",
        reason:
          oneLine(r.err.split("\n").filter(Boolean).pop() ?? "") ||
          `ssh to ${box.ssh} failed (exit ${r.code})`,
      };
    const missing = r.err
      .split("\n")
      .filter((l) => /not found|no such file/i.test(l));
    const noMeminfo = missing.some((l) => l.includes("/proc/meminfo"));
    const holdGone = missing.some((l) => !l.includes("/proc/meminfo"));
    let freeMemMb = memAvailableMb(r.out);
    const mem = () => (freeMemMb === undefined ? {} : { freeMemMb });
    if (box.hold_file && !holdGone)
      return {
        state: "held",
        reason: `its hold file (${box.hold_file}) is there`,
        ...mem(),
      };
    if ((box.min_free_mem_mb ?? BOX_MIN_FREE_MEM_MB) <= 0)
      return { state: "open", ...mem() };
    let why = "/proc/meminfo has no MemAvailable";
    if (freeMemMb === undefined && noMeminfo) {
      // Issue 857: no /proc (macOS): one fixed command, nothing else.
      const left = deadline - Date.now();
      if (left <= 0) return noAnswer;
      const m = await runOnce(
        start,
        "ssh",
        ["-T", ...conn("-p"), MAC_MEM_COMMAND],
        "",
        left,
      );
      if (m.timedOut) return noAnswer;
      freeMemMb = m.code === 0 ? macFreeMb(m.out) : undefined;
      why =
        m.code === 0
          ? "vm_stat gave nothing Den can read"
          : oneLine(
              `vm_stat failed: ${m.failed ?? (m.err.split("\n").filter(Boolean).pop() || `exit ${m.code}`)}`,
            );
    }
    if (freeMemMb === undefined)
      return { state: "unknown", reason: `memory unknown: ${why}` };
    return { state: "open", ...mem() };
  };
}

export const realBoxProbe: BoxProbe = sftpProbe(spawn);

/** The box states file (in the gate directory). */
export function readBoxStates(dir: string): Record<string, BoxState> {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(dir, "boxes-state.json"), "utf-8"),
    ) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, BoxState>)
      : {};
  } catch {
    return {};
  }
}

export function writeBoxStates(
  dir: string,
  states: Record<string, BoxState>,
): void {
  writeFileAtomic(
    path.join(dir, "boxes-state.json"),
    JSON.stringify(states, null, 2) + "\n",
  );
}

/** A held or unreachable answer still within the recheck time. */
export function freshNo(
  st: BoxState | undefined,
  now: number,
  recheckSeconds: number,
): boolean {
  return (
    !!st &&
    st.state !== "open" &&
    now - Date.parse(st.at) < recheckSeconds * 1000
  );
}

/** An open answer not yet used, within the recheck time. */
export function freshYes(
  st: BoxState | undefined,
  now: number,
  recheckSeconds: number,
): boolean {
  return (
    !!st &&
    st.state === "open" &&
    now - Date.parse(st.at) < recheckSeconds * 1000
  );
}

/**
 * What the environment of a run that got a box's slot says. Issue 1017:
 * DEN_PW_WS is the endpoint that serves the run's Playwright version.
 */
export function boxEnv(
  box: GateBox,
  pwVersion?: string,
): Record<string, string> {
  const ws = boxEndpointFor(box, pwVersion);
  return {
    DEN_GATE_BOX: box.name,
    DEN_GATE_TIME_SCALE: String(box.time_scale ?? 1),
    // Issue 1033: the box's browser reaches this machine's ports only
    // through a client that exposes the loopback; pw-guard reads this.
    ...(ws ? { DEN_PW_WS: ws, DEN_PW_EXPOSE: "<loopback>" } : {}),
    ...(box.ssh ? { DEN_GATE_BOX_SSH: box.ssh } : {}),
  };
}

/** Issue 1033: one host-only rule: a project, or a label pattern. */
type HostOnlyRule = { project?: string; label?: string; text: string };

/**
 * Issue 1033: "den, label:*webkit*" (browser_host_only) → the rules; or
 * what is wrong. A project by name (* is every project), a label by
 * pattern (* matches any text), as class_map names them.
 */
export function parseHostOnly(s: string): HostOnlyRule[] | string {
  const out: HostOnlyRule[] = [];
  for (const it of items(s)) {
    if (it.length > 120 || it.includes("="))
      return `"${it.slice(0, 60)}" is not <project> or label:<pattern>`;
    if (it.startsWith("label:")) {
      const pattern = it.slice(6).trim();
      if (!pattern) return `"${it}" needs a label pattern`;
      out.push({ label: pattern, text: it });
    } else out.push({ project: it, text: it });
  }
  return out;
}

/** Issue 1033: the host-only rule a run matches, as written; else none. */
export function hostOnlyMatch(
  e: { project?: string; label: string },
  setting: string,
): HostOnlyRule | undefined {
  const rules = parseHostOnly(setting);
  if (typeof rules === "string") return undefined;
  return rules.find((r) =>
    r.label
      ? glob(r.label).test(e.label)
      : r.project === "*" || (!!e.project && r.project === e.project),
  );
}

/** Issue 1033: browser_box_default is any or local; null when it is. */
export function checkBoxDefault(v: string): string | null {
  const t = v.trim();
  return t === "any" || t === "local"
    ? null
    : `any or local, not ${t.slice(0, 40)}`;
}

/**
 * Issue 1033: where a browser `gate run` with no --box goes. With the
 * setting at any and a test box set: anywhere (`where` "any": the first
 * free browser slot, here or on a box), unless it can't or mustn't go to
 * a box; then it stays here, and `why` says so in one line. The setting
 * at local, or no box set: here, as before, with nothing to say.
 */
export function defaultPlace(o: {
  setting: "any" | "local";
  hostOnly: string;
  label: string;
  project?: string;
  boxes: GateBox[];
  /** The run gave --base-url (a box's browser reaches the app by it). */
  baseUrl: boolean;
  pwVersion?: string;
  /**
   * Issue 1033: the run brings its own browser (--browser-endpoint, or
   * one in its environment): why it stays here, in words.
   */
  ownBrowser?: string;
  /** Issue 625: the time a box's window is read at (now when unset). */
  now?: number;
}): {
  where?: "any";
  why?: string;
  /** The boxes it may take (where "any"), when some are skipped. */
  only?: string[];
  /** Those skipped, and why, in one line. */
  skipped?: string;
} {
  if (o.setting === "local" || !o.boxes.length) return {};
  const rule = hostOnlyMatch(o, o.hostOnly);
  if (rule)
    return {
      why: rule.label
        ? `${o.label} is host-only (browser_host_only ${rule.text})`
        : `project ${o.project ?? "*"} is host-only (browser_host_only ${rule.text})`,
    };
  if (o.ownBrowser) return { why: o.ownBrowser };
  if (!o.baseUrl)
    return { why: "no --base-url, so a test box can't reach the app" };
  // Issue 1033: which box server it needs can't be said; a box would
  // refuse it at connect (HTTP 428). Only an explicit --box takes one.
  if (!o.pwVersion)
    return {
      why: "this run's Playwright version is unknown: pass --pw-version",
    };
  const skips = o.boxes.map((b) => ({
    name: b.name,
    reason: defaultSkip(b, o.pwVersion, o.now ?? Date.now()),
  }));
  const said = skips
    .filter((x) => x.reason)
    .map((x) => x.reason)
    .join("; ");
  if (skips.every((x) => x.reason))
    return { why: oneLine(`no test box can take it: ${said}`) };
  if (!said) return { where: "any" };
  return {
    where: "any",
    only: skips.filter((x) => !x.reason).map((x) => x.name),
    skipped: oneLine(said),
  };
}

/**
 * Issue 1033: why a default pick can't send a run with --base-url to this
 * box, or "". Only an explicit --box <name> takes such a box (as before):
 *   no declared Playwright version (playwright_version or
 *     playwright_endpoints): its server refuses a client of another
 *     version (HTTP 428), and which one it runs can't be said;
 *   a declared version that doesn't serve the run's (clause 11);
 *   (issue 625) turned off, or outside its window: no slot comes, so a
 *     run with only that box stays here, saying when it opens.
 */
function defaultSkip(
  b: GateBox,
  pwVersion: string | undefined,
  now: number,
): string {
  const off = boxOff(b, now);
  if (off)
    return off.why === "off"
      ? `box ${b.name}: turned off`
      : `box ${b.name}: outside its window (opens ${off.opens})`;
  if (!b.playwright_version && !b.playwright_endpoints)
    return `box ${b.name} declares no Playwright version`;
  const v = boxSkipReason({ pwVersion }, b);
  return v ? `box ${b.name}: ${v}` : "";
}
