// gate/715.mjs: `gate run --priority release --reason <why>` (issue 715).
// The machine's queue is shared, so this check never asks for a slot in
// it. It makes a gate folder of its own (gate715-*, in the OS temp dir)
// and runs the bed's own CLI against it with DEN_GATE_DIR set for that run
// only. In that folder it writes four slots, each held by a `sleep` this
// check starts: a browser holder (ends in ~10 s), an ordinary waiter "a",
// a release run "first" marked with priority, and an ordinary waiter "b"
// that asked after it. Then the bed's `gate status` (text and --json), and
// a real `gate run --priority release` ("second"). It reads the slot log
// the bed's CLI wrote. Teardown stops its sleeps and removes the folder.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const issue = 715;
export const clauses = [
  "a release run marked with priority goes to the front of its kind's queue, never ahead of a holder",
  "a second marked run waits behind the first",
  "a run with no priority never jumps",
  "each jump is in the slot log: who asked, why, and which runs it passed",
  "gate status (text and --json) shows the priority holder and its reason",
];
export const timeoutMs = 120000;

const ID = {
  holder: "browser-715h",
  a: "browser-715a",
  first: "browser-715p",
  b: "browser-715b",
};
const WHY_FIRST = "gate check 715: first";
const WHY_SECOND = "gate check 715: second";

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate715-"));
  fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
  const kids = [];
  // Each sleep is started by a shell that exits at once, so the sleep is
  // never this process's child: when it ends, the system reaps it (a child
  // left unreaped while ctx.cli blocks would still look alive).
  const sleeper = (s) => {
    const pid = Number(
      execFileSync(
        "sh",
        ["-c", `sleep ${Number(s)} >/dev/null 2>&1 & echo $!`],
        {
          encoding: "utf-8",
        },
      ).trim(),
    );
    kids.push(pid);
    return pid;
  };
  const now = Date.now();
  const iso = (sec) => new Date(now - sec * 1000).toISOString();
  const slot = (id, o) =>
    fs.writeFileSync(
      path.join(dir, "slots", `${id}.json`),
      JSON.stringify({
        id,
        kind: "browser",
        who: `gate check 715 · ${o.label}`,
        label: o.label,
        estimateMin: 1,
        ...o,
      }),
    );
  // The holder ends first; "first" holds a while once it starts; "a" and
  // "b" outlive the check (teardown stops them).
  slot(ID.holder, {
    label: "715-holder",
    pid: sleeper(10),
    askedAt: iso(240),
    grantedAt: iso(240),
  });
  slot(ID.a, { label: "715-a", pid: sleeper(110), askedAt: iso(180) });
  slot(ID.first, {
    label: "715-first",
    pid: sleeper(20),
    askedAt: iso(120),
    priority: { for: "release", reason: WHY_FIRST },
  });
  slot(ID.b, { label: "715-b", pid: sleeper(110), askedAt: iso(60) });
  return { dir, kids };
}

export async function run(ctx, state) {
  const env = { DEN_GATE_DIR: state.dir };
  const r = {};
  const json = await ctx.cli(["gate", "status", "--json"], {
    env,
    timeout: 30000,
  });
  const view = parse(json?.out ?? "");
  const slots = Array.isArray(view?.slots) ? view.slots : [];
  // Never run `gate run` unless the CLI reads this check's own folder:
  // otherwise it would ask in the machine's shared queue.
  r.ownDir = slots.some((s) => s.id === ID.first);
  r.statusCode = json?.code ?? null;
  if (!r.ownDir) {
    r.statusTail = String(json?.err ?? json?.out ?? "").slice(-300);
    return r;
  }
  r.waitOrder = slots.filter((s) => !s.granted).map((s) => s.id);
  r.firstPriority = slots.find((s) => s.id === ID.first)?.priority ?? null;
  const text = await ctx.cli(["gate", "status"], { env, timeout: 30000 });
  r.textLine =
    String(text?.out ?? "")
      .split("\n")
      .find((l) => l.includes(ID.first)) ?? "";
  const t0 = Date.now();
  const second = await ctx.cli(
    [
      "gate",
      "run",
      "--kind",
      "browser",
      "--estimate",
      "1m",
      "--label",
      "715-second",
      "--priority",
      "release",
      "--reason",
      WHY_SECOND,
      "--",
      "true",
    ],
    { env, timeout: 90000 },
  );
  r.secondCode = second?.code ?? null;
  r.secondMs = Date.now() - t0;
  r.secondErr = String(second?.err ?? "").slice(-300);
  let log = "";
  try {
    log = fs.readFileSync(path.join(state.dir, "events.jsonl"), "utf-8");
  } catch {
    /* none written */
  }
  r.events = log
    .split("\n")
    .filter(Boolean)
    .map(parse)
    .filter(Boolean)
    .map(({ at, event, id, label, by, reason, passed, behind }) => ({
      at,
      event,
      id,
      label,
      by,
      reason,
      passed,
      behind,
    }));
  const after = parse(
    (await ctx.cli(["gate", "status", "--json"], { env, timeout: 30000 }))
      ?.out ?? "",
  );
  r.after = (after?.slots ?? []).map((s) => ({ id: s.id, granted: s.granted }));
  fs.writeFileSync(ctx.evidence("715-events.json"), JSON.stringify(r, null, 2));
  return r;
}

export async function teardown(_ctx, state) {
  for (const pid of state?.kids ?? [])
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  if (state?.dir) fs.rmSync(state.dir, { recursive: true, force: true });
}

export function expect(cells) {
  const r = (Array.isArray(cells) ? cells[0]?.result : cells) ?? {};
  if (!r.ownDir && r.statusCode !== 0)
    return clauses.map((clause) => ({
      clause,
      ok: false,
      detail: `the bed's \`gate status --json\` failed (exit ${r.statusCode}): ${r.statusTail ?? ""}`,
    }));
  if (!r.ownDir) {
    const why = `the bed's CLI didn't read this check's own gate folder (DEN_GATE_DIR for that run only); nothing was asked in the machine's queue. ${r.statusTail ?? ""}`;
    return clauses.map((clause) => ({
      clause,
      ok: null,
      skip: "needs-cli-env",
      detail: why,
    }));
  }
  const ev = r.events ?? [];
  const second = ev.find((e) => e.label === "715-second")?.id;
  const granted = ev.filter((e) => e.event === "granted").map((e) => e.id);
  const at = (event, id) =>
    ev.find((e) => e.event === event && e.id === id)?.at;
  const holderOut =
    at("taken-back-gone", ID.holder) ?? at("released", ID.holder);
  const firstIn = at("granted", ID.first);
  const pri = ev.filter((e) => e.event === "priority");
  const priFirst = pri.find((e) => e.id === ID.first);
  const priSecond = pri.find((e) => e.id === second);
  const waits = ev.find((e) => e.event === "priority-waits" && e.id === second);
  const order = `granted in order: ${granted.join(", ") || "none"}; waiting at the start: ${(r.waitOrder ?? []).join(", ")}; gate run --priority exited ${r.secondCode}${r.secondCode ? ` (${r.secondErr})` : ""} after ${Math.round((r.secondMs ?? 0) / 1000)} s`;
  return [
    {
      clause: clauses[0],
      ok:
        r.waitOrder?.[0] === ID.first &&
        !!holderOut &&
        !!firstIn &&
        firstIn >= holderOut &&
        granted.indexOf(ID.first) === 0,
      detail: `${order}; the holder left at ${holderOut ?? "never"}, "first" started at ${firstIn ?? "never"}`,
      evidence: ["715-events.json"],
    },
    {
      clause: clauses[1],
      ok:
        !!second &&
        r.secondCode === 0 &&
        Array.isArray(waits?.behind) &&
        waits.behind.includes(ID.first) &&
        granted.indexOf(second) === granted.indexOf(ID.first) + 1 &&
        (granted.indexOf(ID.a) === -1 ||
          granted.indexOf(ID.a) > granted.indexOf(second)),
      detail: `${order}; priority-waits behind: ${JSON.stringify(waits?.behind ?? null)}`,
      evidence: ["715-events.json"],
    },
    {
      clause: clauses[2],
      ok:
        (r.waitOrder ?? []).join(",") === [ID.first, ID.a, ID.b].join(",") &&
        !granted.includes(ID.b) &&
        (r.after ?? []).some((s) => s.id === ID.b && !s.granted),
      detail: `${order}; at the end: ${JSON.stringify(r.after ?? [])}`,
      evidence: ["715-events.json"],
    },
    {
      clause: clauses[3],
      ok:
        priFirst?.reason === WHY_FIRST &&
        !!priFirst?.by &&
        (priFirst?.passed ?? []).includes(ID.a) &&
        priSecond?.reason === WHY_SECOND &&
        !!priSecond?.by &&
        (priSecond?.passed ?? []).includes(ID.a),
      detail: `priority rows: ${JSON.stringify(pri)}`,
      evidence: ["715-events.json"],
    },
    {
      clause: clauses[4],
      ok:
        r.firstPriority?.reason === WHY_FIRST &&
        r.firstPriority?.holds === true &&
        r.textLine.includes(`release priority: "${WHY_FIRST}"`),
      detail: `--json: ${JSON.stringify(r.firstPriority)}; text: ${r.textLine}`,
    },
  ];
}
