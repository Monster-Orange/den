// A fake bed for gate/701.mjs, gate/659.mjs and gate/658.mjs
// (tests/unit/test-infra/gate-701-659-runner.test.ts): stub agents with the
// bed's start modes (ctx.stub.nextStart: "unwritten", "trust"), the stub's
// log, the bell, the Agents list, doctor --json, Den's held file, agent
// files (handoff.md, handoffs/, rotation.json), the start, relaunch and
// resume routes, and a Hub that takes comments and keeps Den's acks.
// Options:
//   den:  "fixed" (issues 701, 658 and 659 fixed: a question never holds a
//         comment; a dialog does, acked queued with its reason, kept in the
//         held file and listed by doctor; the person's comment clears the
//         question; the trust question is seen and named, never typed
//         into; a relaunch that never began is undone; Resume of a
//         conversation never written starts fresh, with the handoff when
//         one is on file) or "unfixed" (the reported Den: an asked mark
//         holds every comment, no ack, no reason; the trust question isn't
//         seen, so Den types Enter into it; a relaunch that never began
//         stays archived; Resume passes --resume and answers 502);
//   own:  whether the bed's Hub comments as the install's person;
//   hub:  false: the bed has no Hub;
//   modes: false: the bed's stub has no start modes.
//   rotates: true: its persona's rotation counts compactions (after 3);
//         else none can ever be due (after 0).
//   marksDue: true: an undone relaunch from a handoff with none due
//         comes back marked due (a mark it never had: wrong).
// Invented names only.

const REASON = "a permission question is on its screen";
const WAITING = "Waiting: trust this folder?";
const DECLINED =
  "Didn't start: this folder isn't trusted. Resume and choose Yes.";
const FRESH =
  "nothing to resume yet; started fresh (same conversation id, folder and scope)";

export function fakeBed({
  den = "fixed",
  own = true,
  hub = true,
  modes = true,
  rotates = false,
  marksDue = false,
} = {}) {
  const fixed = den === "fixed";
  const agents = new Map();
  const deliveries = new Map(); // id -> { agent, ack, text }
  const held = {}; // agent -> [{ held_reason, created_at }]
  const written = new Set(); // conversation ids with a transcript
  const log = []; // the stub's log: { t, id, k, v }
  let next = null; // the next start's mode
  let n = 0;
  let tok = 0;

  const say = (a, k, v) =>
    log.push({ t: new Date().toISOString(), id: a.token, k, v });
  const typeInto = (a, text, enter = true) => say(a, "keys", { text, enter });
  const header = () =>
    `from: Gate Writer (${own ? "your person" : "an agent"} · verified by Hub) · via: Hub comment (no link)`;

  /** A stub process starting on `a.token`: its mode, once. */
  const stubStart = (a, resumed) => {
    const o = next ?? {};
    next = null;
    say(a, "start", { resumed, filesDir: `/bed/state/agent-files/${a.id}` });
    if (o.mode) say(a, "start-mode", o);
    if (o.mode === "unwritten") {
      say(a, "exit", "unwritten");
      a.state = "exited";
      return false;
    }
    a.state = "running";
    if (o.mode === "trust") {
      a.trustPending = { sel: o.default === "no" ? 2 : 1 };
      // The reported Den judged it ready once quiet and typed Enter.
      if (!fixed) keyTrust(a, "", true);
      return true;
    }
    written.add(a.token);
    return true;
  };
  const trustAnswer = (a, yes, how) => {
    if (!a.trustPending) return;
    a.trustPending = null;
    say(a, "trust", { yes, how });
    if (yes) written.add(a.token);
    else {
      say(a, "exit", "trust-no");
      a.state = "exited";
    }
  };
  const keyTrust = (a, text, enter) => {
    typeInto(a, text, enter);
    if (enter) trustAnswer(a, a.trustPending.sel === 1, "enter");
  };

  // Den's delivery pump and its trust look, once per look.
  const pump = () => {
    for (const a of agents.values()) {
      if (!fixed) continue;
      if (a.state === "running" && a.trustPending && !written.has(a.token))
        a.trustAsked = true;
      else if (a.state === "running" && a.trustAsked) a.trustAsked = false;
      else if (a.state === "exited" && a.trustAsked) {
        a.trustAsked = false;
        a.trustDeclined = true;
      }
    }
    for (const dv of deliveries.values()) {
      if (dv.ack === "working") continue;
      const a = agents.get(dv.agent);
      if (!a) continue;
      const holds = fixed ? a.perm : a.perm || a.asked;
      if (holds) {
        if (fixed && dv.ack !== "queued") {
          dv.ack = "queued";
          held[dv.agent] = [
            { held_reason: REASON, created_at: new Date().toISOString() },
          ];
        }
        continue;
      }
      typeInto(a, `${header()}\n\n${dv.text}`);
      dv.ack = "working";
      delete held[dv.agent];
      if (fixed && own) a.asked = false;
    }
  };

  const archive = (a) => {
    if (a.files["handoff.md"] === undefined) return null;
    const name = `h-${++n}.md`;
    a.handoffs[name] = a.files["handoff.md"];
    delete a.files["handoff.md"];
    return name;
  };

  /** A new conversation's rotation.json, as Den's launch writes it. */
  const launched = (a) => ({
    conversation: a.token,
    compactions: 0,
    after: rotates ? 3 : 0,
  });

  /** Den's relaunch from the handoff: { status, body }. */
  const relaunch = (a, why) => {
    const before = a.rotation;
    const name = archive(a);
    if (!name) return { status: 409, body: { ok: false, code: "no_handoff" } };
    const was = a.token;
    a.token = `conv-${++tok}`;
    a.rotation = launched(a);
    a.rotations.push({ reason: why, conversation: was, next: a.token });
    if (stubStart(a, false)) return { status: 200, body: { ok: true } };
    if (fixed) {
      // Issue 658: never began: handoff.md back, and the rotation as it
      // was before (due again when it was due; a relaunch from a handoff
      // with none due never makes one due).
      a.files["handoff.md"] = a.handoffs[name];
      delete a.handoffs[name];
      a.rotation = marksDue
        ? { ...before, due: "manual", relaunchWanted: true }
        : before
          ? { ...before, conversation: a.token }
          : null;
    }
    return { status: 502, body: { ok: false, code: "exited_at_once" } };
  };

  /** Den's Resume: { status, body }. */
  const resume = (a) => {
    if (fixed && a.rotation?.due) {
      const r = relaunch(a, a.rotation.due);
      return r.status === 200
        ? { status: 200, body: { ok: true, relaunched: true } }
        : r;
    }
    if (written.has(a.token)) {
      stubStart(a, true);
      return { status: 200, body: { ok: true } };
    }
    if (!fixed) {
      say(a, "start", { resumed: true });
      a.state = "exited";
      return { status: 502, body: { ok: false, code: "resume_failed" } };
    }
    const handoff = a.files["handoff.md"] !== undefined;
    if (handoff) archive(a);
    stubStart(a, false);
    return {
      status: 200,
      body: {
        ok: true,
        note: handoff ? "its conversation was never written; …" : FRESH,
        ...(handoff ? { handoff: true } : {}),
      },
    };
  };

  const agent = (id, opt = {}) => {
    const ws = opt.workspace ?? "default";
    const get = () => agents.get(id);
    return {
      id,
      workspace: ws,
      start() {
        const a = {
          id,
          ws,
          state: null,
          token: `conv-${++tok}`,
          asked: false,
          perm: false,
          trust: false,
          trustPending: null,
          trustAsked: false,
          trustDeclined: false,
          files: {},
          handoffs: {},
          rotation: null,
          rotations: [],
        };
        a.rotation = launched(a);
        agents.set(id, a);
        return { code: stubStart(a, false) ? 0 : 1 };
      },
      async running() {
        return get()?.state === "running" ? 5 : null;
      },
      state: () => get()?.state ?? null,
      remove() {
        agents.delete(id);
        return { code: 0 };
      },
      stop() {
        if (get()) get().state = "stopped";
        return { code: 0 };
      },
      askHuman() {
        get().asked = true;
      },
      permissionRequest() {
        get().perm = true;
      },
      print(t) {
        if (/trust this folder/.test(t)) get().trust = true;
        else if (/\\u001b\[2J/.test(t)) get().trust = false;
      },
      async hook(ev) {
        if (ev === "PostToolUse" && get()) get().perm = false;
      },
      async sh(cmd) {
        // Den's compaction hook, as the gate stands in for it.
        const rot =
          /^printf '%s' '(\{[\s\S]*\})' > '[^']+\/rotation\.json'$/.exec(cmd);
        if (rot) {
          get().rotation = JSON.parse(rot[1]);
          return { status: 0, out: "", err: "" };
        }
        const m = /^printf '%b' '([\s\S]*)' > '([^']+)\/handoff\.md'$/.exec(
          cmd,
        );
        if (!m) return { status: 1, out: "", err: "unknown" };
        get().files["handoff.md"] = m[1].split("\\n").join("\n");
        return { status: 0, out: "", err: "" };
      },
      async typed({ since } = {}) {
        return ctx
          .stubLog(id, { since, k: "keys" })
          .map((x) => ({ t: x.t, text: x.v.text, enter: x.v.enter }));
      },
    };
  };

  const filesOf = (rel) => {
    const m = /^state:agent-files\/([^/]+)\/(.+)$/.exec(rel);
    const a = m && agents.get(m[1]);
    return a ? { a, rel: m[2] } : null;
  };

  const ctx = {
    notes: [],
    log(...a) {
      this.notes.push(a.join(" "));
    },
    async sleep() {},
    async until(fn) {
      for (let i = 0; i < 3; i++) {
        pump();
        if (await fn()) return i;
      }
      return null;
    },
    agent,
    stub: modes
      ? {
          nextStart(o) {
            next = { ...o };
          },
          clearNextStart() {
            next = null;
          },
          trust(id, yes) {
            const a = agents.get(id);
            if (a) trustAnswer(a, yes, "ctl");
          },
        }
      : {},
    stubLog(id, { since = null, k = null } = {}) {
      const a = agents.get(id);
      if (!a) return [];
      const from = since === null ? -Infinity : since;
      return log.filter(
        (x) => x.id === a.token && (!k || x.k === k) && Date.parse(x.t) >= from,
      );
    },
    transcriptPath(id) {
      const a = agents.get(id);
      return a && written.has(a.token) ? `/bed/cfg/${a.token}.jsonl` : null;
    },
    readBed(rel) {
      if (rel === "state:hub/deliveries-seen.json")
        return JSON.stringify({ held: { queue: held } });
      const m = /^state:agents\/(.+)\.json$/.exec(rel);
      if (m && agents.has(m[1])) {
        const a = agents.get(m[1]);
        return JSON.stringify({
          workspace: a.ws,
          runtime: "den-claude",
          resumeToken: a.token,
          rotations: a.rotations,
        });
      }
      const f = filesOf(rel);
      if (f?.rel === "rotation.json")
        return f.a.rotation ? JSON.stringify(f.a.rotation) : null;
      if (f?.rel === "handoff.md") return f.a.files["handoff.md"] ?? null;
      const h = f && /^handoffs\/(.+)$/.exec(f.rel);
      if (h) return f.a.handoffs[h[1]] ?? null;
      return null;
    },
    listBed(rel) {
      const f = filesOf(rel);
      if (f?.rel === "handoffs") return Object.keys(f.a.handoffs).sort();
      return null;
    },
    cli(args) {
      if (args[0] === "doctor") {
        pump();
        const rows = Object.entries(held).map(
          ([a, l]) =>
            `${a}: ${l.length} held, oldest 0 min: ${l[0].held_reason}`,
        );
        const checks = fixed
          ? [
              {
                id: "hub_held_comments",
                detail: rows.join("; ") || "no Hub comments held",
              },
            ]
          : [];
        return { code: 0, out: JSON.stringify({ ok: true, checks }), err: "" };
      }
      return { code: 0, out: "", err: "" };
    },
    async api(p) {
      pump();
      if (p === "/api/notifications") {
        const waiting = [];
        const subjects = [];
        for (const [id, a] of agents) {
          const items = [];
          const why = a.perm ? "permission" : a.asked ? "asked" : null;
          if (why) {
            waiting.push({ agent: id, why });
            items.push({ kind: "waiting", read: false });
          }
          if (a.trustAsked)
            items.push({
              kind: "waiting",
              read: false,
              text: `${id}: ${WAITING}`,
              msg: { key: "bell.m.trust" },
            });
          if (a.trustDeclined)
            items.push({
              kind: "waiting",
              read: false,
              text: `${id}: ${DECLINED}`,
              msg: { key: "bell.m.trustDeclined" },
            });
          if (items.length) subjects.push({ subject: `agent:${id}`, items });
        }
        return { waiting, groups: [{ subjects }] };
      }
      if (p.startsWith("/api/sessions")) {
        const sessions = [...agents].map(([id, a]) => {
          const q = [...deliveries.values()].filter(
            (d) => d.agent === id && d.ack !== "working",
          ).length;
          const live = a.state === "running";
          return {
            kind: "agent",
            agent: id,
            exited: !live,
            ...(a.perm ? { waiting: true, waitingWhy: "permission" } : {}),
            ...(a.trustAsked && live
              ? { waiting: true, waitingWhy: "trust" }
              : {}),
            ...(a.trustDeclined ? { trustDeclined: true } : {}),
            ...(q ? { hubWork: { working: 0, queued: q } } : {}),
          };
        });
        return { sessions };
      }
      return {};
    },
    async fetch(p, init) {
      const m = /\/agents\/([^/]+)\/(say|relaunch|resume)$/.exec(p);
      const a = m && agents.get(decodeURIComponent(m[1]));
      if (!a) return { status: 404, headers: {}, body: "{}" };
      const out = (r) => ({
        status: r.status,
        headers: {},
        body: JSON.stringify(r.body),
      });
      if (m[2] === "relaunch") {
        let body = {};
        try {
          body = JSON.parse(init?.body ?? "{}");
        } catch {
          /* none */
        }
        const due = a.rotation?.due;
        if (!due && body.fromHandoff !== true)
          return out({
            status: 409,
            body: { ok: false, error: "has not rotated: resume it instead" },
          });
        return out(relaunch(a, due ?? "manual"));
      }
      if (m[2] === "resume") return out(resume(a));
      if (fixed && (a.trust || a.perm))
        return out({
          status: 409,
          body: {
            ok: false,
            code: "dialog_open",
            error: "waiting on you in its terminal",
          },
        });
      typeInto(a, JSON.parse(init.body).text);
      return out({ status: 200, body: { ok: true } });
    },
    hub: hub
      ? {
          by: "gate-writer",
          async comment({ agent: id, text }) {
            const did = `dv-${++n}`;
            deliveries.set(did, { agent: id, ack: null, text });
            pump();
            return { id: did, slug: "doc" };
          },
          async delivery(id) {
            pump();
            const d = deliveries.get(id);
            if (!d) return { state: null, ack: null, from: "not found" };
            return {
              state: !d.ack || d.ack === "queued" ? "held" : "delivered",
              ack: d.ack,
              ackedAt: null,
              from: "unacked",
            };
          },
        }
      : null,
  };
  return ctx;
}
