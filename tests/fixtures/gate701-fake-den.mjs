// A fake bed for gate/701.mjs and gate/659.mjs
// (tests/unit/test-infra/gate-701-659-runner.test.ts): stub agents, the
// bell, the Agents list, doctor --json, Den's held file and a Hub that
// takes comments and keeps Den's acks. Options:
//   den:  "fixed" (issue 701's Den: a question never holds a comment; a
//         dialog does, acked queued with its reason, kept in the held file
//         and listed by doctor; the person's comment clears the question;
//         a message while the trust question shows answers 409) or
//         "unfixed" (the reported Den: an asked mark holds every comment,
//         no ack, no reason; the trust question isn't seen, so a message
//         is typed with Enter);
//   own:  whether the bed's Hub comments as the install's person;
//   hub:  false: the bed has no Hub.
// Invented names only.

const REASON = "a permission question is on its screen";

export function fakeBed({ den = "fixed", own = true, hub = true } = {}) {
  const fixed = den === "fixed";
  const agents = new Map(); // id -> { ws, state, asked, perm, trust, typed[] }
  const deliveries = new Map(); // id -> { agent, ack, text }
  const held = {}; // agent -> [{ held_reason, created_at }]
  let n = 0;

  const typeInto = (a, text) =>
    a.typed.push({ t: new Date().toISOString(), text, enter: true });
  const header = () =>
    `from: Gate Writer (${own ? "your person" : "an agent"} · verified by Hub) · via: Hub comment (no link)`;

  // Den's delivery pump, once per look.
  const pump = () => {
    for (const [id, dv] of deliveries) {
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
      void id;
    }
  };

  const agent = (id, opt = {}) => {
    const ws = opt.workspace ?? "default";
    const get = () => agents.get(id);
    return {
      id,
      workspace: ws,
      start() {
        agents.set(id, {
          ws,
          state: "running",
          asked: false,
          perm: false,
          trust: false,
          typed: [],
        });
        return { code: 0 };
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
      async typed({ since } = {}) {
        const from = since ?? 0;
        return (get()?.typed ?? []).filter((x) => Date.parse(x.t) >= from);
      },
    };
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
    stubLog() {
      return [];
    },
    readBed(rel) {
      if (rel === "state:hub/deliveries-seen.json")
        return JSON.stringify({ held: { queue: held } });
      const m = /^state:agents\/(.+)\.json$/.exec(rel);
      if (m && agents.has(m[1]))
        return JSON.stringify({
          workspace: agents.get(m[1]).ws,
          runtime: "den-claude",
        });
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
          const why = a.perm ? "permission" : a.asked ? "asked" : null;
          if (!why) continue;
          waiting.push({ agent: id, why });
          subjects.push({
            subject: `agent:${id}`,
            items: [{ kind: "waiting", read: false }],
          });
        }
        return { waiting, groups: [{ subjects }] };
      }
      if (p.startsWith("/api/sessions")) {
        const sessions = [...agents].map(([id, a]) => {
          const q = [...deliveries.values()].filter(
            (d) => d.agent === id && d.ack !== "working",
          ).length;
          return {
            kind: "agent",
            agent: id,
            ...(a.perm ? { waiting: true, waitingWhy: "permission" } : {}),
            ...(q ? { hubWork: { working: 0, queued: q } } : {}),
          };
        });
        return { sessions };
      }
      return {};
    },
    async fetch(p, init) {
      const m = /\/agents\/([^/]+)\/say$/.exec(p);
      const a = m && agents.get(decodeURIComponent(m[1]));
      if (!a) return { status: 404, headers: {}, body: "{}" };
      if (fixed && (a.trust || a.perm))
        return {
          status: 409,
          headers: {},
          body: JSON.stringify({
            ok: false,
            code: "dialog_open",
            error: "waiting on you in its terminal",
          }),
        };
      typeInto(a, JSON.parse(init.body).text);
      return { status: 200, headers: {}, body: '{"ok":true}' };
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
