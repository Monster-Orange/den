/**
 * MODE-5 (0.4.46): every command of the CLI is listed here with what a
 * person has on a page for it: a read (nothing to change), a page control
 * (named by a marker its page holds), script-only (and why), or a gap with
 * the release it is slotted in. A new command or subcommand that isn't
 * listed fails, and so does a page control whose marker is gone.
 *
 * Commands come from the CLI's own registered list (TELEMETRY_COMMANDS in
 * index.ts); subcommands from each command's dispatcher.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const CLI = path.join(process.cwd(), "src", "ui", "cli");
const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (dir: string, f: string) =>
  fs.readFileSync(path.join(dir, f), "utf-8");

type Entry =
  | { read: true }
  | { page: string; marker: string }
  | { script: string }
  | { slot: string; why: string };

const R: Entry = { read: true };
const page = (file: string, marker: string): Entry => ({ page: file, marker });
const script = (why: string): Entry => ({ script: why });
const slot = (release: string, why: string): Entry => ({ slot: release, why });

/** `command` or `command sub`. */
const LISTING: Record<string, Entry> = {
  run: page("index.html", "/api/run"),
  "view-results": R,
  menu: script("the interactive terminal menu"),
  up: page("svc-panel.js", "/api/service/exec"),
  down: page("svc-panel.js", "/api/service/exec"),
  restart: page("svc-panel.js", "/api/service/exec"),
  status: R,
  logs: R,
  services: R,
  graph: R,
  register: page("services.html", "/api/workspaces/services"),
  relocate: slot("0.4.47", "a checkout moved on disk"),
  "use-local": page("local-dev.html", "/api/workspaces/services/mode"),
  "use-managed": page("local-dev.html", "/api/workspaces/services/mode"),
  setup: page("local-dev.html", "runWorkspaceCmd('setup')"),
  sync: page("local-dev.html", "/api/workspace/sync"),
  org: R,
  init: script("scaffolds a repo's manifest"),
  validate: R,
  create: script("scaffolds a new distribution"),
  "local-dev": page("settings-registry.js", 'id: "cli.local_dev"'),
  config: page("settings-registry.js", 'id: "cli.cli_tabs"'),
  doctor: R,
  apps: R,
  applications: R,
  mcp: script("the stdio MCP server and agent registration"),
  usage: R,
  feedback: page("shell.js", 'data-act="report"'),
  onboard: R,
  repo: R,

  "workspace list": R,
  "workspace activate": page("header.js", "/api/workspaces"),
  "workspace deactivate": page("header.js", "/api/workspaces"),
  "workspace focus": page("header.js", "/api/workspaces"),
  "workspace use": page("header.js", "/api/workspaces"),
  "workspace create": page("services.html", "/api/workspaces"),
  "workspace delete": page("local-dev.html", "/api/workspaces"),
  "workspace code": script("opens the project in an editor"),
  "workspace seed": script("seeds the default project"),

  "web token": script("prints a credential for scripts; never on a page"),
  "web login": page("settings-registry.js", "/api/web/pair"),
  "web sessions": R,
  "web logout": page("settings-registry.js", "data-signout-all"),
  "web owner": page("settings-registry.js", "/api/web/owner"),
  "web approve": page("settings-registry.js", "/api/web/approve"),
  "web claim-link": script("a setup link for a new device, from a shell"),
  "web url": page("settings-registry.js", "/api/web-url"),

  "edge up": slot("0.4.47", "start the edge"),
  "edge down": slot("0.4.47", "stop the edge"),
  "edge trust": slot("0.4.47", "trust the local certificate"),
  "edge untrust": slot("0.4.47", "untrust the local certificate"),
  "edge status": R,
  "edge routes": R,

  "service install": slot("0.4.47", "start at login (launchd)"),
  "service uninstall": slot("0.4.47", "stop starting at login"),
  "service status": R,
  "service print": R,

  "stack up": slot("0.4.47", "start a stack"),
  "stack down": slot("0.4.47", "stop a stack"),
  "stack restart": slot("0.4.47", "restart a stack"),
  "stack ls": R,
  "stack ps": R,
  "stack logs": R,
  "stack health": R,

  "sessions start": page("agents-page.js", "/sessions"),
  "sessions kill": page("agents-page.js", "/close"),
  "sessions list": R,
  "sessions attach": R,
  "sessions host": script("the terminal host process itself"),

  "notifications list": R,
  "notifications read": page("bell.js", "/api/notifications"),

  "hub link": page("settings-registry.js", "/hub-project"),

  "usage agents": R,
  "usage report": R,

  "repo detect": R,

  "theme add": slot("0.4.48", "add a theme"),
  "theme remove": slot("0.4.48", "remove a theme"),
  "theme new": slot("0.4.48", "start a theme"),
  "theme list": R,
  "theme validate": R,
  "plugin add": slot("0.4.48", "add a plugin"),
  "plugin update": slot("0.4.48", "update a plugin"),
  "plugin remove": slot("0.4.48", "remove a plugin"),
  "plugin list": R,
  "plugin validate": R,

  "agents list": R,
  "agents helpers": R,
  "agents files": R,
  "agents personas": R,
  "agents doctor": R,
  "agents start": page("agents-page.js", "`${wsUrl}/agents`"),
  "agents stop": page("agents-page.js", "/stop"),
  "agents resume": page("agents-page.js", "/resume"),
  "agents relaunch": page("agents-page.js", '"relaunch"'),
  "agents restart": page("agents-page.js", 'agentPath(r, "restart"'),
  "agents rotate": page("settings-registry.js", "/api/agents/rotation"),
  "agents keep": page("agents-page.js", 'agentPath(r, "keep"'),
  "agents set": page("agents-page.js", "/settings"),
  "agents handoff": page("agents-page.js", 'agentPath(r, "handoff"'),
  "agents import": page("agents-page.js", "/import"),
  "agents persona": page("agents-page.js", "/persona"),
  "agents rename": page("agents-page.js", 'agentPath(r, "name"'),
  "agents move": page("agents-page.js", 'agentPath(r, "move"'),
  "agents link": page("agents-page.js", 'agentPath(r, "link"'),
  "agents unlink": page("agents-page.js", 'agentPath(r, "link"'),
  "agents rm": page("agents-page.js", 'agentPath(r, "remove"'),
  "agents handback-check": script("a linter for agents' hand-backs"),
  "agents handoff-check": script("a linter for agents' hand-offs"),
  "agents permission": slot(
    "0.4.46",
    "MODE-1: a project's and an agent's mode",
  ),
};

/**
 * Commands whose subcommands are listed one by one, the file that
 * dispatches them, and the labels there that aren't subcommands.
 */
const DISPATCH: Record<string, { file: string; not?: string[] }> = {
  web: { file: "web-command.ts", not: ["show", "unlink"] },
  edge: { file: "edge-command.ts" },
  service: {
    file: "service-command.ts",
    not: ["foreign", "none", "ours", "unresponsive"],
  },
  stack: { file: "stack-command.ts" },
  sessions: { file: "sessions-command.ts" },
  notifications: { file: "notifications-command.ts" },
  hub: { file: "hub-command.ts" },
  theme: { file: "theme-command.ts" },
  plugin: { file: "plugin-command.ts" },
  usage: { file: "usage-command.ts" },
  repo: { file: "repo-command.ts" },
  onboard: { file: "onboard-command.ts" },
};

/** The CLI's registered commands (index.ts TELEMETRY_COMMANDS). */
function commands(): string[] {
  const src = read(CLI, "index.ts");
  const m = /const TELEMETRY_COMMANDS = new Set<string>\(\[([\s\S]*?)\]\)/.exec(
    src,
  );
  expect(m).not.toBeNull();
  return [
    ...new Set([...m![1]!.matchAll(/["`]([a-z-]+)["`]/g)].map((x) => x[1]!)),
  ];
}

/** A dispatcher's labels: `case "x":`, `args[0] === "x"`, `sub === "x"`. */
function labels(file: string): string[] {
  const src = read(CLI, file);
  return [
    ...new Set(
      [
        ...src.matchAll(/(?:args\[0\] === |case |sub === )"([a-z][a-z-]*)"/g),
      ].map((x) => x[1]!),
    ),
  ];
}

/** `agents`: its `switch (sub)`; `workspace`: WORKSPACE_SUBCOMMANDS. */
function agentsSubs(): string[] {
  const src = read(CLI, "agents-command.ts");
  const at = src.indexOf("switch (sub) {");
  expect(at).toBeGreaterThan(0);
  const block = src.slice(at, src.indexOf("default:", at));
  return [...block.matchAll(/case "([a-z-]+)":/g)].map((x) => x[1]!);
}
function workspaceSubs(): string[] {
  const src = read(CLI, "index.ts");
  const at = src.indexOf("const WORKSPACE_SUBCOMMANDS");
  const block = src.slice(at, src.indexOf("\n];", at));
  return [...block.matchAll(/name: "([a-z-]+)"/g)].map((x) => x[1]!);
}

/** Every command and subcommand, as the listing names them. */
function everything(): string[] {
  const out: string[] = [];
  for (const c of commands()) {
    if (c === "agents") out.push(...agentsSubs().map((s) => `agents ${s}`));
    else if (c === "workspace")
      out.push(...workspaceSubs().map((s) => `workspace ${s}`));
    else if (DISPATCH[c]) {
      const d = DISPATCH[c]!;
      const subs = labels(d.file).filter((s) => !(d.not ?? []).includes(s));
      out.push(...subs.map((s) => `${c} ${s}`));
    } else out.push(c);
  }
  return out;
}

describe("MODE-5: every CLI command has its page control listed", () => {
  it("reads the commands and subcommands from the CLI", () => {
    const all = everything();
    expect(all).toEqual(
      expect.arrayContaining([
        "feedback",
        "agents permission",
        "web logout",
        "edge trust",
        "workspace create",
      ]),
    );
  });

  it("every command and subcommand is listed", () => {
    expect(everything().filter((c) => !(c in LISTING))).toEqual([]);
  });

  it("every page control it names is on that page", () => {
    const missing = Object.entries(LISTING)
      .filter(
        (e): e is [string, { page: string; marker: string }] => "page" in e[1],
      )
      .filter(([, e]) => !read(PUBLIC, e.page).includes(e.marker))
      .map(([c, e]) => `${c}: ${e.page} has no ${e.marker}`);
    expect(missing).toEqual([]);
  });

  it("a gap names its release; script-only says why", () => {
    for (const [c, e] of Object.entries(LISTING)) {
      if ("slot" in e)
        expect([c, /^0\.4\.\d+$/.test(e.slot)]).toEqual([c, true]);
      if ("script" in e) expect([c, e.script.length > 5]).toEqual([c, true]);
    }
  });
});
