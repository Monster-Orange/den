// A fake bed for gate/142.mjs (tests/unit/test-infra/gate-142-runner.test.ts):
// stub agents, the bell (GET /api/notifications), Settings, and the held
// writes (POST /api/approvals, POST /api/approvals/<id>/withdraw), no
// browser (ctx.page is null). Options:
//   held:     "counts" (a pending held write is one unread "decision"
//             item, as Den does from issue 142) or "none" (no item, the
//             gap the issue found);
//   withdraw: true (the asker's withdraw route) or false (404, as before);
//   approvals: false: held writes off (403 approvals_off);
//   update:   null (no update check yet), a last pass ({ did, why, … }),
//             or "pending" (Den's own update ask is in the bell).
// Invented names only.

export function fakeBed({
  held = "counts",
  withdraw = true,
  approvals = true,
  update = null,
} = {}) {
  const said = new Map(); // agent -> "needs" | "update"
  const reads = new Map();
  const pending = new Map(); // id -> { name }
  const withdrawn = [];
  const asked = [];
  const settings = {
    bell_kinds: { finished: false },
    update_check:
      update && update !== "pending"
        ? {
            everyMinutes: 60,
            next: null,
            last: { at: "2026-01-01T00:00:00Z", ...update },
          }
        : update === "pending"
          ? {
              everyMinutes: 60,
              next: null,
              last: {
                at: "2026-01-01T00:00:00Z",
                did: "asked",
                version: "9.9.9",
              },
            }
          : null,
  };
  let n = 0;
  const item = (subject, kind, extra = {}) => ({
    id: `${subject}-${kind}`,
    subject,
    kind,
    read: false,
    ...extra,
  });
  const bell = () => {
    const needs = [];
    const updates = [];
    for (const [name, k] of said) {
      if (k === "needs") needs.push(item(`agent:${name}`, "waiting"));
      else {
        const r = (reads.get(name) ?? 0) + 1;
        reads.set(name, r);
        if (r <= 3)
          updates.push(
            item(`agent:${name}`, "finished", {
              link: `/agents?agent=${name}`,
            }),
          );
      }
    }
    if (held === "counts")
      for (const id of pending.keys())
        needs.push(
          item(`record:held-${id}`, "decision", {
            msg: { key: "bell.m.heldAllowAsk", vars: { what: "x" } },
            link: "/agents",
          }),
        );
    if (update === "pending")
      needs.push(
        item("record:den-update-9.9.9", "decision", {
          msg: { key: "bell.m.updateOut", vars: { v: "9.9.9", have: "1.0.0" } },
        }),
      );
    const groups = (l) => [
      {
        scope: "workspace/w",
        subjects: l.map((x) => ({ subject: x.subject, items: [x] })),
      },
    ];
    return {
      unread: needs.length,
      waiting: [],
      groups: groups(needs),
      updates: { count: updates.length, groups: groups(updates) },
    };
  };
  const res = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const ctx = {
    page: null,
    url: "http://bed.invalid",
    newPage: () => null,
    async api(p, init) {
      const method = init?.method ?? "GET";
      if (p === "/api/settings") return res(200, settings);
      if (p === "/api/notifications") return res(200, bell());
      if (p === "/api/approvals" && method === "POST") {
        if (!approvals) return res(403, { ok: false, code: "approvals_off" });
        const b = JSON.parse(init.body);
        asked.push(b);
        const id = `req${String(++n).padStart(13, "0")}`;
        pending.set(id, { name: b.args?.name });
        return res(202, { ok: true, id, state: "pending" });
      }
      const wd = /^\/api\/approvals\/([^/]+)\/withdraw$/.exec(p);
      if (wd && method === "POST") {
        if (!withdraw) return res(404, { ok: false });
        if (!pending.has(wd[1])) return res(409, { ok: false });
        pending.delete(wd[1]);
        withdrawn.push(wd[1]);
        return res(200, { ok: true, id: wd[1], state: "withdrawn" });
      }
      return res(200, { ok: true });
    },
    agent: async (name) => ({
      id: name,
      start: () => ({ code: 0, out: "started", err: "", all: "started" }),
      running: async () => 10,
      stop: async () => ({ code: 0 }),
      remove: async () => ({ code: 0 }),
      sessionStart: async () => {},
      print: async () => {},
      idlePrompt: async () => {},
      permissionRequest: async () => {
        said.set(name, "needs");
      },
      askHuman: async () => {
        said.set(name, "needs");
      },
      hook: async (ev, input) => {
        if (ev === "Stop")
          said.set(
            name,
            /\?$/.test(input.last_assistant_message ?? "") ? "needs" : "update",
          );
      },
    }),
  };
  return {
    ctx,
    asked,
    withdrawn,
    pendingNow: () => [...pending.keys()],
  };
}
