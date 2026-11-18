/**
 * Issue 252: a person sets one agent's mode in the page, no CLI.
 *
 *   - The agent's ⋯ has Mode: the four choices and Follow project, the
 *     one in effect checked. Choosing one goes through the working
 *     pop-up and says the result; Den restarts the agent at its next
 *     idle, the same conversation, in that mode; an audit row says Den
 *     did it and why; the row says "from its own setting".
 *   - Settings › Project › Agents' mode: a click anywhere on an agent's
 *     row opens the same choices; Follow project returns it to the
 *     project's mode (restarted at idle again, with its audit row).
 *
 * The real web server on the demo distribution (helpers/agents-page-
 * server.ts), nothing faked: the agent runs in the test's session host
 * (a scripted PTY: nothing really runs); its transcript says its turn
 * ended, so it is idle. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1
 * skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import { denAuth, signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
let latest = "";
const TOKEN = "0c5a8d1e-2b7f-4e61-9a3d-5f0e7c2b1a94";
const errors: string[] = [];

/** Each scripted session ends on TERM, as a real one does. */
function endOnTerm(p: ScriptedPty): void {
  const kill = p.kill.bind(p);
  p.kill = (sig: string) => {
    kill(sig);
    setTimeout(() => p.exit(143), 5);
  };
}

/** Its transcript: a turn that ended a minute ago (it is idle). */
function idle(): void {
  const dir = path.join(s!.tmp, "home", ".claude", "projects", "-seeded");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${TOKEN}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", message: { role: "user", content: "go" } },
      {
        type: "assistant",
        message: { role: "assistant", stop_reason: "end_turn", content: [] },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(file, t, t);
}

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = process.env.DEN_PW_WS
      ? await chromium.connect(process.env.DEN_PW_WS, {
          exposeNetwork: "<loopback>",
        })
      : await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  const r = await fetch(`${s.base}/api/workspaces/north/agent-modes`, {
    method: "POST",
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ mode: "auto" }),
  });
  expect(r.status).toBe(200);
  fs.mkdirSync(path.join(s.stateDir, "personas"), { recursive: true });
  fs.writeFileSync(
    path.join(s.stateDir, "personas", "builder.md"),
    "---\nname: builder\n---\nYou build.\n",
  );
  const push = s.made.push.bind(s.made);
  s.made.push = (...ps) => {
    ps.forEach(endOnTerm);
    return push(...ps);
  };
  host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:lead",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  s.seed({
    id: "lead",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: info.ref.id },
    sessionName: "acme-north:lead",
    resumeToken: TOKEN,
    permission: "auto",
  });
  idle();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [host, s],
  });
});

const skip = () => !browser;

async function open(url: string, ready: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 375, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(signInUrl(s!.stateDir, s!.base, url));
  if (new URL(p.url()).hash !== new URL(url, s!.base).hash)
    await p.goto(`${s!.base}${url}`);
  await p.waitForSelector(ready);
  return p;
}

const text = async (p: Page, sel: string) =>
  ((await p.textContent(sel)) ?? "").replace(/\s+/g, " ").trim();
const modeArg = (args: string[]) =>
  args.includes("--permission-mode")
    ? args[args.indexOf("--permission-mode") + 1]
    : undefined;

/** Waits for Den to resume lead's conversation in `flag`. */
async function resumedIn(flag: string, after: number): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const hit = s!.made
      .slice(after)
      .find(
        (m) =>
          m.args.includes("--resume") &&
          m.args.includes(TOKEN) &&
          modeArg(m.args) === flag,
      );
    if (hit) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `not resumed in ${flag}: ${JSON.stringify(s!.made.slice(after).map((m) => m.args))}`,
  );
}

function auditRows(): string[] {
  const f = path.join(s!.stateDir, "audit.jsonl");
  return fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { detail: string }).detail)
    : [];
}

async function waitAudit(detail: string): Promise<void> {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (auditRows().includes(detail)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no audit row "${detail}": ${auditRows().join(" | ")}`);
}

// North's one agent: its row, whichever session it runs as.
const ROW = '#agl .agr[data-kind="agent"][data-state="running"]';
const menuItems = (p: Page) =>
  p
    .locator('.den-pop[role="menu"] .den-mi')
    .evaluateAll((els) =>
      els.map((e) => [
        (e.querySelector(".den-mi-l")?.textContent ?? "").trim(),
        e.getAttribute("aria-checked"),
      ]),
    );

describe("issue 252: one agent's mode, set in the page", () => {
  it("⋯ › Mode: Edits goes through the working pop-up, restarts it at idle in Edits with an audit row, and the row says from its own setting", async () => {
    if (skip()) return;
    const p = await open("/agents", `${ROW} [data-mode]`);
    expect(await text(p, `${ROW} [data-mode]`)).toBe(
      "mode: Auto, from the project",
    );
    await p.click(ROW);
    const more = `.pane [data-act="more"]`;
    await p.waitForSelector(more);
    await p.click(more);
    await p
      .locator('.den-pop[role="menu"] .den-mi', { hasText: /^Mode/ })
      .click();
    await p.waitForSelector('.den-pop[role="menu"] [role="menuitemradio"]');
    expect(await menuItems(p)).toEqual([
      ["Ask for everything", "false"],
      ["Auto-approve edits in the worktree", "false"],
      ["Auto mode", "false"],
      ["Auto-approve all", "false"],
      ["Follow project", "true"],
    ]);
    const before = s!.made.length;
    await p
      .locator('.den-pop[role="menu"] .den-mi', {
        hasText: "Auto-approve edits in the worktree",
      })
      .click();
    // The result, said.
    await p
      .getByText(
        "lead: Edits, its own setting. Den restarts it at its next idle to take it.",
      )
      .first()
      .waitFor({ timeout: 15_000 });
    await resumedIn("acceptEdits", before);
    await waitAudit(
      "restarted lead in north at idle to take mode edits, from its own setting, by Den itself",
    );
    await p.reload();
    await p.waitForFunction(
      (sel) =>
        document.querySelector(sel)?.textContent?.trim() ===
        "mode: Edits, from its own setting (project: Auto)",
      `${ROW} [data-mode]`,
      { timeout: 20_000 },
    );
    await p.context().close();
  }, 120_000);

  it("Settings › Project: a click anywhere on its row opens the choices; Follow project returns it to Auto, restarted at idle", async () => {
    if (skip()) return;
    const PR = '[data-setting="workspace.agents_mode"]';
    const LI = `${PR} [data-pmode-agent="lead"]`;
    const p = await open("/settings?project=north#workspace.agents_mode", LI);
    expect(await text(p, LI)).toBe("lead: Edits, from its own setting");
    // The whole row opens it: a click near its right edge.
    const box = (await p.locator(LI).boundingBox())!;
    await p.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    await p.waitForSelector('.den-pop[role="menu"] [role="menuitemradio"]');
    expect(await menuItems(p)).toEqual([
      ["Ask for everything", "false"],
      ["Auto-approve edits in the worktree", "true"],
      ["Auto mode", "false"],
      ["Auto-approve all", "false"],
      ["Follow project", "false"],
    ]);
    idle();
    const before = s!.made.length;
    await p
      .locator('.den-pop[role="menu"] .den-mi', { hasText: "Follow project" })
      .click();
    await p
      .getByText(
        "lead follows the project now: Auto. Den restarts it at its next idle to take it.",
      )
      .first()
      .waitFor({ timeout: 15_000 });
    await p.waitForFunction(
      (sel) =>
        document
          .querySelector(sel)
          ?.textContent?.replace(/\s+/g, " ")
          .trim()
          .startsWith("lead: Auto, from the project"),
      LI,
      { timeout: 15_000 },
    );
    await resumedIn("auto", before);
    await waitAudit(
      "restarted lead in north at idle to take mode auto, from its project, by Den itself",
    );
    expect(auditRows()).toContain("set lead's mode to edits in north");
    expect(auditRows()).toContain("set lead's mode to its project's in north");
    await p.context().close();
  }, 120_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
