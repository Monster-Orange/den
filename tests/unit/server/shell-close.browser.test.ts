/**
 * A shell's pane has Close shell (the 0.4.39 gate's note: only `exit`
 * ended one, and closed tabs kept counting toward sessions.max_concurrent).
 * It ends the shell as closing a terminal does and its pane goes; an
 * agent's pane has no such button. Translated. The demo distribution, the
 * scripted PTY. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { denAuth, signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
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
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function post(p: string, body: unknown = {}) {
  const r = await fetch(`${s!.base}${p}`, {
    method: "POST",
    headers: { ...denAuth(s!.stateDir), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as Record<string, unknown>;
}

async function open(path: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 860 },
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
  await p.goto(signInUrl(s!.stateDir, s!.base, path));
  return p;
}

describe("Close shell", () => {
  it("a shell's pane: Close shell ends it and the pane goes; an agent's pane has none", async () => {
    if (skip()) return;
    const shell = (await post("/api/workspaces/north/sessions")).session as {
      id: string;
    };
    const pty = s!.made.at(-1)!;
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      if (sig === "SIGHUP") setTimeout(() => pty.exit(129), 10);
    };
    await post("/api/workspaces/north/agents", { persona: "planner" });
    s!.made.at(-1)!.emit("> ");
    const rows = (
      (await (
        await fetch(`${s!.base}/api/sessions?ws=north`, {
          headers: denAuth(s!.stateDir),
        })
      ).json()) as { sessions: { id: string; agent?: string }[] }
    ).sessions;
    const agentId = rows.find((r) => r.agent === "planner")!.id;
    // The agent's pane: no Close shell (Stop is its way).
    const a = await open(
      `/agents?ws=north&open=${encodeURIComponent(agentId)}`,
    );
    await a
      .locator(`.pane[data-id="${agentId}"] [data-act="stop"]`)
      .waitFor({ timeout: 15_000 });
    expect(
      await a
        .locator(`.pane[data-id="${agentId}"] [data-act="close-shell"]`)
        .count(),
    ).toBe(0);
    await a.context().close();
    const p = await open(
      `/agents?ws=north&open=${encodeURIComponent(shell.id)}`,
    );
    const pane = p.locator(`.pane[data-id="${shell.id}"]`);
    const btn = pane.locator('[data-act="close-shell"]');
    await btn.waitFor({ timeout: 15_000 });
    expect(await btn.textContent()).toBe("Close shell");
    await btn.click();
    await pane.waitFor({ state: "detached", timeout: 15_000 });
    expect(pty.signals).toEqual(["SIGHUP"]);
    const after = (
      (await (
        await fetch(`${s!.base}/api/sessions?ws=north`, {
          headers: denAuth(s!.stateDir),
        })
      ).json()) as { sessions: { id: string }[] }
    ).sessions.map((r) => r.id);
    expect(after).not.toContain(shell.id);
    await p.context().close();
  }, 90_000);

  it("in Japanese", async () => {
    if (skip()) return;
    const shell = (await post("/api/workspaces/north/sessions")).session as {
      id: string;
    };
    expect(await s!.settings({ language: "ja" })).toBe(200);
    try {
      const p = await open(
        `/agents?ws=north&open=${encodeURIComponent(shell.id)}`,
      );
      const btn = p.locator(
        `.pane[data-id="${shell.id}"] [data-act="close-shell"]`,
      );
      await btn.waitFor({ timeout: 15_000 });
      expect(await btn.textContent()).toBe("シェルを閉じる");
      await p.context().close();
    } finally {
      await s!.settings({ language: null });
    }
  }, 60_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
