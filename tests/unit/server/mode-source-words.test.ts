/**
 * Issue 225: the words for an agent's mode and where it comes from, on
 * the Agents page's row (persona-ui.js modeLabel) and in Settings ›
 * Project › Agents' mode (settings-registry.js projectModeHtml): its
 * source in plain words, "runs as X until restarted" when its process
 * differs, and the offer for the N agents with their own setting. In
 * English (i18n/en.js), and every key in Spanish and Japanese too.
 */
import { beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { enCatalog, installEnShell } from "./helpers/en-catalog.js";

type Row = Record<string, unknown>;
let modeLabel: (r: Row) => string;
let ownModeLabel: (r: Row) => string;
let projectModeHtml: (v: unknown, t: (k: string, v?: Row) => string) => string;
let denWideModeHtml: (
  v: unknown,
  overrides: unknown,
  t: (k: string, v?: Row) => string,
) => string;
let t: (k: string, v?: Row) => string;

beforeAll(async () => {
  installEnShell();
  t = (
    globalThis as unknown as {
      window: { denShell: { t: (k: string, v?: Row) => string } };
    }
  ).window.denShell.t;
  ({ modeLabel, ownModeLabel } =
    await import("../../../src/ui/server/public/persona-ui.js"));
  ({ projectModeHtml, denWideModeHtml } =
    await import("../../../src/ui/server/public/settings-registry.js"));
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "|")
    .replace(/&#39;/g, "'")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

describe("issue 225: the Agents page row says where its mode comes from", () => {
  it("project, persona, the mode for every agent, Den's default", () => {
    const row = (mode: string, modeSource: string) =>
      modeLabel({ kind: "agent", mode, modeSource });
    expect(row("auto", "project")).toBe("mode: Auto, from the project");
    expect(row("edits", "persona")).toBe("mode: Edits, from its persona");
    // Issue 268: the Den-wide default, as Settings names it.
    expect(row("all", "install")).toBe("mode: All, from the Den-wide default");
    expect(row("ask", "default")).toBe(
      "mode: Ask, from Den's built-in default",
    );
  });

  it("its own setting, and the project's it doesn't follow", () => {
    const own = {
      kind: "agent",
      mode: "ask",
      modeSource: "own",
      modeOwn: true,
    };
    expect(modeLabel(own)).toBe("mode: Ask, from its own setting");
    expect(modeLabel({ ...own, modeFollowed: "all" })).toBe(
      "mode: Ask, from its own setting (project: All)",
    );
    expect(ownModeLabel({ kind: "agent", mode: "all" })).toBe("");
  });

  it("a row from an older Den (no source): its mode, as before", () => {
    expect(modeLabel({ kind: "agent", mode: "edits" })).toBe("mode: Edits");
  });

  it("a process in another mode: runs as it until restarted", () => {
    expect(t("ag.mode.drift", { want: "Auto", running: "Ask" })).toBe(
      "Set to Auto. Runs as Ask until restarted.",
    );
  });
});

describe("issue 225: Settings › Project › Agents' mode", () => {
  const view = {
    project: "north",
    mode: "auto",
    install: null,
    own: 2,
    agents: [
      { agent: "lead", mode: "auto", source: "project" },
      {
        agent: "scout",
        name: "Scout",
        mode: "all",
        source: "project",
        running: "auto",
      },
      { agent: "pinned", mode: "ask", source: "own" },
      { agent: "quiet", mode: "edits", source: "own", stopped: true },
    ],
  };

  it("the project's mode pressed; each agent's mode and source; the offer with N", () => {
    const html = projectModeHtml(view, t);
    expect(html).toContain('data-pmode="auto" aria-pressed="true"');
    expect(html).toContain('data-pmode="none" aria-pressed="false"');
    expect(text(html)).toEqual([
      "Use Den-wide",
      "Ask for everything",
      "Auto-approve edits in the worktree",
      "Auto mode",
      "Auto-approve all",
      "Set for this project: Auto mode (Den-wide is each persona's own mode)",
      "Change the Den-wide default",
      "lead: Auto, from the project",
      "Scout: All, from the project. Runs as Auto until restarted.",
      "pinned: Ask, from its own setting",
      "quiet: Edits, from its own setting",
      "stopped",
      "Also apply to the 2 agents with their own setting",
    ]);
    expect(html).toContain('data-pmode-offer="2"');
  });

  it("one agent with its own setting: singular; none: no offer", () => {
    expect(text(projectModeHtml({ ...view, own: 1 }, t))).toContain(
      "Also apply to the 1 agent with its own setting",
    );
    const none = projectModeHtml({ ...view, own: 0 }, t);
    expect(none).not.toContain("data-pmode-offer");
  });

  it("issue 268: following Den-wide until set; set, it names both; a link to the Den-wide row", () => {
    const html = projectModeHtml({ ...view, mode: null, install: "auto" }, t);
    expect(text(html)).toContain("Following Den-wide: Auto mode");
    expect(html).toContain('data-pmode-now="den-wide"');
    expect(html).toContain('data-pmode="none" aria-pressed="true"');
    expect(html).toContain('href="/settings#agents.default_mode"');
    expect(
      text(projectModeHtml({ ...view, mode: "ask", install: "auto" }, t)),
    ).toContain(
      "Set for this project: Ask for everything (Den-wide is Auto mode)",
    );
  });

  it("no agents: says so", () => {
    expect(
      text(projectModeHtml({ mode: null, agents: [], own: 0 }, t)),
    ).toContain("No agents in this project yet.");
  });
});

describe("issue 268: Settings › Agents › the Den-wide default", () => {
  it("what is in effect, and the projects that override it, each linked", () => {
    const html = denWideModeHtml("auto", ["north", "south"], t);
    expect(html).toContain('data-dwmode="auto" aria-pressed="true"');
    expect(text(html)).toEqual([
      "Each persona's",
      "Ask for everything",
      "Auto-approve edits",
      "Auto mode",
      "Auto-approve all",
      "In effect Den-wide: Auto mode",
      "2 projects override this:",
      "north",
      ",",
      "south",
    ]);
    expect(html).toContain(
      'href="/settings?project=north#workspace.agents_mode"',
    );
    expect(text(denWideModeHtml("ask", ["north"], t))).toContain(
      "1 project overrides this:",
    );
  });

  it("unset: each persona's own mode; none overrides: says so", () => {
    const html = denWideModeHtml(undefined, [], t);
    expect(html).toContain('data-dwmode="persona" aria-pressed="true"');
    expect(text(html)).toContain("In effect Den-wide: each persona's own mode");
    expect(text(html)).toContain("No project overrides this.");
  });
});

describe("issue 225: every new word in es and ja", () => {
  const KEYS = [
    "ag.mode.from",
    "ag.mode.own",
    "ag.mode.ownNot",
    "ag.mode.drift",
    "ag.mode.src.own",
    "ag.mode.src.project",
    "ag.mode.src.install",
    "ag.mode.src.persona",
    "ag.mode.src.default",
    "set.workspace.agents_mode",
    "set.workspace.agents_mode.d",
    "pmode.none",
    "pmode.agent",
    "pmode.runsAs",
    "pmode.stopped",
    "pmode.noAgents",
    "pmode.follow",
    "pmode.followW",
    "pmode.followS",
    "pmode.followF",
    "pmode.failed",
    // Issue 268.
    "set.agents.default_mode",
    "set.agents.default_mode.d",
    "pmode.following",
    "pmode.setHere",
    "pmode.changeDw",
    "dwmode.now",
    "dwmode.persona",
    "dwmode.over",
    "dwmode.overNone",
  ];
  const catalog = (lang: string): Record<string, string> => {
    const window: Record<string, unknown> = {};
    vm.runInContext(
      fs.readFileSync(
        path.join(
          process.cwd(),
          "src",
          "ui",
          "server",
          "public",
          "i18n",
          `${lang}.js`,
        ),
        "utf-8",
      ),
      vm.createContext({ window }),
    );
    return (window.denMessages as Record<string, Record<string, string>>)[lang];
  };

  it.each(["es", "ja"])("%s has each, translated", (lang) => {
    const en = enCatalog();
    const table = catalog(lang);
    for (const k of KEYS) {
      expect({ k, has: typeof table[k] }).toEqual({ k, has: "string" });
      expect({ k, same: table[k] === en[k] }).toEqual({ k, same: false });
    }
    expect(table["ag.mode.drift"]).not.toMatch(/Runs as/);
  });
});
