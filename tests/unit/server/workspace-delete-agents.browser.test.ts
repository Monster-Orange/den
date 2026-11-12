/**
 * D71 through the real server and page: deleting a workspace with agents.
 *   - GET /api/workspaces/cleanup-preview lists its agents;
 *   - DELETE /api/workspaces with none chosen is refused (409 has_agents);
 *   - the dialog asks: Move them to (another workspace), or Stop them and
 *     remove them; Cancel deletes nothing;
 *   - DELETE with agents: "stop" removes them, then the workspace.
 * Invented names only. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1
 * skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { readRecord } from "../../../src/shared/agents/records.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  s.seed({
    id: "keeper",
    persona: "planner",
    workspace: "south",
    displayName: "Keeper",
    stoppedAt: "2026-11-06T10:00:00.000Z",
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

async function page(): Promise<Page> {
  const ctx = await browser!.newContext({ reducedMotion: "reduce" });
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, "/agents"));
  await p.waitForFunction(() =>
    Boolean((window as never as { denShell?: unknown }).denShell),
  );
  return p;
}

const call = (p: Page, method: string, url: string, body?: unknown) =>
  p.evaluate(
    async ([m, u, b]) => {
      try {
        const out = await (
          window as unknown as {
            denShell: {
              api(m: string, u: string, b?: unknown): Promise<unknown>;
            };
          }
        ).denShell.api(m as string, u as string, b);
        return { status: 200, json: out as Record<string, unknown> };
      } catch (e) {
        const x = e as {
          status?: number;
          data?: Record<string, unknown>;
          message?: string;
        };
        return {
          status: x.status ?? -1,
          json: { ...(x.data ?? {}), error: x.message },
        };
      }
    },
    [method, url, body] as const,
  );

describe("D71: deleting a workspace with agents", () => {
  it("the preview lists them; a delete with no choice is refused, naming them", async () => {
    if (!browser) return;
    const p = await page();
    const preview = (await (
      await fetch(`${s!.base}/api/workspaces/cleanup-preview?name=south`)
    ).json()) as { agents: { id: string; running: boolean }[] };
    expect(preview.agents).toEqual([
      { id: "keeper", name: "Keeper", running: false },
    ]);
    const r = await call(p, "DELETE", "/api/workspaces", { name: "south" });
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toMatch(/has 1 agent \(Keeper\)/);
    expect(readRecord(s!.stateDir, "keeper")?.workspace).toBe("south");
    await p.context().close();
  }, 60_000);

  it("the dialog offers Move (to another workspace) or Stop; Cancel answers null", async () => {
    if (!browser) return;
    const p = await page();
    await p.addScriptTag({ type: "module", url: "/ws-delete-agents.js" });
    await p.waitForFunction(() => "denAskWorkspaceAgents" in window);
    const ask = (choice: "move" | "stop" | "cancel") =>
      p.evaluate(async (c) => {
        const m = window as unknown as {
          denAskWorkspaceAgents(o: unknown): Promise<unknown>;
        };
        const got = m.denAskWorkspaceAgents({
          ws: "south",
          agents: [{ id: "keeper", name: "Keeper", running: true }],
          others: ["north"],
        });
        const d = document.getElementById("wsd-dlg")!;
        if (c === "cancel")
          (d.querySelector('[data-wsd="cancel"]') as HTMLElement).click();
        else {
          (d.querySelector(`input[value="${c}"]`) as HTMLInputElement).click();
          (d.querySelector('[data-wsd="go"]') as HTMLElement).click();
        }
        return got;
      }, choice);
    const text = await p.evaluate(async () => {
      const m = window as unknown as {
        denAskWorkspaceAgents(o: unknown): Promise<unknown>;
      };
      void m.denAskWorkspaceAgents({
        ws: "south",
        agents: [{ id: "keeper", name: "Keeper", running: true }],
        others: ["north"],
      });
      const t = document.getElementById("wsd-dlg")!.textContent;
      (document.getElementById("wsd-dlg") as HTMLDialogElement).close();
      return t;
    });
    expect(text).toContain("“south” has agents (1)");
    expect(text).toContain("Keeper · running");
    expect(text).toContain("A running one moves when its turn ends");
    expect(await ask("move")).toEqual({ agents: "move", agentsTo: "north" });
    expect(await ask("stop")).toEqual({ agents: "stop" });
    expect(await ask("cancel")).toBeNull();
    await p.context().close();
  }, 60_000);

  it("with agents: stop, they're removed and the workspace goes", async () => {
    if (!browser) return;
    const p = await page();
    const r = await call(p, "DELETE", "/api/workspaces", {
      name: "south",
      agents: "stop",
    });
    expect(r.status).toBe(200);
    expect(readRecord(s!.stateDir, "keeper")).toBeNull();
    const ws = (await (await fetch(`${s!.base}/api/workspaces`)).json()) as {
      workspaces: Record<string, unknown>;
    };
    expect(Object.keys(ws.workspaces)).not.toContain("south");
    await p.context().close();
  }, 60_000);
});
