import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { agentLinks, agentPagePath } from "../../../src/shared/agent-links.js";
import { agentLink } from "../../../src/shared/alerts.js";
import { noteCapHeld } from "../../../src/ui/server/cap-bell.js";
import {
  SERVER_AGENT_ID,
  SERVER_SCOPE,
} from "../../../src/shared/agents/server-agent.js";

const QUESTION = "Which repo should I set up first?";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({ fresh: true });
  const [newest] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = newest?.version ?? "";
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

async function page(at: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch (e) {
      void e;
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await signInPage(p, s!.stateDir, s!.base, at);
  return p;
}

async function onServerAgentWithQuestion(p: Page): Promise<void> {
  await p.waitForFunction(
    () =>
      document.querySelector("#den-shell")?.getAttribute("data-page") ===
      "server-agent",
    undefined,
    { timeout: 20_000 },
  );
  expect(new URL(p.url()).pathname).toBe("/server-agent");
  await p.waitForFunction(
    (q) => (document.querySelector("#sa-pane")?.textContent ?? "").includes(q),
    QUESTION,
    { timeout: 20_000 },
  );
}

describe("issue 1811: links to the server agent open its page", () => {
  let rows: { kind: string; id: string }[] = [];

  beforeAll(async () => {
    if (!browser) return;
    const p = await page("/");
    await p.waitForSelector("#sa-pane [data-id]", { timeout: 20_000 });
    s!.made[0].emit(`${QUESTION}\r\n`);
    await p.context().close();

    const st = new NotificationStore(s!.stateDir);
    const asked = st.add({
      kind: "waiting",
      subject: `agent:${SERVER_AGENT_ID}`,
      scope: `workspace/${SERVER_SCOPE}`,
      text: `Acme agent asked: ${QUESTION}`,
      msg: {
        key: "bell.m.asked",
        vars: { name: "Acme agent", text: QUESTION },
      },
      link: agentPagePath(SERVER_SCOPE, SERVER_AGENT_ID),
    });
    expect(
      noteCapHeld(st, {
        agent: SERVER_AGENT_ID,
        name: "Acme agent",
        project: SERVER_SCOPE,
        why: "4 agents are running and agents.max_concurrent is 4",
      }),
    ).toBe(true);
    const cap = st
      .list()
      .find((n) => n.subject === `record:cap-held:${SERVER_AGENT_ID}`);
    rows = [
      { kind: "question", id: String(asked?.id) },
      { kind: "bell", id: String(cap?.id) },
    ];
  }, 90_000);

  it("each bell row's link is /server-agent, never the reserved scope", () => {
    if (!browser) return;
    const st = new NotificationStore(s!.stateDir);
    const links = rows.map(
      (r) => st.list().find((n) => String(n.id) === r.id)?.link,
    );
    expect(links).toEqual(["/server-agent", "/server-agent"]);
  });

  for (const kind of ["bell", "question"]) {
    it(`the ${kind} row opens the server agent, its question on screen`, async () => {
      if (!browser) return;
      const id = rows.find((r) => r.kind === kind)!.id;
      const p = await page("/services");
      await p.waitForSelector("#den-bell");
      await p.click("#den-bell");
      await p.locator("#den-bell-pop").waitFor();
      const updates = p.locator(
        '#den-bell-pop [data-bell="updates"][aria-expanded="false"]',
      );
      if (kind === "bell" && (await updates.count())) await updates.click();
      const a = p.locator(
        `#den-bell-pop [data-id="${id}"] a[data-bell="open"]`,
      );
      await a.waitFor({ timeout: 15_000 });
      expect(await a.getAttribute("href")).toBe("/server-agent");
      await a.click();
      await onServerAgentWithQuestion(p);
      await p.context().close();
    }, 90_000);
  }

  it("a desktop or phone alert's link opens the server agent, its question on screen", async () => {
    if (!browser) return;
    const at = agentLink(SERVER_SCOPE, SERVER_AGENT_ID);
    expect(at).toBe("/server-agent");
    const p = await page(at);
    await onServerAgentWithQuestion(p);
    await p.context().close();
  }, 90_000);

  it("the agent's own link (an MCP reply's) opens the server agent, its question on screen", async () => {
    if (!browser) return;
    const l = agentLinks(
      "https://den.example.test",
      SERVER_SCOPE,
      SERVER_AGENT_ID,
    );
    expect(l?.agent).toBe("https://den.example.test/server-agent");
    const p = await page(new URL(l!.agent).pathname);
    await onServerAgentWithQuestion(p);
    await p.context().close();
  }, 90_000);

  it("no page error", () => {
    expect(errors).toEqual([]);
  });
});
