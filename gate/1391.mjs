// gate/1391.mjs: personal and strict installs (issue 1391), the asks a
// personal install drops (issue 1403), and an agent's setting change told
// in the bell with Undo (issue 1371 Part 2).
//
// Real path, on throwaway Dens only (ctx.den2), never the bed's own:
// - a personal den2: a test install with no install_mode anywhere. Its
//   doctor and Settings say personal, from default; a stub agent started
//   there runs outside the sandbox; that agent's own setting_change (a
//   limit) is written at once, and the bell says so with Undo.
// - a strict den2: the same, with install_mode: strict in its den.yml from
//   its first start (the bed's product.denYml). The same ask is held, and
//   nothing is written while it waits; the person's CLI (`config`, which
//   runs as the person) can't set install_mode: personal there.
// Allow and Undo of a test bed agent's held write are the test
// operator's: its Undo puts the setting back, its Allow writes it. The
// same request from a session that isn't the operator's (it came through a
// proxy, so forwarded headers) is refused (403) and changes nothing first.
// install_mode in Settings stays the person's alone.
// Teardown removes the agents and closes both Dens (close() deletes them).
export const issue = 1391;
export const items = [1391, 1403, 1371];
export const clauses = [
  "a fresh install with no install_mode is personal, from default: in Doctor and in Settings",
  "an agent started on a personal install runs outside the sandbox",
  "on personal, an agent's limit setting_change is written at once, and its bell row says so with Undo: a session that isn't the test operator is refused (403), and the test operator's Undo puts the setting back",
  "with install_mode: strict in den.yml, the same ask is held: nothing is written while it waits, a session that isn't the test operator can't Allow it (403), and the test operator's Allow writes it",
  "on strict, the person's `config install_mode=personal` is refused, and the mode stays strict, from den.yml",
];
export const timeoutMs = 300000;

const WS = "proj-gate";
const AGENT = "g1391-agent";
// A limit setting_change accepts (the agent limits other than
// max_concurrent are written by hand, issue 1373). Its default is 5 s.
const KEY = "sessions.close_grace_seconds";
const VALUE = 7;
const REASON = "gate check 1391";
const D2S = [];
const NOT_OPERATOR = { "x-forwarded-for": "127.0.0.1" };

const msg = (e) => String(e?.message ?? e).slice(0, 200);
const cut = (s, n = 160) =>
  String(s ?? "")
    .trim()
    .slice(0, n);

async function poll(ctx, f, ms, every = 1000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v || Date.now() >= end) return v;
    await ctx.sleep(every);
  }
}

/**
 * The key's value in den2's config/local/user.yml, the file a
 * setting_change writes: its digits, "unset" when the file has no such
 * key, or null when the file can't be read.
 */
function configValue(d2) {
  const text = d2.readBed("config/local/user.yml");
  if (typeof text !== "string") return null;
  const block = /^sessions:\n((?:[ \t]+.*\n?|\n)*)/m.exec(text)?.[1] ?? "";
  const m = /^[ \t]+close_grace_seconds:[ \t]*["']?(\d+)/m.exec(block);
  return m ? m[1] : "unset";
}

/** What Den answered the agent's call, from the stub's log (codes masked). */
function mcpSaid(d2) {
  try {
    const rows = d2.stubLog?.(AGENT, { k: "sh" }) ?? [];
    const mine = rows.filter((r) => String(r?.v?.cmd ?? "").includes(KEY));
    const last = mine.at(-1)?.v;
    return last
      ? {
          status: last.status ?? null,
          said: cut(`${last.out ?? ""} ${last.err ?? ""}`, 200),
        }
      : null;
  } catch (e) {
    return { error: msg(e) };
  }
}

/** Every bell item, flattened (groups, updates and items alike). */
function bellItems(body) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (typeof v.text === "string") out.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(body);
  return out;
}

async function startDen(ctx, product) {
  const d2 = await ctx.den2({ product: { testInstall: true, ...product } });
  D2S.push(d2);
  return d2;
}

async function startAgent(d2) {
  const a = d2.agent(AGENT, { workspace: WS });
  a.start("tester");
  const ms = await a.running(30000);
  return { a, ms };
}

async function askChange(a) {
  await a.mcp("setting_change", { key: KEY, value: VALUE, reason: REASON });
}

/** Rows 1 to 3, on a personal den2. */
async function personalLeg(ctx) {
  const out = {};
  let d2;
  try {
    d2 = await startDen(ctx, {});
  } catch (e) {
    return { error: `den2 (personal): ${msg(e)}` };
  }
  // (1) Doctor and Settings.
  const doc = d2.cli(["agents", "doctor", "-w", WS]);
  out.doctorLine =
    String(doc?.out ?? "")
      .split("\n")
      .find((l) => /Install mode:/.test(l))
      ?.trim() ?? null;
  const s = await d2.api("/api/settings").catch((e) => ({ error: msg(e) }));
  out.settings = {
    mode: s?.install_mode ?? null,
    from: s?.install_mode_from ?? null,
    ...(s?.error ? { error: s.error } : {}),
  };
  // (2) An agent, and its record's sandbox.
  const { a, ms } = await startAgent(d2);
  out.agentRunningMs = ms;
  try {
    out.sandbox =
      JSON.parse(d2.readBed(`state:agents/${AGENT}.json`) ?? "null")?.sandbox ??
      null;
  } catch (e) {
    out.sandbox = { error: msg(e) };
  }
  if (ms == null) return out;
  // (3) The agent's own setting_change: written at once, told, undone.
  out.before = configValue(d2);
  await askChange(a);
  out.written = await poll(
    ctx,
    async () => (configValue(d2) === String(VALUE) ? true : null),
    30000,
  );
  out.after = configValue(d2);
  out.mcp = mcpSaid(d2);
  const bell = await poll(
    ctx,
    async () => {
      const b = await d2.api("/api/notifications");
      const items = bellItems(b);
      const row = items.find((i) => i.undo?.approval && i.text.includes(KEY));
      return row ? { row, held: (b.waiting ?? []).length } : null;
    },
    30000,
  );
  out.bell = bell
    ? {
        text: cut(bell.row.text),
        undo: !!bell.row.undo?.approval,
        heldWaiting: bell.held,
      }
    : null;
  if (bell?.row?.undo?.approval) {
    const undo = (headers) =>
      d2
        .fetch("/api/settings/undo", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ approval: bell.row.undo.approval }),
        })
        .catch((e) => ({ status: null, body: { error: msg(e) } }));
    const n = await undo(NOT_OPERATOR);
    out.notOperatorUndo = { status: n.status, ok: n.body?.ok === true };
    out.afterNotOperator = configValue(d2);
    const u = await undo({});
    // The test operator's act: the setting goes back.
    out.fixtureUndo = {
      status: u.status,
      ok: u.body?.ok === true,
      ...(u.body?.error ? { error: cut(u.body.error) } : {}),
    };
    out.afterUndo = configValue(d2);
  }
  return out;
}

/** Rows 4 and 5, on a den2 strict in den.yml from its first start. */
async function strictLeg(ctx) {
  const out = {};
  let d2;
  try {
    d2 = await startDen(ctx, { denYml: { install_mode: "strict" } });
  } catch (e) {
    return { error: `den2 (strict): ${msg(e)}` };
  }
  const s = await d2.api("/api/settings").catch(() => null);
  out.mode = {
    mode: s?.install_mode ?? null,
    from: s?.install_mode_from ?? null,
  };
  const { a, ms } = await startAgent(d2);
  out.agentRunningMs = ms;
  if (ms != null) {
    // (4) Held: nothing written, a held write waits; the fixture can't Allow.
    out.before = configValue(d2);
    await askChange(a);
    const held = await poll(
      ctx,
      async () => {
        const b = await d2.api("/api/notifications");
        return (b?.waiting ?? []).find(
          (w) => w.kind === "allow" && w.action === "setting_change",
        );
      },
      30000,
    );
    out.held = held ? { id: held.id, what: cut(held.what) } : null;
    out.mcp = mcpSaid(d2);
    out.whileHeld = configValue(d2);
    if (held?.id) {
      const allow = (headers) =>
        d2
          .fetch(`/api/approvals/${encodeURIComponent(held.id)}/decide`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ decision: "allow" }),
          })
          .catch((e) => ({ status: null, body: { error: msg(e) } }));
      const n = await allow(NOT_OPERATOR);
      out.notOperatorAllow = { status: n.status };
      await ctx.sleep(1000);
      out.afterNotOperator = configValue(d2);
      const r = await allow({});
      out.fixtureAllow = {
        status: r.status,
        ...(r.body?.error ? { error: cut(r.body.error) } : {}),
      };
      await ctx.sleep(3000);
      out.after = configValue(d2);
    }
  }
  // (5) The person's CLI can't loosen den.yml's strict.
  const w = d2.cli(["config", "install_mode=personal"]);
  out.loosen = {
    code: w?.code ?? null,
    said: cut(String(w?.err ?? "") + String(w?.out ?? "")),
  };
  const s2 = await d2.api("/api/settings").catch(() => null);
  out.modeAfter = {
    mode: s2?.install_mode ?? null,
    from: s2?.install_mode_from ?? null,
  };
  return out;
}

export async function setup(ctx) {
  if (!ctx.den2) return { error: "the bed gives no ctx.den2" };
  const s = {};
  s.personal = await personalLeg(ctx).catch((e) => ({ error: msg(e) }));
  s.strict = await strictLeg(ctx).catch((e) => ({ error: msg(e) }));
  return s;
}

export async function run(ctx, s) {
  const fs = await import("fs");
  fs.writeFileSync(ctx.evidence("1391-legs.json"), JSON.stringify(s, null, 2));
  return s;
}

export async function teardown() {
  for (const d of D2S.splice(0)) {
    try {
      if (d.agent(AGENT, { workspace: WS }).state())
        d.agent(AGENT, { workspace: WS }).remove();
    } catch {
      /* the Den goes with close() */
    }
    await d.close().catch(() => {});
  }
}

const row = (clause, ok, detail) => ({
  clause,
  ok,
  detail,
  evidence: ["1391-legs.json"],
});

export function expect(cells) {
  const r =
    (Array.isArray(cells) ? cells.find((c) => c?.result)?.result : cells) ?? {};
  if (r.error) return clauses.map((c) => row(c, false, r.error));
  const p = r.personal ?? {};
  const t = r.strict ?? {};
  const pe = p.error ? `personal den2: ${p.error}` : null;
  const te = t.error ? `strict den2: ${t.error}` : null;
  return [
    row(
      clauses[0],
      !pe &&
        /Install mode: personal \(default\)/.test(p.doctorLine ?? "") &&
        p.settings?.mode === "personal" &&
        p.settings?.from === "default",
      pe ?? `doctor: ${p.doctorLine}; settings: ${JSON.stringify(p.settings)}`,
    ),
    row(
      clauses[1],
      !pe &&
        p.agentRunningMs != null &&
        p.sandbox?.applied === false &&
        !p.sandbox?.legacy,
      pe ??
        `running in ${p.agentRunningMs} ms; sandbox: ${JSON.stringify(p.sandbox)}`,
    ),
    row(
      clauses[2],
      !pe &&
        p.written === true &&
        p.after === String(VALUE) &&
        p.bell?.undo === true &&
        /without your Allow/.test(p.bell?.text ?? "") &&
        p.bell?.heldWaiting === 0 &&
        p.notOperatorUndo?.status === 403 &&
        p.afterNotOperator === String(VALUE) &&
        p.fixtureUndo?.status === 200 &&
        p.fixtureUndo?.ok === true &&
        p.afterUndo === p.before,
      pe ??
        `before ${p.before}, after ${p.after}; agent's call ${JSON.stringify(p.mcp)}; bell: ${JSON.stringify(p.bell)}; not the operator's Undo: ${JSON.stringify(p.notOperatorUndo)}, then ${p.afterNotOperator}; test operator's Undo: ${JSON.stringify(p.fixtureUndo)}, then ${p.afterUndo}`,
    ),
    row(
      clauses[3],
      !te &&
        t.mode?.mode === "strict" &&
        t.mode?.from === "den.yml" &&
        !!t.held?.id &&
        t.whileHeld === t.before &&
        t.notOperatorAllow?.status === 403 &&
        t.afterNotOperator === t.before &&
        t.fixtureAllow?.status === 200 &&
        t.after === String(VALUE),
      te ??
        `mode ${JSON.stringify(t.mode)}; agent's call ${JSON.stringify(t.mcp)}; held ${JSON.stringify(t.held)}; while held ${t.whileHeld} (before ${t.before}); not the operator's Allow ${JSON.stringify(t.notOperatorAllow)}, then ${t.afterNotOperator}; test operator's Allow ${JSON.stringify(t.fixtureAllow)}; after ${t.after}`,
    ),
    row(
      clauses[4],
      !te &&
        t.loosen?.code !== 0 &&
        t.loosen?.code != null &&
        /can't loosen/.test(t.loosen?.said ?? "") &&
        t.modeAfter?.mode === "strict" &&
        t.modeAfter?.from === "den.yml",
      te ??
        `loosen: ${JSON.stringify(t.loosen)}; mode after: ${JSON.stringify(t.modeAfter)}`,
    ),
  ];
}
