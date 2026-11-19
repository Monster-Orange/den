// A fake bed for gate/252.mjs (tests/unit/test-infra/gate-252-runner.test.ts):
// one stub agent in project "north" whose mode is set from a fake Agents
// page's ⋯ › Mode. Den restarts it at its next idle (the stub's idle
// prompt) in the new mode, in a new session, with an audit row. `den`:
//   "good":       as Den does;
//   "noRestart":  the mode is saved but the agent never restarts;
//   "noAudit":    it restarts, but no audit row is written;
//   "noRuntime":  the project's mode view doesn't list the agent;
//   "oldCli":     the CLI help still says "from its next start".
// Invented names only.
const ID = "gate-252-mode";
const WS = "north";
const ORDER = ["ask", "edits", "auto", "all"];
const LABELS = [
  "Ask for everything",
  "Auto-approve edits in the worktree",
  "Auto mode",
  "Auto-approve all",
  "Follow project",
];
const SOURCE = { own: "its own setting", install: "the Den-wide default" };

export function fakeBed({ den = "good" } = {}) {
  const st = {
    agent: null,
    session: 1,
    own: null, // its own mode, or null: it follows (the install's "auto")
    running: "auto",
    audit: [],
    pendingIdle: 0,
  };
  const want = () => st.own ?? "auto";
  const source = () => (st.own ? "own" : "install");
  let menuOpen = false;
  let said = null;
  let tagShown = null;

  function setMode(m) {
    st.own = m;
    st.audit.push(`set ${ID}'s mode to ${m ?? "its project's"} in ${WS}`);
    said = m
      ? `${ID}: ${m[0].toUpperCase()}${m.slice(1)}, its own setting. Den restarts it at its next idle to take it.`
      : `${ID} follows the project now: Auto. Den restarts it at its next idle to take it.`;
    st.pendingIdle = 2;
  }

  function idle() {
    if (den === "noRestart" || want() === st.running) return;
    if (--st.pendingIdle > 0) return;
    st.running = want();
    st.session++;
    if (den !== "noAudit")
      st.audit.push(
        `restarted ${ID} in ${WS} at idle to take mode ${want()}, from ${SOURCE[source()]}, by Den itself`,
      );
  }

  const loc = (sel, opts) => ({
    async count() {
      return sel.includes('[data-act="more"]') && menuOpen !== "closed" ? 1 : 0;
    },
    async click() {
      if (opts?.hasText) menuOpen = "mode";
    },
    first() {
      return loc(sel, opts);
    },
    nth(i) {
      return {
        async click() {
          setMode(i < ORDER.length ? ORDER[i] : null);
          menuOpen = false;
        },
      };
    },
    async evaluateAll() {
      return LABELS.map((l, i) => [
        l,
        String(i < ORDER.length ? st.own === ORDER[i] : st.own === null),
      ]);
    },
  });

  const page = {
    async waitForSelector(sel) {
      if (sel === "den-busy") throw new Error("no pop-up: a fast answer");
    },
    locator: loc,
    async click() {},
    getByText() {
      return {
        first() {
          return {
            async textContent() {
              if (!said) throw new Error("not said");
              return said;
            },
          };
        },
      };
    },
    async evaluate() {
      return tagShown;
    },
  };

  const ctx = {
    url: "http://bed.invalid",
    newPage: () => page,
    async goto() {
      said = null;
      const m = st.running;
      tagShown = {
        mode: m,
        source: source(),
        text: `mode: ${m[0].toUpperCase()}${m.slice(1)}, from ${st.own ? "its own setting" : "the Den-wide default"}`,
      };
    },
    async shot() {},
    async until(f, ms) {
      for (let i = 0; i < 20; i++) if (await f()) return i * 100;
      return null;
    },
    cli(args) {
      return {
        code: 0,
        out:
          args[1] === "--help"
            ? den === "oldCli"
              ? "one agent's mode: a running agent takes it from its next start"
              : "A running agent\n    restarts at its next idle, on the same conversation, to take it."
            : "",
        err: "",
      };
    },
    async api(p) {
      if (p === "/api/sessions")
        return {
          sessions: st.agent
            ? [
                {
                  id: `s${st.session}`,
                  kind: "agent",
                  agent: ID,
                  workspace: WS,
                },
              ]
            : [],
        };
      if (p === `/api/workspaces/${WS}/agent-modes`)
        return {
          ok: true,
          mode: null,
          agents:
            den === "noRuntime"
              ? []
              : [
                  {
                    agent: ID,
                    mode: want(),
                    source: source(),
                    ...(st.running !== want() ? { running: st.running } : {}),
                  },
                ],
        };
      return { ok: false };
    },
    readBed(rel) {
      return rel === "audit.jsonl"
        ? st.audit.map((detail) => JSON.stringify({ detail })).join("\n") + "\n"
        : null;
    },
    agent() {
      return {
        start() {
          st.agent = ID;
        },
        async running() {
          return 10;
        },
        idlePrompt: idle,
        state() {
          return st.agent ? { id: ID } : null;
        },
        remove() {
          st.agent = null;
        },
      };
    },
  };
  return { ctx, removed: () => st.agent === null };
}
