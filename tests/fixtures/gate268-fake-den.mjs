// A fake bed for gate/268.mjs (tests/unit/test-infra/gate-268-runner.test.ts):
// the two agent-mode rows in Settings, and the Agents list's tag. The stub
// agent starts in project "north", which follows; "south" follows too.
// The Den-wide default is Auto mode. `den`:
//   "good":       as Den words them now;
//   "oldWords":   the rows' old labels ("Mode for every agent", "Agents' mode");
//   "noStatus":   the project row doesn't say what is in effect;
//   "noLinks":    neither row links to the other;
//   "agentWords": the Agents list says "from the workspace" for the source;
//   "untranslated": es and ja show the English words;
//   "oneProject": the bed has only the stub's project;
//   "noRuntime":  the stub's runtime has no modes (no agent in the rows).
// Invented names only.
const ID = "gate-268-mode";
const EN = {
  dwLabel: "Agents' mode: Den-wide default",
  pLabel: "Agents' mode: this project (overrides the Den-wide default)",
  order:
    "Which wins: an agent's own setting, then the project, then the Den-wide default, then its persona.",
  now: (m) => `In effect Den-wide: ${m}`,
  following: (m) => `Following Den-wide: ${m}`,
  setHere: (m, dw) => `Set for this project: ${m} (Den-wide is ${dw})`,
  changeDw: "Change the Den-wide default",
  over: (n) =>
    `${n} ${n === 1 ? "project overrides" : "projects override"} this:`,
  overNone: "No project overrides this.",
  useDw: "Use Den-wide",
  src: { project: "the project", install: "the Den-wide default" },
  modes: {
    ask: "Ask for everything",
    edits: "Auto-approve edits in the worktree",
    auto: "Auto mode",
  },
  names: { ask: "Ask", edits: "Edits", auto: "Auto" },
};
const tr = (prefix) => ({
  ...EN,
  dwLabel: `${prefix} ${EN.dwLabel}`,
  pLabel: `${prefix} ${EN.pLabel}`,
  now: (m) => `${prefix} ${EN.now(m)}`,
  following: (m) => `${prefix} ${EN.following(m)}`,
  setHere: (m, dw) => `${prefix} ${EN.setHere(m, dw)}`,
  changeDw: `${prefix} ${EN.changeDw}`,
  useDw: `${prefix} ${EN.useDw}`,
  src: { project: `${prefix} proyecto`, install: `${prefix} Den` },
});

export function fakeBed({ den = "good" } = {}) {
  const st = {
    lang: "en",
    agent: null,
    modes: { north: null, ...(den === "oneProject" ? {} : { south: null }) },
    running: "auto",
    view: null,
  };
  const install = "auto";
  const W = () =>
    den === "untranslated" || st.lang === "en"
      ? EN
      : tr(st.lang === "es" ? "[es]" : "[ja]");
  const want = () => st.modes.north ?? install;
  const sourceOf = () => (st.modes.north ? "project" : "install");

  function modesView(ws) {
    return {
      ok: true,
      mode: st.modes[ws],
      install,
      agents:
        ws === "north" && st.agent && den !== "noRuntime"
          ? [
              {
                agent: ID,
                mode: want(),
                source: sourceOf(),
                ...(st.running !== want() ? { running: st.running } : {}),
              },
            ]
          : [],
    };
  }
  const overrides = () => Object.keys(st.modes).filter((w) => st.modes[w]);

  function readRow(id) {
    const w = W();
    const base = { lang: st.lang, row: true };
    if (id === "agents.default_mode") {
      const o = overrides();
      return {
        ...base,
        label: den === "oldWords" ? "Mode for every agent" : w.dwLabel,
        desc: `The mode every agent runs in. ${w.order}`,
        dwNow: w.now(w.modes[install]),
        overrides: {
          n: o.length,
          text:
            (o.length ? w.over(o.length) : w.overNone) +
            (o.length ? ` ${o.join(", ")}` : ""),
          links:
            den === "noLinks"
              ? []
              : o.map((ws) => ({
                  href: `/settings?project=${ws}#workspace.agents_mode`,
                  text: ws,
                })),
        },
        now: null,
        dwLink: null,
        useDw: null,
        pressed: null,
        agents: [],
      };
    }
    const ws = st.view;
    const m = st.modes[ws];
    const v = modesView(ws);
    return {
      ...base,
      label: den === "oldWords" ? "Agents' mode" : w.pLabel,
      desc: `The mode this project's agents run in. ${w.order}`,
      dwNow: null,
      overrides: null,
      now:
        den === "noStatus"
          ? null
          : m
            ? { from: "project", text: w.setHere(w.modes[m], w.modes[install]) }
            : { from: "den-wide", text: w.following(w.modes[install]) },
      dwLink:
        den === "noLinks"
          ? null
          : { href: "/settings#agents.default_mode", text: w.changeDw },
      useDw: w.useDw,
      pressed: m ?? "none",
      agents: v.agents.map((a) => ({
        agent: a.agent,
        source: a.source,
        text: `${a.agent}: ${EN.names[a.mode]}, from ${w.src[a.source]}`,
      })),
    };
  }

  const page = {
    async waitForSelector() {},
    async evaluate(_fn, arg) {
      if (String(arg).startsWith(".agst")) {
        if (!st.agent || den === "noRuntime" || st.running !== want())
          return null;
        const src =
          den === "agentWords" ? "the workspace" : W().src[sourceOf()];
        return {
          mode: want(),
          source: sourceOf(),
          text: `mode: ${EN.names[want()]}, from ${src}`,
        };
      }
      return readRow(arg);
    },
  };

  const ctx = {
    url: "http://bed.invalid",
    newPage: () => page,
    async goto(_p, path) {
      const m = /[?&]project=([^&#]+)/.exec(path);
      st.view = m ? decodeURIComponent(m[1]) : null;
    },
    async shot() {},
    async until(f) {
      for (let i = 0; i < 20; i++) if (await f()) return i * 100;
      return null;
    },
    async fetch(path, init) {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (path === "/api/sessions")
        return {
          status: 200,
          body: {
            sessions: st.agent
              ? [{ id: "s1", kind: "agent", agent: ID, workspace: "north" }]
              : [],
          },
        };
      if (path === "/api/workspaces")
        return {
          status: 200,
          body: {
            workspaces: Object.fromEntries(
              Object.keys(st.modes).map((w) => [w, {}]),
            ),
          },
        };
      if (path === "/api/settings" && !body)
        return {
          status: 200,
          body: {
            language: st.lang,
            agents_default_mode: install,
            agents_mode_overrides: overrides(),
          },
        };
      if (path === "/api/settings") {
        st.lang = body.language ?? "en";
        return { status: 200, body: { ok: true } };
      }
      const m = /^\/api\/workspaces\/([^/]+)\/agent-modes$/.exec(path);
      if (m && m[1] in st.modes) {
        if (body) st.modes[m[1]] = body.mode;
        return { status: 200, body: modesView(m[1]) };
      }
      return { status: 404, body: null };
    },
    agent() {
      return {
        start() {
          st.agent = ID;
        },
        async running() {
          return 10;
        },
        idlePrompt() {
          st.running = want();
        },
        state() {
          return st.agent ? { id: ID } : null;
        },
        remove() {
          st.agent = null;
        },
      };
    },
  };
  return {
    ctx,
    state: () => ({ agent: st.agent, lang: st.lang, modes: { ...st.modes } }),
  };
}
