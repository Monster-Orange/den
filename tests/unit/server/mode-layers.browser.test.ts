/**
 * Issue 268: an agent's mode has two settings a person sets, the
 * Den-wide default (Settings › Agents) and a project's override of it
 * (Settings › Project setup). Each row names both layers the same way,
 * says which wins, shows what is in effect and where it comes from, and
 * links to the other; the Agents list says the same words.
 *
 * The real web server on the demo distribution (helpers/agents-page-
 * server.ts), nothing faked: the Den-wide default is Auto mode, north
 * overrides it with Ask for everything, south follows it. One agent in
 * each, running in the test's session host (nothing really runs).
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 * Invented names only.
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
const sid: Record<string, string> = {};
const errors: string[] = [];

async function projectMode(ws: string, mode: string | null): Promise<void> {
  const r = await fetch(`${s!.base}/api/workspaces/${ws}/agent-modes`, {
    method: "POST",
    headers: { ...denAuth(s!.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (r.status !== 200) throw new Error(`agent-modes: ${r.status}`);
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
  // The modes first, so no running agent is moved to them.
  expect(await s.settings({ agents_default_mode: "auto" })).toBe(200);
  await projectMode("north", "ask");
  // A persona, so each agent's mode resolves (and says where from).
  fs.mkdirSync(path.join(s.stateDir, "personas"), { recursive: true });
  fs.writeFileSync(
    path.join(s.stateDir, "personas", "builder.md"),
    "---\nname: builder\n---\nYou build.\n",
  );
  host = await connectHost(sessionPaths(s.stateDir).socket);
  for (const [id, ws] of [
    ["lead", "north"],
    ["scout", "south"],
  ] as const) {
    const info = await host.start({
      name: `acme-${ws}:${id}`,
      cwd: s.wsDir(ws),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    sid[id] = info.ref.id;
    s.seed({
      id,
      persona: "builder",
      runtime: "den-claude",
      workspace: ws,
      session: { backend: "den-pty", id: info.ref.id },
      sessionName: `acme-${ws}:${id}`,
    });
  }
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
  // Signing in keeps the path, not the #: open the link itself.
  if (new URL(p.url()).hash !== new URL(url, s!.base).hash)
    await p.goto(`${s!.base}${url}`);
  await p.waitForSelector(ready);
  return p;
}

const DW = '[data-setting="agents.default_mode"]';
const PR = '[data-setting="workspace.agents_mode"]';
const text = async (p: Page, sel: string) =>
  ((await p.textContent(sel)) ?? "").replace(/\s+/g, " ").trim();
const ORDER =
  "Which wins: an agent's own setting, then the project, then the Den-wide default, then its persona.";

describe("issue 268: the Den-wide default and a project's override say which is which", () => {
  it("the Den-wide row: its layer, the order, what is in effect, and 1 project overrides this, linked", async () => {
    if (skip()) return;
    const p = await open(
      "/settings#agents.default_mode",
      `${DW} [data-dw-overrides]`,
    );
    expect(await text(p, `${DW} .l`)).toBe("Agents' mode: Den-wide default");
    expect(await text(p, `${DW} .d`)).toContain(ORDER);
    expect(
      await p.getAttribute(`${DW} [data-dwmode="auto"]`, "aria-pressed"),
    ).toBe("true");
    expect(await text(p, `${DW} [data-dw-now]`)).toBe(
      "In effect Den-wide: Auto mode",
    );
    expect(await text(p, `${DW} [data-dw-overrides]`)).toBe(
      "1 project overrides this: north",
    );
    expect(await p.getAttribute(`${DW} [data-dw-overrides] a`, "href")).toBe(
      "/settings?project=north#workspace.agents_mode",
    );
    // A row's id in the URL lands on its row's category.
    await p.waitForFunction(
      () =>
        document
          .querySelector('.set-ni[data-cat="agents"]')
          ?.getAttribute("aria-current") === "true",
    );
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 60_000);

  it("a project that follows: Following Den-wide, and a link to change it", async () => {
    if (skip()) return;
    const p = await open(
      "/settings?project=south#workspace.agents_mode",
      `${PR} [data-pmode-now]`,
    );
    expect(await text(p, `${PR} .l`)).toBe(
      "Agents' mode: this project (overrides the Den-wide default)",
    );
    expect(await text(p, `${PR} .d`)).toContain(ORDER);
    expect(await text(p, `${PR} [data-pmode-now]`)).toBe(
      "Following Den-wide: Auto mode",
    );
    expect(
      await p.getAttribute(`${PR} [data-pmode="none"]`, "aria-pressed"),
    ).toBe("true");
    expect(await text(p, `${PR} [data-pmode="none"]`)).toBe("Use Den-wide");
    expect(await text(p, `${PR} [data-pmode-dw]`)).toBe(
      "Change the Den-wide default",
    );
    expect(await p.getAttribute(`${PR} [data-pmode-dw]`, "href")).toBe(
      "/settings#agents.default_mode",
    );
    expect(await text(p, `${PR} [data-pmode-agent="scout"]`)).toBe(
      "scout: Auto, from the Den-wide default",
    );
    await p.context().close();
  }, 60_000);

  it("the Agents list says the same words for each agent's source", async () => {
    if (skip()) return;
    const row = (id: string) => `#agl .agr[data-id="${sid[id]}"] [data-mode]`;
    const p = await open("/agents", row("scout"));
    await p.waitForSelector(row("lead"));
    expect(await text(p, row("lead"))).toBe("mode: Ask, from the project");
    expect(await text(p, row("scout"))).toBe(
      "mode: Auto, from the Den-wide default",
    );
    await p.context().close();
  }, 60_000);

  it("a project that overrides: Set for this project; Use Den-wide clears it", async () => {
    if (skip()) return;
    const p = await open(
      "/settings?project=north#workspace.agents_mode",
      `${PR} [data-pmode-now]`,
    );
    expect(await text(p, `${PR} [data-pmode-now]`)).toBe(
      "Set for this project: Ask for everything (Den-wide is Auto mode)",
    );
    expect(await text(p, `${PR} [data-pmode-agent="lead"]`)).toBe(
      "lead: Ask, from the project",
    );
    await p.click(`${PR} [data-pmode="none"]`);
    await p.waitForFunction(
      (sel) =>
        /Following Den-wide: Auto mode/.test(
          document.querySelector(`${sel} [data-pmode-now]`)?.textContent ?? "",
        ),
      PR,
    );
    expect(
      ((await s!.settingsGet()) as { agents_mode_overrides?: unknown })
        .agents_mode_overrides,
    ).toEqual([]);
    // The Den-wide row says no project overrides it now.
    await p.goto(`${s!.base}/settings#agents.default_mode`);
    await p.waitForSelector(`${DW} [data-dw-overrides]`);
    expect(await text(p, `${DW} [data-dw-overrides]`)).toBe(
      "No project overrides this.",
    );
    await p.context().close();
  }, 60_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
