// gate/795.mjs: `gate yield <my-id> --to <their-id>` (issue 795).
// The machine's queue is shared, so this check never asks for a slot in
// it. It makes a gate folder of its own (gate795-*, in the OS temp dir)
// and runs the bed's own CLI against it with DEN_GATE_DIR set for that run
// only. In that folder it writes a browser holder and three waiters, A, B
// and C (in that order), each held by a `sleep` this check starts. A is an
// agent's entry (DEN_AGENT names it), so whose it is doesn't depend on the
// harness's own environment. Then the bed's CLI: A yields to C; another
// agent tries to yield A; A tries to yield as a holder and to a holder;
// and `gate status` (text and --json). It reads the slot log the bed's CLI
// wrote, and the page's words for a yield in en, es and ja. Teardown stops
// its sleeps and removes the folder.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const issue = 795;
// Issue 866 asked for this live check (795 shipped with unit tests only).
export const items = [795, 866];
export const clauses = [
  "A yields to C: the order A, B, C becomes C, A, B",
  "a yield from anyone but A's owner is refused and changes nothing",
  "a yield never touches a granted slot, and --to must name a waiting entry",
  "gate status shows the yield in the entry's line until it starts, in en, es and ja",
];
export const timeoutMs = 90000;

const ID = {
  holder: "browser-795h",
  a: "browser-795a",
  b: "browser-795b",
  c: "browser-795c",
};
const OWNER = "agent:gate-check-795";
const OTHER = "agent:gate-check-795-other";

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate795-"));
  fs.mkdirSync(path.join(dir, "slots"), { recursive: true });
  const kids = [];
  // Each sleep is started by a shell that exits at once, so the sleep is
  // never this process's child (see gate/715.mjs).
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
  const slot = (id, o) =>
    fs.writeFileSync(
      path.join(dir, "slots", `${id}.json`),
      JSON.stringify({
        id,
        kind: "browser",
        who: `gate check 795 · ${o.label}`,
        label: o.label,
        estimateMin: 1,
        ...o,
      }),
    );
  // Everything outlives the check; teardown stops them.
  slot(ID.holder, {
    label: "795-holder",
    pid: sleeper(120),
    askedAt: iso(240),
    grantedAt: iso(240),
  });
  slot(ID.a, {
    label: "795-a",
    pid: sleeper(120),
    askedAt: iso(180),
    agent: true,
    actor: OWNER,
  });
  slot(ID.b, { label: "795-b", pid: sleeper(120), askedAt: iso(120) });
  slot(ID.c, { label: "795-c", pid: sleeper(120), askedAt: iso(60) });
  return { dir, kids };
}

export async function run(ctx, state) {
  const env = (actor) => ({ DEN_GATE_DIR: state.dir, DEN_AGENT: actor });
  const status = async () => {
    const j = await ctx.cli(["gate", "status", "--json"], {
      env: env(OWNER),
      timeout: 30000,
    });
    const v = parse(j?.out ?? "");
    return {
      code: j?.code ?? null,
      tail: String(j?.err ?? j?.out ?? "").slice(-300),
      slots: Array.isArray(v?.slots) ? v.slots : [],
    };
  };
  const waiting = (s) => s.slots.filter((x) => !x.granted).map((x) => x.id);
  const yieldAs = async (actor, id, to) => {
    const y = await ctx.cli(["gate", "yield", id, "--to", to], {
      env: env(actor),
      timeout: 30000,
    });
    return {
      code: y?.code ?? null,
      out: String(y?.out ?? "").slice(-300),
      err: String(y?.err ?? "").slice(-300),
    };
  };
  const r = {};
  const s0 = await status();
  // Never yield unless the CLI reads this check's own folder.
  r.ownDir = s0.slots.some((x) => x.id === ID.a);
  r.statusCode = s0.code;
  if (!r.ownDir) {
    r.statusTail = s0.tail;
    return r;
  }
  r.before = waiting(s0);
  // Clause 2 first, while the order is still A, B, C.
  r.other = await yieldAs(OTHER, ID.a, ID.c);
  r.afterOther = waiting(await status());
  // Clause 1.
  r.mine = await yieldAs(OWNER, ID.a, ID.c);
  const s1 = await status();
  r.afterMine = waiting(s1);
  r.aYieldedTo = s1.slots.find((x) => x.id === ID.a)?.yieldedTo ?? null;
  // Clause 3: a holder can't yield, and --to must be a waiting entry.
  r.fromHolder = await yieldAs(OWNER, ID.holder, ID.b);
  r.toHolder = await yieldAs(OWNER, ID.a, ID.holder);
  const s2 = await status();
  r.afterRefused = waiting(s2);
  r.holderStill = s2.slots.some((x) => x.id === ID.holder && x.granted);
  // Clause 4: the text line, and the page's words for a yield.
  const text = await ctx.cli(["gate", "status"], {
    env: env(OWNER),
    timeout: 30000,
  });
  r.aLine =
    String(text?.out ?? "")
      .split("\n")
      .find((l) => l.startsWith(ID.a)) ?? "";
  r.words = {};
  for (const [lang, file] of [
    ["en", "/shell.js"],
    ["es", "/i18n/es.js"],
    ["ja", "/i18n/ja.js"],
  ]) {
    try {
      const res = await ctx.api(file);
      const body = res.ok ? await res.text() : "";
      r.words[lang] = /"gate\.yielded":\s*"[^"]*\{to\}/.test(body);
    } catch {
      r.words[lang] = false;
    }
  }
  let log = "";
  try {
    log = fs.readFileSync(path.join(state.dir, "events.jsonl"), "utf-8");
  } catch {
    /* none written */
  }
  r.yielded = log
    .split("\n")
    .filter(Boolean)
    .map(parse)
    .filter((e) => e?.event === "yielded")
    .map(({ at, id, to, who }) => ({ at, id, to, who }));
  fs.writeFileSync(ctx.evidence("795-yield.json"), JSON.stringify(r, null, 2));
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
  const c = Array.isArray(cells) ? cells.find((x) => x?.result) : null;
  const r = (c ? c.result : cells) ?? {};
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
  const abc = [ID.a, ID.b, ID.c].join(",");
  const cab = [ID.c, ID.a, ID.b].join(",");
  const seq = (a) => (a ?? []).join(",");
  const row = (r.yielded ?? []).find((e) => e.id === ID.a && e.to === ID.c);
  return [
    {
      clause: clauses[0],
      ok:
        seq(r.before) === abc &&
        r.mine?.code === 0 &&
        seq(r.afterMine) === cab &&
        !!row,
      detail: `before: ${seq(r.before)}; yield exited ${r.mine?.code} (${r.mine?.out || r.mine?.err}); after: ${seq(r.afterMine)}; slot log: ${JSON.stringify(r.yielded ?? [])}`,
      evidence: ["795-yield.json"],
    },
    {
      clause: clauses[1],
      ok:
        r.other?.code === 1 &&
        seq(r.afterOther) === abc &&
        !(r.yielded ?? []).some((e) => e.who?.includes(OTHER)),
      detail: `another agent's yield of A exited ${r.other?.code} (${r.other?.err}); the order after it: ${seq(r.afterOther)}`,
      evidence: ["795-yield.json"],
    },
    {
      clause: clauses[2],
      ok:
        r.fromHolder?.code === 1 &&
        r.toHolder?.code === 1 &&
        seq(r.afterRefused) === cab &&
        r.holderStill === true,
      detail: `the holder yielding exited ${r.fromHolder?.code} (${r.fromHolder?.err}); A yielding to the holder exited ${r.toHolder?.code} (${r.toHolder?.err}); the order after: ${seq(r.afterRefused)}; the holder still holds: ${r.holderStill}`,
      evidence: ["795-yield.json"],
    },
    {
      clause: clauses[3],
      ok:
        r.aLine.includes(ID.c) &&
        /go ahead/.test(r.aLine) &&
        seq(r.aYieldedTo) === ID.c &&
        r.words?.en === true &&
        r.words?.es === true &&
        r.words?.ja === true,
      detail: `A's line: "${r.aLine}"; --json yieldedTo: ${JSON.stringify(r.aYieldedTo)}; the page's yield words (gate.yielded with {to}) in en/es/ja: ${JSON.stringify(r.words)}`,
      evidence: ["795-yield.json"],
    },
  ];
}
