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
 * of the hold file, or a TCP connect to the Playwright server); nothing on
 * the box is run. An open answer is good for one assignment; a held or
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
 * Nothing here holds a secret: ssh names a key file, never its contents.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";
import { queueOrder, type GateEntry, type GateSettings } from "./rules.js";

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
}

export const BOX_LIMITS = {
  browser_slots: { min: 1, max: 64 },
  ssh_port: { min: 1, max: 65535 },
  time_scale: { min: 1, max: 10 },
} as const;

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
        error: `box ${name}: ssh is user@host or host (no options)`,
      };
    box.ssh = ssh;
  }
  const pw = str("playwright");
  if (pw !== undefined) {
    let u: URL | null = null;
    try {
      u = new URL(pw);
    } catch {
      /* below */
    }
    if (!u || (u.protocol !== "ws:" && u.protocol !== "wss:") || !u.hostname)
      return {
        ok: false,
        error: `box ${name}: playwright is a ws:// or wss:// address`,
      };
    if (u.username || u.password)
      return {
        ok: false,
        error: `box ${name}: playwright carries no user or password`,
      };
    box.playwright = pw;
  }
  if (!box.ssh && !box.playwright)
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
  for (const k of ["browser_slots", "ssh_port", "time_scale"] as const) {
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

/** What the last check of a box found. */
export interface BoxState {
  state: "open" | "held" | "unreachable";
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
}

/** Where a waiter may run: "local", or the boxes it may take. */
function placesOf(e: GateEntry, boxes: BoxCap[]): string[] {
  if (e.kind !== "browser") return ["local"];
  const w = e.where ?? "local";
  if (w === "local") return ["local"];
  if (w === "any") return ["local", ...boxes.map((b) => b.name)];
  return boxes.some((b) => b.name === w) ? [w] : [];
}

/**
 * Issue 625: which waiters start now, and where (`box` absent: this
 * machine). With no boxes it gives exactly what `grants` gives. A browser
 * run that may go anywhere takes this machine first, then the first open
 * box with a free slot. A waiter that can't start keeps every slot it
 * waits for from the waiters behind it (first come, first served), and
 * leaves the others free.
 */
export function assign(
  entries: GateEntry[],
  s: Pick<GateSettings, "cpuSlots"> &
    Partial<Pick<GateSettings, "priorityMax" | "priorityPassLimitMinutes">>,
  now: number,
  boxes: BoxCap[] = [],
): { id: string; box?: string }[] {
  const holders = entries.filter((e) => e.grantedAt);
  let browserHeld = holders.some((e) => e.kind === "browser" && !e.box);
  let cpuHeld = holders.filter((e) => e.kind === "cpu").length;
  const used: Record<string, number> = {};
  for (const h of holders) if (h.box) used[h.box] = (used[h.box] ?? 0) + 1;
  const reserved = new Set<string>();
  const out: { id: string; box?: string }[] = [];
  const cap = (n: string) => boxes.find((b) => b.name === n);
  const free = (place: string, kind: GateEntry["kind"]): boolean => {
    if (reserved.has(place)) return false;
    if (place === "local")
      return kind === "browser"
        ? !browserHeld && cpuHeld === 0
        : !browserHeld && cpuHeld < Math.max(1, s.cpuSlots);
    const b = cap(place);
    return !!b && b.open && (used[place] ?? 0) < b.slots;
  };
  for (const w of queueOrder(entries, s, now)) {
    const places = placesOf(w, boxes);
    const at = places.find((p) => free(p, w.kind));
    if (at === undefined) {
      for (const p of places) reserved.add(p);
      continue;
    }
    if (at === "local") {
      if (w.kind === "browser") browserHeld = true;
      else cpuHeld++;
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
    Partial<Pick<GateSettings, "priorityMax" | "priorityPassLimitMinutes">>,
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
) => Promise<{ state: BoxState["state"]; reason?: string }>;

const oneLine = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, 200);

/** A TCP connect to the box's Playwright server (nothing else is sent). */
function tcpReach(
  u: URL,
  timeoutMs: number,
): Promise<{ state: BoxState["state"]; reason?: string }> {
  const port = Number(u.port) || (u.protocol === "wss:" ? 443 : 80);
  return new Promise((resolve) => {
    const sock = net.connect({ host: u.hostname, port });
    const done = (v: { state: BoxState["state"]; reason?: string }) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () =>
      done({
        state: "unreachable",
        reason: `no answer from ${u.hostname}:${port} in ${Math.round(timeoutMs / 1000)} s`,
      }),
    );
    sock.once("connect", () => done({ state: "open" }));
    sock.once("error", (e) =>
      done({
        state: "unreachable",
        reason: oneLine(`${u.hostname}:${port}: ${e.message}`),
      }),
    );
  });
}

/**
 * The real check. Over ssh it is an sftp read (`ls` of the hold file, or
 * `pwd` with no hold file): the box runs nothing for it. Keys only
 * (BatchMode): a box that asks for a password is unreachable.
 */
export const realBoxProbe: BoxProbe = (box, timeoutMs) => {
  if (!box.ssh) return tcpReach(new URL(box.playwright!), timeoutMs);
  const secs = Math.max(1, Math.round(timeoutMs / 1000));
  const args = [
    "-q",
    "-b",
    "-",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${secs}`,
    ...(box.ssh_port ? ["-P", String(box.ssh_port)] : []),
    ...(box.ssh_identity ? ["-i", box.ssh_identity] : []),
    "--",
    box.ssh,
  ];
  return new Promise((resolve) => {
    let err = "";
    let settled = false;
    const finish = (v: { state: BoxState["state"]; reason?: string }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const k = spawn("sftp", args, { stdio: ["pipe", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      k.kill("SIGKILL");
      finish({
        state: "unreachable",
        reason: `no answer over ssh in ${secs} s`,
      });
    }, timeoutMs + 2000);
    k.stderr.on("data", (d: Buffer) => {
      if (err.length < 4096) err += d.toString("utf-8");
    });
    k.on("error", (e) => {
      clearTimeout(timer);
      finish({ state: "unreachable", reason: oneLine(`sftp: ${e.message}`) });
    });
    k.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0)
        return finish(
          box.hold_file
            ? {
                state: "held",
                reason: `its hold file (${box.hold_file}) is there`,
              }
            : { state: "open" },
        );
      if (box.hold_file && /not found|no such file/i.test(err))
        return finish({ state: "open" });
      finish({
        state: "unreachable",
        reason:
          oneLine(err.split("\n").filter(Boolean).pop() ?? "") ||
          `ssh to ${box.ssh} failed (exit ${code})`,
      });
    });
    k.stdin.end(box.hold_file ? `ls "${box.hold_file}"\n` : "pwd\n");
  });
};

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

/** What the environment of a run that got a box's slot says. */
export function boxEnv(box: GateBox): Record<string, string> {
  return {
    DEN_GATE_BOX: box.name,
    DEN_GATE_TIME_SCALE: String(box.time_scale ?? 1),
    ...(box.playwright ? { DEN_PW_WS: box.playwright } : {}),
    ...(box.ssh ? { DEN_GATE_BOX_SSH: box.ssh } : {}),
  };
}
