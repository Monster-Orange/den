// A fake bed for gate/252.mjs (tests/unit/test-infra/gate-252-runner.test.ts):
// one stub agent in project "north" whose mode is set from a fake Agents
// page's ⋯ › Mode. Den restarts it at its next idle (the stub's idle
// prompt) in the new mode, in a new session, with an audit row. `den`:
//   "good":       as Den does;
//   "noRestart":  the mode is saved but the agent never restarts;
//   "noAudit":    it restarts, but no audit row is written;
//   "noRuntime":  the project's mode view doesn't list the agent;
//   "oldCli":     the CLI help still says "from its next start";
//   "noBusy":     the button never shows busy while the mode applies;
//   "busyElsewhere": busy shows, but on another element, not the ⋯ pressed;
//   "noFollowBusy": busy shows for a mode, not for Follow project;
//   "oldAudit":   an old run's restart rows are in the audit, none new;
//   "noOwnWords": the row's tag says data-mode-source="own" but not the words;
//   "noSession":  the agent has no session at run time, though started;
//   "startsOwn":  the agent already has a mode of its own at the start;
//   "noOpenWords": the page's catalog has no "ag.openName", so t gives the key.
// Invented names only.
const ID = "gate-252-mode";
const WS = "north";
const ORDER = ["ask", "edits", "auto", "all"];
// The page's catalog, as denShell.t gives it (the words the check looks for).
const CATALOG = {
  "ag.more": "More for {id}",
  "ag.openName": "Open {id} in Agents",
  "ag.mode.item": "Mode: {m}",
  "ag.mode.follow": "Follow project",
  "ag.mode.setS":
    "{id}: {m}, its own setting. Den restarts it at its next idle to take it.",
  "ag.mode.src.own": "its own setting",
  "ag.mode.followS":
    "{id} follows the project now: {m}. Den restarts it at its next idle to take it.",
  "pm.ask": "Ask for everything",
  "pm.edits": "Auto-approve edits in the worktree",
  "pm.auto": "Auto mode",
  "pm.all": "Auto-approve all",
  "pm.name.ask": "Ask",
  "pm.name.edits": "Edits",
  "pm.name.auto": "Auto",
  "pm.name.all": "All",
};
const t = (k, v = {}) =>
  String(CATALOG[k] ?? k).replace(/\{(\w+)\}/g, (m, x) =>
    v[x] != null ? String(v[x]) : m,
  );
const SOURCE = { own: "its own setting", install: "the Den-wide default" };
const ROW_NAME = `${t("ag.openName", { id: `${WS} / tester` })} · idle`;
const ROW_TEXT = `tester ${ID} idle`;

export function fakeBed({ den = "good" } = {}) {
  const st = {
    agent: null,
    session: 1,
    // its own mode, or null: it follows (the install's "auto")
    own: den === "startsOwn" ? "auto" : null,
    running: "auto",
    audit:
      den === "oldAudit"
        ? [
            `restarted ${ID} in ${WS} at idle to take mode edits, from its own setting, by Den itself`,
            `restarted ${ID} in ${WS} at idle to take mode auto, from the Den-wide default, by Den itself`,
          ]
        : [],
    pendingIdle: 0,
  };
  const want = () => st.own ?? "auto";
  const source = () => (st.own ? "own" : "install");
  // closed, "top" (the ⋯ menu) or "mode" (its Mode radios).
  let menuOpen = "closed";
  let said = null;
  let tagShown = null;
  let busyOn = null; // the element that showed busy: "more", "other" or none
  let watching = null; // the label of the button the check watches

  function setMode(m) {
    st.own = m;
    st.audit.push(`set ${ID}'s mode to ${m ?? "its project's"} in ${WS}`);
    said = m
      ? t("ag.mode.setS", { id: ID, m: t(`pm.name.${m}`) })
      : t("ag.mode.followS", { id: ID, m: t("pm.name.auto") });
    st.pendingIdle = 2;
    busyOn =
      den === "noBusy" || (den === "noFollowBusy" && m === null)
        ? null
        : den === "busyElsewhere"
          ? "other"
          : "more";
  }

  function idle() {
    if (den === "noRestart" || want() === st.running) return;
    if (--st.pendingIdle > 0) return;
    st.running = want();
    st.session++;
    if (den !== "noAudit" && den !== "oldAudit")
      st.audit.push(
        `restarted ${ID} in ${WS} at idle to take mode ${want()}, from ${SOURCE[source()]}, by Den itself`,
      );
  }

  const fail = (what) => {
    throw new Error(`${what}: not on the page`);
  };
  /** The mode radio a name finds (a mode, "follow", or null). */
  const radioOf = (name, exact) => {
    for (const m of ORDER) if (name === t(`pm.${m}`)) return m;
    const f = t("ag.mode.follow");
    if (exact ? name === f : f.includes(name)) return "follow";
    return null;
  };
  const checkedOf = (m) =>
    String(m === "follow" ? st.own === null : st.own === m);

  const page = {
    async waitForSelector() {}, // the row's mode tag (read by evaluate)
    locator(sel) {
      return {
        async waitFor() {
          fail(sel);
        },
      };
    },
    getByRole(role, o = {}) {
      if (role === "button" && o.name instanceof RegExp) {
        let text = "";
        const found = () => o.name.test(ROW_NAME) && ROW_TEXT.includes(text);
        const row = {
          filter(f) {
            text = f.hasText;
            return row;
          },
          first: () => row,
          async waitFor() {
            if (!found()) fail(String(o.name));
          },
          async click() {
            if (!found()) fail(String(o.name));
          },
          locator() {
            const tag = {
              first: () => tag,
              async waitFor() {
                if (!found() || !tagShown) fail("[data-mode]");
              },
              async getAttribute(a) {
                return a === "data-mode" ? tagShown.mode : tagShown.source;
              },
              async textContent() {
                return tagShown.text;
              },
            };
            return tag;
          },
        };
        return row;
      }
      if (role === "button")
        return {
          async count() {
            return o.name === t("ag.more", { id: ID }) ? 1 : 0;
          },
          async waitFor() {
            if (o.name !== t("ag.more", { id: ID })) fail(o.name);
          },
          async click() {
            menuOpen = "top";
          },
        };
      if (role === "menuitem")
        return {
          async click() {
            if (menuOpen !== "top" || !/^Mode: /.test(o.name)) fail(o.name);
            menuOpen = "mode";
          },
        };
      // menuitemradio: all of them, or the one its name finds.
      const m = o.name == null ? null : radioOf(o.name, o.exact);
      return {
        async count() {
          if (menuOpen !== "mode") return 0;
          return o.name == null ? 5 : m ? 1 : 0;
        },
        async waitFor() {
          if (menuOpen !== "mode" || (o.name != null && !m)) fail(o.name);
        },
        async getAttribute(a) {
          return a === "aria-checked" ? checkedOf(m) : null;
        },
        async click() {
          if (menuOpen !== "mode" || !m) fail(o.name);
          setMode(m === "follow" ? null : m);
          menuOpen = "closed";
        },
      };
    },
    getByText(text) {
      return {
        async waitFor() {
          if (said !== text) throw new Error("not said");
        },
      };
    },
    async evaluate(fn, arg) {
      if (Array.isArray(arg) && arg.length === 2)
        return den === "noOpenWords" && arg[0] === "ag.openName"
          ? arg[0]
          : t(arg[0], arg[1]); // denShell.t
      if (typeof arg === "string") return tagShown; // the row's tag
      if (String(fn).includes("disconnect"))
        return busyOn === "more" && watching === t("ag.more", { id: ID }); // busy read
      watching = Array.isArray(arg) ? arg[0] : null; // the busy watch armed
      busyOn = null;
      return undefined;
    },
  };

  const ctx = {
    url: "http://bed.invalid",
    newPage: () => page,
    async goto() {
      said = null;
      menuOpen = "closed";
      const m = st.running;
      tagShown = {
        mode: m,
        source: source(),
        text: `mode: ${m[0].toUpperCase()}${m.slice(1)}, from ${st.own && den !== "noOwnWords" ? t("ag.mode.src.own") : "the Den-wide default"}`,
      };
    },
    async shot() {},
    async until(f, _ms) {
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
          sessions:
            st.agent && den !== "noSession"
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
