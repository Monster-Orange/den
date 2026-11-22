// gate/803.mjs: priority classes per project (issue 803).
// The machine's queue is shared, so this check never asks for a slot in
// it, and never changes the machine's gate settings. It makes two gate
// folders of its own (gate803-*, in the OS temp dir) and runs the bed's own
// CLI against each with DEN_GATE_DIR set for that run only. The first has
// classes set in its own settings.json: the issue's default example, P0 >
// P1 > P2 with the platform's release checks before its lane runs, and a
// window for P2's long runs that is shut now. The second has no classes.
// In each it writes the same browser holder (a `sleep` that ends in ~8 s)
// and six waiters held by sleeps this check starts. It reads the bed's
// `gate status` (text and --json) before and after the holder ends, the
// slot log the bed's CLI wrote, and the Settings words in en, es and ja.
// Teardown stops its sleeps and removes both folders.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const issue = 803;
// Issue 866 asked for this live check (803 shipped with unit tests only).
export const items = [803, 866];
export const clauses = [
  "a higher class goes first: a release entry asked after other entries starts before them",
  "two entries of the same class keep their order",
  "with no classes set, the queue is exactly first-come",
  "a granted slot is never taken back",
  "with a window set, a long lower-class run outside its window waits while a higher class waits",
  "within P0, a release entry starts before a P0 lane entry asked earlier, and both before any P1 entry",
  "gate status and the slot log show each entry's class, and the Settings rows are in en, es and ja",
];
export const timeoutMs = 120000;

const ID = {
  holder: "browser-803h",
  p1a: "browser-803a", // product, P1
  p1rel: "browser-803b", // product's own release check: stays P1
  p2long: "browser-803c", // other, P2, 60 min: windowed
  p0lane: "browser-803d", // platform, P0
  p0rel: "browser-803e", // platform's release check: P0-release
  p1c: "browser-803f", // product, P1, after the other two
};
const FIRST_COME = [ID.p1a, ID.p1rel, ID.p2long, ID.p0lane, ID.p0rel, ID.p1c];
const CLASSED = [ID.p0rel, ID.p0lane, ID.p1a, ID.p1rel, ID.p1c, ID.p2long];

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** A window for P2 that is shut now: it opens in 2 h, for 1 h (local). */
function shutWindow(now) {
  const at = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return `${at(now + 2 * 3600_000)}-${at(now + 3 * 3600_000)}`;
}

export async function setup() {
  const kids = [];
  const sleeper = (s) => {
    const pid = Number(
      execFileSync(
        "sh",
        ["-c", `sleep ${Number(s)} >/dev/null 2>&1 & echo $!`],
        { encoding: "utf-8" },
      ).trim(),
    );
    kids.push(pid);
    return pid;
  };
  const now = Date.now();
  const iso = (sec) => new Date(now - sec * 1000).toISOString();
  const folder = (settings) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate803-"));
    fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
    if (settings)
      fs.writeFileSync(
        path.join(dir, "settings.json"),
        JSON.stringify(settings, null, 2),
      );
    const slot = (id, o) =>
      fs.writeFileSync(
        path.join(dir, "slots", `${id}.json`),
        JSON.stringify({
          id,
          kind: "browser",
          who: `gate check 803 · ${o.label}`,
          estimateMin: 1,
          ...o,
        }),
      );
    slot(ID.holder, {
      label: "803-holder",
      project: "other",
      pid: sleeper(8),
      askedAt: iso(300),
      grantedAt: iso(300),
    });
    const w = (id, label, project, sec, extra = {}) =>
      slot(id, {
        label,
        project,
        pid: sleeper(110),
        askedAt: iso(sec),
        ...extra,
      });
    w(ID.p1a, "803-p1-lane", "product", 240);
    w(ID.p1rel, "release p1 803", "product", 210);
    w(ID.p2long, "803-p2-long", "other", 180, { estimateMin: 60 });
    w(ID.p0lane, "803-p0-lane", "platform", 150);
    w(ID.p0rel, "release check 803", "platform", 120);
    w(ID.p1c, "803-p1-second", "product", 90);
    return dir;
  };
  const classed = folder({
    class_order: "p0-release, p0, p1, p2",
    class_map:
      "platform label:release*=p0-release, platform=p0, product=p1, *=p2",
    class_windows: `p2=${shutWindow(now)}/30`,
  });
  const plain = folder(null);
  return { classed, plain, kids };
}

export async function run(ctx, state) {
  const status = async (dir) => {
    const j = await ctx.cli(["gate", "status", "--json"], {
      env: { DEN_GATE_DIR: dir },
      timeout: 30000,
    });
    const v = parse(j?.out ?? "");
    return {
      code: j?.code ?? null,
      tail: String(j?.err ?? j?.out ?? "").slice(-300),
      slots: Array.isArray(v?.slots) ? v.slots : [],
    };
  };
  const r = {};
  const c0 = await status(state.classed);
  r.ownDir = c0.slots.some((s) => s.id === ID.p0rel);
  r.statusCode = c0.code;
  if (!r.ownDir) {
    r.statusTail = c0.tail;
    return r;
  }
  r.before = c0.slots.map(({ id, granted, class: cls, window }) => ({
    id,
    granted,
    class: cls ?? null,
    window: window ?? null,
  }));
  const text = await ctx.cli(["gate", "status"], {
    env: { DEN_GATE_DIR: state.classed },
    timeout: 30000,
  });
  r.text = String(text?.out ?? "")
    .split("\n")
    .filter((l) => l.startsWith("browser-803"));
  const p0 = await status(state.plain);
  r.plain = p0.slots.map(({ id, granted, class: cls }) => ({
    id,
    granted,
    class: cls ?? null,
  }));
  // The holder's sleep ends; the next status settles and grants.
  r.afterGrant = [];
  r.plainAfter = [];
  if (typeof ctx.until === "function")
    await ctx.until(async () => {
      const s = await status(state.classed);
      r.afterGrant = s.slots.map(({ id, granted }) => ({ id, granted }));
      return s.slots.some((x) => x.granted && x.id !== ID.holder);
    }, 30000);
  r.plainAfter = (await status(state.plain)).slots.map(({ id, granted }) => ({
    id,
    granted,
  }));
  const log = (dir) => {
    try {
      return fs
        .readFileSync(path.join(dir, "events.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map(parse)
        .filter(Boolean)
        .map(({ at, event, id, class: cls }) => ({
          at,
          event,
          id,
          class: cls,
        }));
    } catch {
      return [];
    }
  };
  r.events = log(state.classed);
  r.words = {};
  for (const [lang, file] of [
    ["en", "/shell.js"],
    ["es", "/i18n/es.js"],
    ["ja", "/i18n/ja.js"],
  ]) {
    try {
      const res = await ctx.api(file);
      const body = res.ok ? await res.text() : "";
      r.words[lang] = [
        "gate_class_order",
        "gate_class_map",
        "gate_class_windows",
      ].every((k) => body.includes(`"set.server.${k}.d":`));
    } catch {
      r.words[lang] = false;
    }
  }
  fs.writeFileSync(
    ctx.evidence("803-classes.json"),
    JSON.stringify(r, null, 2),
  );
  return r;
}

export async function teardown(_ctx, state) {
  for (const pid of state?.kids ?? [])
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  for (const d of [state?.classed, state?.plain])
    if (d) fs.rmSync(d, { recursive: true, force: true });
}

export function expect(cells) {
  const r = (Array.isArray(cells) ? cells[0]?.result : cells) ?? {};
  if (!r.ownDir && r.statusCode !== 0)
    return clauses.map((clause) => ({
      clause,
      ok: false,
      detail: `the bed's \`gate status --json\` failed (exit ${r.statusCode}): ${r.statusTail ?? ""}`,
    }));
  if (!r.ownDir)
    return clauses.map((clause) => ({
      clause,
      ok: null,
      skip: "needs-cli-env",
      detail: `the bed's CLI didn't read this check's own gate folder (DEN_GATE_DIR for that run only); nothing was asked in the machine's queue. ${r.statusTail ?? ""}`,
    }));
  const waiting = (rows) =>
    (rows ?? []).filter((s) => !s.granted).map((s) => s.id);
  const seq = (a) => a.join(",");
  const order = waiting(r.before);
  const pos = (id) => order.indexOf(id);
  const by = (id) => (r.before ?? []).find((s) => s.id === id) ?? {};
  const firstGranted = (r.afterGrant ?? []).find(
    (s) => s.granted && s.id !== ID.holder,
  )?.id;
  const holderAtStart = by(ID.holder).granted === true;
  const grantRow = (r.events ?? []).find(
    (e) => e.event === "granted" && e.id === firstGranted,
  );
  const said = `waiting with classes: ${seq(order)}; the first granted after the holder: ${firstGranted ?? "none"}`;
  return [
    {
      clause: clauses[0],
      ok:
        pos(ID.p0rel) === 0 &&
        pos(ID.p0rel) < pos(ID.p1a) &&
        firstGranted === ID.p0rel,
      detail: said,
      evidence: ["803-classes.json"],
    },
    {
      clause: clauses[1],
      ok:
        pos(ID.p1a) < pos(ID.p1rel) &&
        pos(ID.p1rel) < pos(ID.p1c) &&
        pos(ID.p1a) >= 0,
      detail: `${said}; P1 in order: ${[ID.p1a, ID.p1rel, ID.p1c].map(pos).join(", ")}`,
      evidence: ["803-classes.json"],
    },
    {
      clause: clauses[2],
      ok:
        seq(waiting(r.plain)) === seq(FIRST_COME) &&
        (r.plain ?? []).every((s) => s.class === null) &&
        (r.plainAfter ?? []).some((s) => s.id === ID.p1a && s.granted),
      detail: `no classes: waiting ${seq(waiting(r.plain))}; classes shown: ${JSON.stringify((r.plain ?? []).map((s) => s.class))}; granted after the holder: ${JSON.stringify((r.plainAfter ?? []).filter((s) => s.granted))}`,
      evidence: ["803-classes.json"],
    },
    {
      clause: clauses[3],
      ok: holderAtStart && order.length === 6,
      detail: `the lower-class holder still holds while six higher or equal entries wait: ${holderAtStart}`,
      evidence: ["803-classes.json"],
    },
    {
      clause: clauses[4],
      ok:
        pos(ID.p2long) === order.length - 1 &&
        typeof by(ID.p2long).window === "string" &&
        by(ID.p2long).window.length > 0,
      detail: `the long P2 run is at place ${pos(ID.p2long) + 1} of ${order.length}, held for its window: ${JSON.stringify(by(ID.p2long).window)}`,
      evidence: ["803-classes.json"],
    },
    {
      clause: clauses[5],
      ok:
        seq(order) === seq(CLASSED) &&
        by(ID.p1rel).class === "p1" &&
        by(ID.p0rel).class === "p0-release",
      detail: `${said}; expected ${seq(CLASSED)}; the product's release check is in class ${by(ID.p1rel).class}`,
      evidence: ["803-classes.json"],
    },
    {
      clause: clauses[6],
      ok:
        (r.before ?? []).every((s) => typeof s.class === "string") &&
        (r.text ?? []).some((l) => l.includes("class p0-release")) &&
        grantRow?.class === "p0-release" &&
        r.words?.en === true &&
        r.words?.es === true &&
        r.words?.ja === true,
      detail: `--json classes: ${JSON.stringify((r.before ?? []).map((s) => [s.id, s.class]))}; a text line with its class: ${(r.text ?? []).find((l) => l.includes("class ")) ?? "none"}; the grant's log row: ${JSON.stringify(grantRow ?? null)}; Settings words in en/es/ja: ${JSON.stringify(r.words)}`,
      evidence: ["803-classes.json"],
    },
  ];
}
