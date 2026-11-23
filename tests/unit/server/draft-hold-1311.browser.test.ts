/**
 * Issue 1311, in Den's terminal: a person types part of a message to an
 * agent and Den has a message for it. Den never sends their draft: the
 * draft stays on the line, unsent and whole, and the pane says "1 message
 * waiting". Enter sends the draft alone; Den's message goes in after it.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts): no runtime runs. The
 * message is a web app's relayed one (POST /api/embed/say with an app
 * key), held by the same delivery loop as a Hub comment.
 * Covers draft-input.ts (the keys), session-routes.ts (the attach and its
 * "waiting" frame), agent-ops.ts (the hold), hub-delivery-service.ts and
 * agents-page.js (the pane's tag).
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
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
import { ServerKeys } from "../../../src/ui/server/embed-server-keys.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";
import { enCatalog } from "./helpers/en-catalog.js";

const ORIGIN = "https://app.example.test";
const TOKEN = "7a1c2d3e-4b5c-4d6e-8f70-112233445566";
const MESSAGE = "a message from the app for planner";
/** The person's unsent draft. */
const DRAFT = "half a sen";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
let browser: Browser | null = null;
let latest = "";
let sid = "";
let made = -1;

/** Claude Code's input box, its line holding `line`. */
const box = (line: string) =>
  "\x1b[2J\x1b[H⏺ Done: the build passes.\r\n\r\n" +
  "────────────────────────────────────────\r\n" +
  `> ${line}\r\n` +
  "────────────────────────────────────────\r\n" +
  "  ? for shortcuts\r\n";

const json = (o: unknown) => `${JSON.stringify(o)}\n`;
/** Its turn is over: the transcript reads idle. */
const idle = () =>
  json({
    type: "user",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "plan the release" },
  }) +
  json({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { role: "assistant", stop_reason: "end_turn", content: [] },
  });

beforeAll(async () => {
  try {
    browser = await launchBrowser((await import("playwright")).chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({
    userYml: `embed:\n  origins: ["${ORIGIN}"]\n`,
  });
  host = await connectHost(sessionPaths(s.stateDir).socket);
  const [newest] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = newest?.version ?? "";
  const info = await host.start({
    name: "acme-north:planner",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  sid = info.ref.id;
  made = s.made.length - 1;
  s.seed({
    id: "planner",
    persona: "planner",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: sid },
    sessionName: "acme-north:planner",
    resumeToken: TOKEN,
  });
  fs.writeFileSync(
    path.join(
      s.tmp,
      "home",
      ".claude",
      "projects",
      "-seeded",
      `${TOKEN}.jsonl`,
    ),
    idle(),
  );
  pty().emit(box(""));
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [host, s] });
});

const skip = () => !browser;
const pty = () => s!.made[made]!;
/** What the person and Den typed since `from`, terminal reports left out. */
const written = (from: number) =>
  Buffer.concat(pty().writes.slice(from))
    .toString("utf-8")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

async function eventually(
  pred: () => Promise<boolean> | boolean,
  ms: number,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function open(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, s!.stateDir, s!.base);
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  await p.goto(`${s!.base}/agents?open=${sid}&layout=tabs`);
  // Its session is attached (the server says so) and its terminal is up.
  await eventually(
    () => s!.log().includes("sessions attach acme-north:planner"),
    20_000,
  );
  await p.waitForSelector(`[data-id="${sid}"] textarea`, { timeout: 20_000 });
  return p;
}

describe("issue 1311: a delivered message never sends the person's draft", () => {
  it("the draft stays on the line, 1 waits; Enter sends the draft alone, then the message", async () => {
    if (skip()) return;
    const p = await open();
    await p.focus(`[data-id="${sid}"] textarea`);
    const from = pty().writes.length;
    await p.keyboard.type(DRAFT);
    await eventually(() => written(from) === DRAFT, 10_000);
    // The runtime echoes it on its input line.
    pty().emit(box(DRAFT));

    // A web app's message for planner, held by the delivery loop.
    const { key } = ServerKeys.at(s!.stateDir).create({
      project: "north",
      agent: "planner",
      origin: ORIGIN,
    });
    const said = await fetch(`${s!.base}/api/embed/say`, {
      method: "POST",
      headers: { "X-Den-Embed-Key": key, "content-type": "application/json" },
      body: JSON.stringify({ text: MESSAGE }),
    });
    expect(said.status).toBe(202);

    // The pane says one waits; nothing was typed, no Enter for the draft.
    const tag = p.locator(`[data-id="${sid}"] [data-draft-waiting]`);
    // Today's bug, said plainly if it comes back: the draft and the
    // message sent together.
    await tag.waitFor({ timeout: 30_000 }).catch((e: Error) => {
      throw new Error(`${e.message}; typed: ${JSON.stringify(written(from))}`);
    });
    expect(await tag.getAttribute("data-draft-waiting")).toBe("1");
    expect(await tag.textContent()).toBe(
      enCatalog()["ag.draftWaiting.one"].replace("{n}", "1"),
    );
    expect(written(from)).toBe(DRAFT);

    // The person sends their draft: it goes alone, then the message.
    await p.keyboard.press("Enter");
    await eventually(() => written(from) === `${DRAFT}\r`, 10_000);
    pty().emit(box(""));
    await eventually(() => written(from).includes(MESSAGE), 45_000);
    const all = written(from);
    expect(all.startsWith(`${DRAFT}\r`)).toBe(true);
    expect(all.indexOf(MESSAGE)).toBeGreaterThan(all.indexOf("\r"));
    await tag.waitFor({ state: "detached", timeout: 10_000 });
    await p.context().close();
  }, 120_000);
});
