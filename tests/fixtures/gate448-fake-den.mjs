// A fake bed for gate/448.mjs (tests/unit/test-infra/gate-448-clauses.test.ts):
// a Playwright-like page over a fake Den with two projects, no browser.
// `policy` is what the fake Den's rail Terminal opens:
//   "good":   the running shell used last in view (All: in every project),
//             else a new one;
//   "first":  the first running shell listed in view (the live bug under
//             All projects), else a new one;
//   "exited": the shell used last in view, exited or not.
// Invented names only.

export function fakeBed({
  policy = "good",
  projects = ["north", "south"],
} = {}) {
  let n = 0;
  let clock = 1000;
  const sessions = []; // { id, workspace, kind, startedAt, usedAt, exited }
  let scope = "all";
  const den = { sessions, policy, starts: 0, closes: [] };

  const start = (ws) => {
    const s = {
      id: `sh${++n}`,
      workspace: ws,
      kind: "session",
      startedAt: ++clock,
      usedAt: 0,
      exited: false,
    };
    sessions.push(s);
    den.starts++;
    return s;
  };
  const listed = () =>
    [...sessions].sort(
      (a, b) =>
        projects.indexOf(a.workspace) - projects.indexOf(b.workspace) ||
        a.startedAt - b.startedAt,
    );
  const usedAt = (s) => Math.max(s.usedAt, s.startedAt);

  const page = {
    url: "/",
    keyed: null,
    focused: null,
    typed: "",
    keyboard: {
      async type(text) {
        const s = sessions.find((x) => x.id === page.focused);
        if (!s || s.exited) return;
        s.usedAt = ++clock;
        page.typed += text;
      },
      async press(key) {
        const s = sessions.find((x) => x.id === page.focused);
        if (!s || s.exited) return;
        s.usedAt = ++clock;
        if (key === "Enter" && page.typed.trim() === "exit") s.exited = true;
        page.typed = "";
      },
    },
    async evaluate(fn, arg) {
      const src = String(fn);
      if (src.includes("activeElement")) return page.keyed;
      if (src.includes("denShell.api")) {
        const [p, b] = arg;
        if (p === "/api/scope") {
          scope = b.scope;
          return true;
        }
        const close = /^\/api\/sessions\/([^/]+)\/close$/.exec(p);
        if (close) {
          const i = sessions.findIndex(
            (x) => x.id === decodeURIComponent(close[1]),
          );
          if (i < 0) return false;
          den.closes.push(sessions[i].id);
          sessions.splice(i, 1);
          return true;
        }
        return false;
      }
      if (src.includes("fetch(")) {
        if (arg === "/api/scope") return { scope };
        if (arg.startsWith("/api/sessions"))
          return {
            workspaces: projects,
            sessions: listed().map(({ usedAt: _, ...s }) => ({
              ...s,
              startedAt: new Date(s.startedAt).toISOString(),
            })),
          };
        return null;
      }
      throw new Error(`fake page: no evaluate for ${src.slice(0, 80)}`);
    },
    locator(sel) {
      return {
        async click() {
          if (sel === '#den-rail [data-nav="terminal"]') return rail();
          const screen = /^\.pane\[data-id="([^"]+)"\] \.xterm-screen$/.exec(
            sel,
          );
          if (screen) {
            page.focused = screen[1];
            page.keyed = screen[1];
            // A person's click marks the shell used (this browser's own record).
            const s = sessions.find((x) => x.id === screen[1]);
            if (s && !s.exited) s.usedAt = ++clock;
            return;
          }
          const fresh =
            /^\.pane\[data-id="([^"]+)"\] \[data-act="new-shell"\]$/.exec(sel);
          if (fresh) {
            const of = sessions.find((x) => x.id === fresh[1]);
            const s = start(of.workspace);
            page.keyed = s.id;
            page.focused = s.id;
            return;
          }
          throw new Error(`fake page: no click for ${sel}`);
        },
        async waitFor() {
          if (sel.startsWith("#cl-overlay")) throw new Error("not shown");
        },
        async count() {
          return /data-act="new-shell"/.test(sel) ? 1 : 0;
        },
        first() {
          return this;
        },
        async textContent() {
          return "New terminal";
        },
      };
    },
    async waitForURL() {},
    async waitForFunction() {},
    async waitForSelector() {},
    async click() {},
  };

  /** The fake Den's rail Terminal, by `policy`. */
  function rail() {
    const q = new URL(page.url, "http://bed.invalid").searchParams;
    const asked = q.get("project");
    const ws = asked || (scope !== "all" ? scope : null);
    const inView = listed().filter((s) => ws === null || s.workspace === ws);
    let pick = null;
    if (policy === "first") pick = inView.find((s) => !s.exited) ?? null;
    else
      for (const s of inView)
        if (
          (policy === "exited" || !s.exited) &&
          (!pick || usedAt(s) >= usedAt(pick))
        )
          pick = s;
    if (!pick) pick = start(ws ?? projects[0]);
    page.url = "/agents";
    page.keyed = pick.id;
    page.focused = pick.id;
  }

  const ctx = {
    page,
    browser: "chromium",
    width: 1280,
    url: "http://bed.invalid",
    async goto(p, path) {
      p.url = path;
      p.keyed = null;
      p.focused = null;
    },
    async until(f, _ms) {
      for (let i = 0; i < 50; i++) if (await f()) return true;
      return false;
    },
    async sleep() {},
    async shot() {},
  };
  return { ctx, den, scope: () => scope };
}
