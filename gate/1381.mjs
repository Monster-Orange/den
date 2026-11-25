// gate/1381.mjs: a macOS gate host reads a Linux test box's memory (issue 1381).
// The machine's box list and queue are shared, so this check never adds a
// box to them or asks for a slot in them. For each box on this gate
// machine's own list that is reached over ssh (or those BG_1381_BOXES
// names), it copies how the machine reaches that box (ssh, port, key file,
// Playwright address, hold file: never the key itself) into a gate folder
// of its own (gate1381-*, in the OS temp dir), and runs the bed's CLI with
// DEN_GATE_DIR set to it for that run only. Two runs per box, each in a new
// folder:
//  - "low": the copy keeps more free memory than any box has, so its check
//    says "box low on memory: N MB free": the box's MemAvailable, as a number.
//  - "open": the box's own minimum; a `gate run --box` for it gets the box's
//    browser slot. The run is `true`, which never opens a browser, and the
//    grant is the proof (a grant clears the box's saved check).
// It counts the check's private den-box-* folders in the OS temp dir before
// and after. Teardown removes its gate folders. The box itself only answers
// ssh and sftp reads; nothing is started or stopped there.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const issue = 1381;
export const items = [1381];
export const clauses = [
  "from a macOS gate host, a Linux test box's MemAvailable is read as a number, not memory unknown",
  "the box is open and its browser slot is given to a run",
  "the private temp folder the read used is gone afterwards",
];
export const timeoutMs = 240000;

/**
 * More free memory than any box has (MB; the most a box may keep), so the
 * check reports the number.
 */
const HUGE_MB = 1024 * 1024;
const NAME = (box) => `gate1381-${box}`;

/** This gate machine's own gate folder, as Den finds it (no DEN_GATE_DIR). */
export function machineGateDir(env = process.env, platform = process.platform) {
  const home = env.HOME?.trim() || os.homedir();
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "den",
      "gate-slots",
    );
  const xdg = env.XDG_STATE_HOME?.trim();
  return path.join(
    xdg || path.join(home, ".local", "state"),
    "den",
    "gate-slots",
  );
}

/**
 * The boxes to check: those BG_1381_BOXES names (comma separated), else
 * every box on the gate machine's list that is reached over ssh.
 */
export function boxNames(env = process.env, list = []) {
  const raw = (env.BG_1381_BOXES ?? "").trim();
  if (raw)
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return list.filter((b) => b && b.ssh && b.name).map((b) => b.name);
}

/**
 * The copy of a machine box for this check's own folder: how it is reached,
 * one slot, and the given minimum. Null with why when it can't be used.
 */
export function copyOf(box, minFreeMb) {
  if (!box) return { why: "not on this gate machine's box list" };
  if (!box.ssh) return { why: "reached without ssh (no memory read to check)" };
  if (box.enabled === false) return { why: "turned off on this gate machine" };
  const c = {
    name: NAME(box.name),
    browser_slots: 1,
    ssh: box.ssh,
    ...(box.ssh_port ? { ssh_port: box.ssh_port } : {}),
    ...(box.ssh_identity ? { ssh_identity: box.ssh_identity } : {}),
    ...(box.playwright ? { playwright: box.playwright } : {}),
    ...(box.playwright_version
      ? { playwright_version: box.playwright_version }
      : {}),
    ...(box.playwright_endpoints
      ? { playwright_endpoints: box.playwright_endpoints }
      : {}),
    ...(box.hold_file ? { hold_file: box.hold_file } : {}),
  };
  if (minFreeMb !== undefined) c.min_free_mem_mb = minFreeMb;
  return { box: c };
}

/** A key path as ssh reads it: a leading ~/ is the home folder. */
export function expandHome(p, home = os.homedir()) {
  return p === "~"
    ? home
    : p.startsWith("~/")
      ? path.join(home, p.slice(2))
      : p;
}

/** The MB a "low on memory" reason names, or undefined. */
export function lowMb(reason) {
  const m = /box low on memory: (\d+) MB free/.exec(reason ?? "");
  return m ? Number(m[1]) : undefined;
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {
    return null;
  }
};

/** Whether the slot log has a browser slot granted on `name`. */
export function grantedOn(events, name) {
  return events.split("\n").some((l) => {
    try {
      const e = JSON.parse(l);
      return e.event === "granted" && e.machine === name;
    } catch {
      return false;
    }
  });
}

/** The check's private folders in the OS temp dir (den-box-*). */
function boxTemps() {
  try {
    return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("den-box-"));
  } catch {
    return [];
  }
}

export async function setup() {
  return { dirs: [] };
}

/** One run in a new gate folder holding only `box`. */
async function phase(ctx, state, box, wait) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate1381-"));
  state.dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ boxes: [box] }, null, 2) + "\n",
  );
  const before = boxTemps();
  const r = await ctx.cli(
    [
      "gate",
      "run",
      "--kind",
      "browser",
      "--box",
      box.name,
      "--base-url",
      "http://127.0.0.1:*",
      ...(box.playwright_version
        ? ["--pw-version", box.playwright_version]
        : []),
      "--label",
      "gate check 1381",
      "--",
      "true",
    ],
    { env: { DEN_GATE_DIR: dir }, timeout: wait },
  );
  const st = readJson(path.join(dir, "boxes-state.json")) ?? {};
  let events = "";
  try {
    events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf-8");
  } catch {
    // none written
  }
  const after = boxTemps();
  return {
    code: r.code,
    tail: `${r.out ?? ""}\n${r.err ?? ""}`
      .trim()
      .split("\n")
      .slice(-3)
      .join(" | "),
    state: st[box.name]?.state,
    reason: st[box.name]?.reason,
    granted: grantedOn(events, box.name),
    leftTemps: after.filter((n) => !before.includes(n)).length,
  };
}

export async function run(ctx, state) {
  if (process.platform !== "darwin")
    return {
      skip: "needs-macos-gate-host",
      detail: `this gate host is ${process.platform}`,
    };
  const gdir = machineGateDir();
  const machine = readJson(path.join(gdir, "settings.json"));
  const list = Array.isArray(machine?.boxes) ? machine.boxes : [];
  const out = { boxes: [] };
  for (const name of boxNames(process.env, list)) {
    const real = list.find((b) => b && b.name === name);
    const low = copyOf(real, HUGE_MB);
    if (!low.box) {
      out.boxes.push({ name, unusable: low.why });
      continue;
    }
    if (
      low.box.ssh_identity &&
      !fs.existsSync(expandHome(low.box.ssh_identity))
    ) {
      out.boxes.push({
        name,
        unusable: "its key file is missing on this gate machine",
      });
      continue;
    }
    const a = await phase(ctx, state, low.box, 30000);
    const open = copyOf(real, real.min_free_mem_mb);
    const b = await phase(ctx, state, open.box, 60000);
    out.boxes.push({ name, low: a, open: b, mb: lowMb(a.reason) });
  }
  fs.writeFileSync(
    ctx.evidence("1381-boxes.json"),
    JSON.stringify(out, null, 2),
  );
  return out;
}

export async function teardown(_ctx, state) {
  for (const d of state?.dirs ?? [])
    fs.rmSync(d, { recursive: true, force: true });
}

const row = (clause, ok, detail, skip) =>
  ok === null
    ? { clause, ok: null, skip, detail, evidence: ["1381-boxes.json"] }
    : { clause, ok, detail, evidence: ["1381-boxes.json"] };

// The harness passes a check with no matrix its result itself, one with
// a matrix its cells: either is read (the dev.2 bed's cells.find throw).
export function expect(cells) {
  const r =
    (Array.isArray(cells) ? cells.find((c) => c?.result)?.result : cells) ?? {};
  if (r.skip)
    return clauses.map((c) => row(c, null, r.detail ?? r.skip, r.skip));
  const tried = (r.boxes ?? []).filter((b) => !b.unusable);
  if (!tried.length) {
    const why = (r.boxes ?? [])
      .map((b) => `${b.name}: ${b.unusable}`)
      .join("; ");
    return clauses.map((c) =>
      row(
        c,
        null,
        `no box to check (${why || "none named"}); a person adds it on this gate machine with gate box add, or names others in BG_1381_BOXES`,
        "needs-test-box",
      ),
    );
  }
  const held = tried.filter(
    (b) => b.low.state === "held" || b.open.state === "held",
  );
  if (held.length === tried.length)
    return clauses.map((c) =>
      row(
        c,
        null,
        `every box was held (its hold file was there): ${held.map((b) => b.name).join(", ")}`,
        "needs-test-box-free",
      ),
    );
  const judged = tried.filter((b) => !held.includes(b));
  const say = (f) => judged.map((b) => `${b.name}: ${f(b)}`).join("; ");
  const unreachable = judged.filter((b) => b.low.state === "unreachable");
  if (unreachable.length === judged.length)
    return clauses.map((c) =>
      row(
        c,
        null,
        `this gate machine can't reach ${say((b) => b.low.reason ?? "no answer")}; a person checks this gate machine's ssh to it with its key`,
        "needs-test-box-reach",
      ),
    );
  const mem = judged.every(
    (b) => b.low.state === "low" && Number.isFinite(b.mb),
  );
  // A grant clears the box's saved state: the slot given is the proof.
  const open = judged.every((b) => b.open.granted && b.open.code === 0);
  const temps = judged.every(
    (b) => b.low.leftTemps === 0 && b.open.leftTemps === 0,
  );
  return [
    row(
      clauses[0],
      mem,
      say((b) =>
        Number.isFinite(b.mb)
          ? `MemAvailable ${b.mb} MB`
          : `${b.low.state ?? "not checked"}${b.low.reason ? ` (${b.low.reason})` : ""}`,
      ),
    ),
    row(
      clauses[1],
      open,
      say((b) =>
        b.open.granted
          ? `slot given, exit ${b.open.code}`
          : `no slot given (${b.open.state ?? "no check saved"}${b.open.reason ? `: ${b.open.reason}` : ""}), exit ${b.open.code}; ${b.open.tail ?? ""}`,
      ),
    ),
    row(
      clauses[2],
      temps,
      say(
        (b) =>
          `${b.low.leftTemps + b.open.leftTemps} den-box-* folder(s) left in ${os.tmpdir()}`,
      ),
    ),
  ];
}
