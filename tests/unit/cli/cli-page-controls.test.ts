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
import { AGENTS_ENTRY, agentsSource } from "../server/helpers/agents-source.js";

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
  // Issue 95: the top bar's Report button is drawn by the UI kit
  // (shell-html.js's reportButtonHtml), through shell.js.
  feedback: page("shell.js", "DUI.reportButtonHtml("),
  // Issue 565: the same command, by the button's own name.
  report: page("shell.js", "DUI.reportButtonHtml("),
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
  // Issue 393: Settings › Browser sign-in's Sign in button.
  "web login": page("settings-registry.js", 'id="set-signin"'),
  "web sessions": R,
  "web logout": page("settings-registry.js", "data-signout-all"),
  // Issue 810: setup is Settings' Set up test person; the command only says so.
  "web fixture-person": page(
    "settings-registry.js",
    '"/api/web/fixture-person"',
  ),
  "web fixture-login": script(
    "the live-check runner's one-time link on a test install; never on a page",
  ),
  "web owner": page("settings-registry.js", "/api/web/owner"),
  "web approve": page("settings-registry.js", "/api/web/approve"),
  "web claim-link": script("a setup link for a new device, from a shell"),
  "web url": page("settings-registry.js", "/api/web-url"),

  // Issue 395: Settings › Access › Start the edge (Apply, when it runs).
  "edge up": page("settings-registry.js", "/api/edge/up"),
  "edge down": slot("0.4.47", "stop the edge"),
  "edge trust": slot("0.4.47", "trust the local certificate"),
  "edge untrust": slot("0.4.47", "untrust the local certificate"),
  "edge status": R,
  "edge routes": R,
  // Issue 455: prints a route; the Edge page shows the same (it reads).
  "edge route": R,

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
  // Issue 1008: an agent withdraws its own question (its token).
  ask: script("an agent withdraws its own question, settled elsewhere"),

  // The shared GitHub watcher's line: doctor shows it too (a read).
  "github status": R,

  "hub link": page("settings-registry.js", "/hub-project"),
  // Issue 750: the Agents page's own groups read (By group), printed.
  "hub groups": R,
  // den#49: an agent's commands, with its own Den token; a person uses Hub.
  "hub put": script("an agent publishes an artifact's files to Hub"),
  "hub pull": script("an agent fetches an artifact's files from Hub"),

  "usage agents": R,
  "usage report": R,

  // Issue 144: the machine's gate slots.
  "gate run": script("wraps a test command, in a terminal or a gate script"),
  "gate status": page("agents.html", 'id="ag-gate"'),
  "gate end": page("gate-chip.js", "/api/gate-slots/end"),
  // Issue 795: the waiting run's owner (an agent's shell, or MCP) yields.
  "gate yield": script("a waiting run's owner lets one run ahead of it"),
  "gate settings": page("settings-registry.js", 'id: "server.gate_cpu"'),
  // Issue 625: the test boxes, set on the Settings page.
  "gate box": page("settings-registry.js", 'id: "server.gate_boxes"'),
  // Issue 642: the CI runner entries, set on the Settings page.
  "gate runner": page(
    "settings-registry.js",
    'id: "server.gate_runner_entries"',
  ),

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
  // Gap 7 (0.4.48): the CLI first; the agent menu's "Change folder" after.
  "agents folder": slot("0.4.50", "move a stopped agent to another folder"),
  "agents unlink": page("agents-page.js", 'agentPath(r, "link"'),
  "agents rm": page("agents-page.js", 'agentPath(r, "remove"'),
  "agents handback-check": script("a linter for agents' hand-backs"),
  "agents handoff-check": script("a linter for agents' hand-offs"),
  // Issue 163 (b): `claude setup-token` prints it in a terminal; it is
  // pasted at a prompt there or piped in, never through a page.
  "agents token": script(
    "the agents' sign-in token, pasted at a terminal prompt or piped in",
  ),
  // Issue 339: each vendor's accounts, under Settings › Keep agents running
  // after logout (one row per account). `agents accounts` lists them on the
  // page; each subcommand has its control there, but remove.
  "agents accounts": page("settings-registry.js", "data-acct-runtime"),
  "agents accounts list": page("settings-registry.js", "data-acct-runtime"),
  "agents accounts add": page("settings-registry.js", '"/api/agents/accounts"'),
  "agents accounts set-token": page(
    "settings-registry.js",
    '"/api/agents/accounts/token"',
  ),
  "agents accounts order": page(
    "settings-registry.js",
    '"/api/agents/accounts/order"',
  ),
  "agents accounts remove": slot(
    "0.4.67",
    "remove a vendor's account and its token (the CLI only for now)",
  ),
  // Issue 441: an outside runner (the bed gate) hands its verdict file to
  // the CLI; the Checks page shows the run it makes.
  "verify import": script("an outside runner's verdict file, from its script"),
  "verify remove": script("takes back an imported run, from a gate's cleanup"),
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
  // `web owner` link, show and unlink.
  web: { file: "web-command.ts", not: ["link", "show", "unlink"] },
  edge: { file: "edge-command.ts" },
  service: {
    file: "service-command.ts",
    not: ["foreign", "none", "ours", "unresponsive"],
  },
  stack: { file: "stack-command.ts" },
  sessions: { file: "sessions-command.ts" },
  notifications: { file: "notifications-command.ts" },
  github: { file: "github-command.ts" },
  hub: { file: "hub-command.ts" },
  theme: { file: "theme-command.ts" },
  plugin: { file: "plugin-command.ts" },
  usage: { file: "usage-command.ts" },
  gate: { file: "gate-command.ts" },
  repo: { file: "repo-command.ts" },
  onboard: { file: "onboard-command.ts" },
  verify: { file: "verify-command.ts" },
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
      .filter(
        ([, e]) =>
          !(
            e.page === AGENTS_ENTRY ? agentsSource() : read(PUBLIC, e.page)
          ).includes(e.marker),
      )
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
