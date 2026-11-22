/**
 * Issue 482: Terminals get their own list (model A, as mocked and
 * approved): a Terminals page at /terminals, the rail's Terminals, and the
 * Agents list with agents only. The list's rules (which rows, their order,
 * what a row says, the one-time note on Agents, the New terminal picker
 * under All projects) live in public/terminals-list.js, so they run here
 * without a browser. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import {
  belongsOn,
  lastUsedProject,
  movedNoteHtml,
  newTerminalChoices,
  terminalGroups,
  terminalName,
  terminalRowHtml,
  terminalsCountText,
} from "../../../src/ui/server/public/terminals-list.js";
import {
  terminalLinkRedirect,
  terminalsPageHtml,
} from "../../../src/ui/server/terminals-page.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { ROUTES } from "../../../src/ui/server/route-classes.js";
import { UI_MODULES } from "../../../src/ui/server/ui-assets.js";

const PUB = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUB, f), "utf-8");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-482-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const at = (hm: string) => `2026-11-18T${hm}:00.000Z`;
const shell = (
  id: string,
  workspace: string,
  more: Record<string, unknown> = {},
) => ({
  id,
  workspace,
  kind: "session",
  label: "shell",
  state: "running",
  startedAt: at("09:00"),
  ...more,
});
const agent = (id: string, workspace: string) => ({
  id,
  workspace,
  kind: "agent",
  agent: id,
  state: "running",
});
// t() as the page has it: the key, then its vars, so a test can read both.
const tr = (k: string, v?: Record<string, unknown>) =>
  v ? `${k}${JSON.stringify(v)}` : k;

describe("clause 1: each list holds its own kind", () => {
  it("Terminals holds shells only; Agents never a shell", () => {
    const s = shell("s1", "north");
    const a = agent("scout", "north");
    expect(belongsOn("terminal", s)).toBe(true);
    expect(belongsOn("terminal", a)).toBe(false);
    expect(belongsOn("agents", a)).toBe(true);
    expect(belongsOn("agents", s)).toBe(false);
    expect(belongsOn("agents", { ...a, server: true })).toBe(true);
  });

  it("agents-page.js filters its rows by the page, and lights the rail by it", () => {
    const src = read("agents-page.js");
    expect(src).toMatch(
      /import \{[^}]*belongsOn[^}]*\} from "\/terminals-list\.js"/,
    );
    expect(src).toMatch(/belongsOn\(PAGE, s\)/);
    // The rail lights the page's own item, never by the pane in front.
    expect(src).not.toMatch(/front\.kind === "session" \? "terminal"/);
  });
});

describe("clause 2: the rows, by project filter", () => {
  const rows = [
    shell("old", "north", {
      exited: true,
      state: "exited (0)",
      inputAt: at("08:00"),
      cwd: "/w/north/api",
      folder: "~/north/api",
    }),
    shell("a", "north", {
      inputAt: at("10:00"),
      cwd: "/w/north/api",
      folder: "~/north/api",
    }),
    shell("b", "south", {
      inputAt: at("11:00"),
      cwd: "/w/south",
      folder: "~/south",
    }),
    shell("c", "north", {
      exited: true,
      state: "exited (0)",
      inputAt: at("09:30"),
    }),
  ];

  it("running first, then exited, each newest used first", () => {
    const g = terminalGroups(rows, {});
    expect(g.running.map((r) => r.id)).toEqual(["b", "a"]);
    expect(g.exited.map((r) => r.id)).toEqual(["c", "old"]);
    // This browser's own clicks count too (issue 448's rule).
    expect(
      terminalGroups(rows, { a: Date.parse(at("12:00")) }).running[0].id,
    ).toBe("a");
  });

  it("a row says its folder, running or exited, and when it was last used; All projects adds the project", () => {
    const o = { t: tr, when: (iso: string) => `at ${iso}` };
    const all = terminalRowHtml(rows[1], { ...o, showProject: true });
    expect(all).toContain("~/north/api");
    expect(all).toContain("north");
    expect(all).toContain("ag.state.running");
    // Escaped, one string: the time is text inside the words.
    expect(all).toContain(
      `tm.lastUsed{&quot;when&quot;:&quot;at ${at("10:00")}&quot;}`,
    );
    const one = terminalRowHtml(rows[1], { ...o, showProject: false });
    expect(one).not.toMatch(/class="proj"/);
    expect(all).toMatch(/class="proj"/);
  });

  it("a row's name is its folder's, never the word shell", () => {
    expect(terminalName(rows[1])).toBe("api");
    expect(terminalName(shell("x", "north"))).toBe("north");
    const html = terminalRowHtml(shell("x", "north"), {
      t: tr,
      when: () => "",
    });
    expect(html).not.toMatch(/>shell</);
  });

  it("the server's rows carry the shell's folder", () => {
    const out = listedSessions(
      [
        {
          ref: { backend: "den-pty", id: "s-1" },
          name: "acme-north:shell",
          pid: 1,
          startedAt: at("09:00"),
          cwd: path.join(os.homedir(), "north", "api"),
        },
      ],
      {
        stateDir: () => dir,
        dist: () => "acme",
        activeWorkspaces: () => ["north"],
      },
    );
    expect(out[0]).toMatchObject({
      kind: "session",
      cwd: path.join(os.homedir(), "north", "api"),
      folder: "~/north/api",
    });
  });

  it("the count says terminals, never shells", () => {
    expect(terminalsCountText(3, "All projects", tr)).toBe(
      'tm.count{"n":3} · All projects',
    );
    expect(terminalsCountText(1, "", tr)).toBe('tm.count1{"n":1}');
  });
});

describe("clause 3: whole row opens; exited rows dimmed with Restart and Remove", () => {
  const o = { t: tr, when: () => "" };
  it("the whole row is one button that opens the shell", () => {
    const html = terminalRowHtml(shell("a", "north"), o);
    expect(html).toMatch(
      /<button type="button" class="agr" data-id="a" data-kind="session"/,
    );
    expect(html).not.toContain('data-act="restart-shell"');
    // Remove on a running shell is not offered (Stop first).
    expect(html).not.toContain('data-act="remove-shell"');
  });
  it("an exited row is dimmed, with Restart and Remove outside the open button", () => {
    const html = terminalRowHtml(
      shell("c", "north", { exited: true, state: "exited (0)" }),
      o,
    );
    expect(html).toMatch(/class="agst tmrow exited"/);
    const btn = html.slice(0, html.indexOf("</button>"));
    expect(btn).not.toContain("data-act");
    expect(html).toContain('data-act="restart-shell"');
    expect(html).toContain('data-act="remove-shell"');
  });
  it("the page dims exited rows to 55% and keeps their buttons full strength", () => {
    expect(read("agents.html")).toMatch(
      /\.tmrow\.exited > \.agr \{\s*opacity: 0\.55;/,
    );
  });
});

describe("clause 4: New terminal, one click (a picker under All projects)", () => {
  it("All projects: the projects, the one used last first (preselected)", () => {
    const rows = [
      shell("a", "north", { inputAt: at("10:00") }),
      shell("b", "south", { exited: true, inputAt: at("11:00") }),
    ];
    // The one used last first, then the rest in the projects' own order.
    expect(newTerminalChoices(["east", "north", "south"], rows, {})).toEqual([
      "south",
      "east",
      "north",
    ]);
  });
  it("a project's page says New terminal, and starts a new one", () => {
    const ld = read("local-dev.html");
    expect(ld).toMatch(
      /id="ws-term-here" href="\/terminals\?terminal=1&amp;fresh=1&amp;project=\$\{enc\}"/,
    );
    expect(ld).toContain('wsT("ws.termHere", "New terminal")');
  });
  it("the page reads fresh=1 as a new one, never a reuse", () => {
    expect(read("agents-page.js")).toMatch(/q0\.get\("fresh"\) === "1"/);
  });
});

describe("clause 5: the rail's Terminals", () => {
  it("is named Terminals and opens /terminals in the project in view", () => {
    const src = read("shell.js");
    expect(src).toMatch(/"n\.terminal": "Terminals"/);
    expect(src).toMatch(/id: "terminal",[\s\S]{0,200}href: "\/terminals",/);
    expect(src).toMatch(/"\/terminals\?terminal=1" \+/);
  });
  it("under All projects with none running, starts in the project used last", () => {
    const rows = [
      shell("a", "north", { exited: true, inputAt: at("10:00") }),
      shell("b", "south", { exited: true, inputAt: at("11:00") }),
    ];
    expect(lastUsedProject(rows, {}, ["east", "north", "south"])).toBe("south");
    expect(lastUsedProject([], {}, ["east", "north"])).toBe("east");
    expect(lastUsedProject(rows, {}, ["east"])).toBe("east");
  });
});

describe("clause 6: nothing lost when shells leave Agents", () => {
  it("old Terminal links go to the Terminals page, with their query", () => {
    expect(
      terminalLinkRedirect(
        "/agents",
        new URLSearchParams("terminal=1&ws=north"),
      ),
    ).toBe("/terminals?terminal=1&ws=north");
    expect(terminalLinkRedirect("/agents", new URLSearchParams("open=a"))).toBe(
      null,
    );
    expect(
      terminalLinkRedirect("/terminals", new URLSearchParams("terminal=1")),
    ).toBe(null);
  });

  it("Agents says once where the shells went, with Open Terminals and Dismiss", () => {
    const html = movedNoteHtml(3, tr);
    expect(html).toContain("tm.moved{&quot;n&quot;:3}");
    expect(html).toContain('data-act="open-terminals"');
    expect(html).toContain('data-act="dismiss-moved"');
    expect(movedNoteHtml(1, tr)).toContain("tm.moved1{&quot;n&quot;:1}");
    expect(movedNoteHtml(0, tr)).toBe("");
  });

  it("each page keeps its own open panes", () => {
    const src = read("agents-page.js");
    expect(src).toMatch(
      /PAGE === "terminal" \? "den-terminals-open" : "den-agents-open"/,
    );
  });
});

describe("the Terminals page", () => {
  const AGENTS = read("agents.html");
  it("is agents.html with the shell's page id and title swapped", () => {
    const html = terminalsPageHtml(AGENTS);
    expect(html).toContain('<div id="den-shell" data-page="terminal"');
    expect(html).not.toContain('data-page="agents"');
    expect(html).toContain("<title>__DEN_TITLE__ · Terminals</title>");
  });
  it("refuses a page without the markers", () => {
    expect(() => terminalsPageHtml("<html></html>")).toThrow(/markers/);
  });
  it("is a page route, and its module is served", () => {
    expect(ROUTES.some((r) => r.path === "/terminals")).toBe(true);
    expect(UI_MODULES).toContain("/terminals-list.js");
  });
});

describe("clause 7: every new word in en, es and ja, and never 'shell'", () => {
  const KEYS = [
    "n.terminal",
    "n.terminalTip",
    "ws.termHere",
    "ws.termHereTip",
    "tm.count",
    "tm.count1",
    "tm.running",
    "tm.exited",
    "tm.lastUsed",
    "tm.restart",
    "tm.restartName",
    "tm.none",
    "tm.noneP",
    "tm.empty",
    "tm.pick",
    "tm.moved",
    "tm.moved1",
    "tm.openList",
    "tm.dismiss",
  ];
  function catalogs(): Record<string, Record<string, string>> {
    const window: Record<string, unknown> = {};
    const document = {
      getElementById: () => null,
      documentElement: { lang: "en" },
      addEventListener: () => {},
    };
    const ctx = vm.createContext({ window, document, Intl });
    for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"])
      try {
        vm.runInContext(read(f), ctx, { filename: f });
      } catch {
        /* shell.js stops at its first DOM use */
      }
    return window.denMessages as Record<string, Record<string, string>>;
  }
  const cat = catalogs();
  it.each(["en", "es", "ja"])("%s has them", (lang) => {
    const missing = KEYS.filter((k) => !cat[lang]?.[k]);
    expect(missing).toEqual([]);
  });
  it.each(["en", "es"])("%s never says shell in them", (lang) => {
    const hits = KEYS.filter((k) => /\bshells?\b/i.test(cat[lang]?.[k] ?? ""));
    expect(hits).toEqual([]);
  });
  it("ja never says シェル in them", () => {
    expect(KEYS.filter((k) => /シェル/.test(cat.ja?.[k] ?? ""))).toEqual([]);
  });
});
