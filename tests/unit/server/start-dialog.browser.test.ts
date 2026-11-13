/**
 * The Start agent dialog (AG-10.1 to 10.9, AG-12, AG-13) in a real
 * browser, on the real server and the demo distribution (acme; north,
 * south) with a session host in this process and a scripted PTY
 * (helpers/agents-page-server.ts): nothing really runs, `claude` is a shim
 * that only answers --version.
 *
 *   - the gate: from the dialog alone, start a named persona with a first
 *     instruction and a model that isn't its default; its pane opens, the
 *     instruction is typed into its session once it is ready (bracketed
 *     paste, then Enter), never an argument, and its row says "model: …";
 *   - finding a persona: search and the category and source chips;
 *     Plain shell pinned last; Details; What's a persona?;
 *   - Advanced: the permission preview follows the mode and the extra
 *     commands, and a pattern says "use a plain prefix";
 *   - + New persona writes a persona of your own, and the dialog picks it;
 *   - Settings › Personas lists them, with Edit for your own only;
 *   - sizes: the Den Shell prototype's (den-shell.html startAgent() at
 *     1440x900, measured with getBoundingClientRect: MOCK below), and at
 *     390 nothing is wider than the window.
 *
 * DEN_START_SHOTS=<dir> writes screenshots. On localhost nothing asks to
 * sign in; no token or cookie is printed. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
const SHOTS = process.env.DEN_START_SHOTS;
const PTY = loadPty().available;
const errors: string[] = [];
let latest = "";

/**
 * The prototype's sizes at 1440x900 (den-shell.html, startAgent() and
 * editPersona(), getBoundingClientRect): width and height in px.
 */
const MOCK = {
  dialogW: 638,
  plistW: 600,
  prH: 51,
  searchH: 29,
  chipH: 22.1,
  pghH: 26,
  taskH: 96,
  selectH: 31,
  h2H: 20,
  labelH: 16,
  advClosedH: 36.8,
  pmW: 192,
  editorW: 638,
  editorNameW: 295,
  editorNameH: 30,
  editorInstrW: 600,
};

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
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function page(url: string, width = 1440, height = 900): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      // No What's new on top of the dialog.
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|400)/.test(m.text()))
      errors.push(`${url}: console: ${m.text()}`);
  });
  await p.goto(`${s!.base}${url}`);
  return p;
}

async function openDialog(p: Page): Promise<void> {
  await p.waitForSelector("#ag-dlg[open]", { timeout: 20_000 });
  await p.waitForSelector('#ag-persona [data-pid="planner"]');
}

const shot = async (p: Page, name: string) => {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const size = (p: Page, sel: string) =>
  p.$eval(sel, (e) => {
    const b = e.getBoundingClientRect();
    return {
      w: Math.round(b.width * 10) / 10,
      h: Math.round(b.height * 10) / 10,
    };
  });
const pids = (p: Page) =>
  p.$$eval("#ag-persona [data-pid]", (bs) =>
    bs.map((b) => (b as HTMLElement).dataset.pid),
  );
const near = (a: number, b: number, tol = 1.5) =>
  expect([a, Math.abs(a - b) <= tol]).toEqual([a, true]);

describe("the Start dialog (AG-10.1)", () => {
  it("the gate: a named persona, a first instruction and a model that isn't its default, from the dialog alone", async () => {
    if (skip() || !PTY) return;
    const p = await page("/agents?ws=north&start=1");
    await openDialog(p);
    await shot(p, "start-default-1440");
    await p.click('#ag-persona [data-pid="planner"]');
    expect(
      await p.getAttribute('#ag-persona [data-pid="planner"]', "aria-checked"),
    ).toBe("true");
    await p.fill("#ag-task", "Plan the login story.\nKeep it small.");
    await p.click("#ag-adv summary");
    await p.selectOption("#ag-model", "haiku");
    await p.locator("#ag-pv").scrollIntoViewIfNeeded();
    await shot(p, "start-advanced-1440");
    const made = s!.made.length;
    const [res] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/workspaces/north/agents",
        { timeout: 20_000 },
      ),
      p.click("#ag-go"),
    ]);
    expect(res.status()).toBe(200);
    const sent = JSON.parse(res.request().postData() ?? "{}") as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({
      persona: "planner",
      model: "haiku",
      instruction: "Plan the login story.\nKeep it small.",
    });
    const agent = (
      (await res.json()) as { agent: { id: string; sessionId: string } }
    ).agent;
    // Its pane opens.
    await p.waitForSelector(`.pane[data-id="${agent.sessionId}"] .xterm-rows`);
    expect(s!.made.length).toBe(made + 1);
    const pty = s!.made[s!.made.length - 1];
    expect(pty.args).toEqual(expect.arrayContaining(["--model", "haiku"]));
    expect(pty.args.join(" ")).not.toContain("Plan the login");
    // The runtime asks for bracketed paste and goes quiet: ready.
    pty.emit("\x1b[?2004h> ");
    const typed = () => Buffer.concat(pty.writes).toString("utf-8");
    const end = Date.now() + 15_000;
    while (!typed().includes("Keep it small.\x1b[201~\r") && Date.now() < end)
      await new Promise((r) => setTimeout(r, 100));
    expect(typed()).toContain(
      "\x1b[200~Plan the login story.\nKeep it small.\x1b[201~\r",
    );
    // Its row says what it overrides.
    await p.waitForSelector(
      `.agr[data-id="${agent.sessionId}"] [data-ov="model"]`,
      { timeout: 10_000 },
    );
    expect(
      await p.textContent(
        `.agr[data-id="${agent.sessionId}"] [data-ov="model"]`,
      ),
    ).toBe("model: haiku");
    expect(readRecord(s!.stateDir, agent.id)).toMatchObject({
      model: "haiku",
      overrides: expect.arrayContaining(["model"]),
    });
    expect(fs.existsSync(s!.ran)).toBe(false);
    await shot(p, "session-tags-1440");
    await p.setViewportSize({ width: 390, height: 844 });
    await shot(p, "session-tags-390");
    await p.context().close();
  }, 90_000);

  it("AG-10.10: one persona twice: the dialog says the id each start takes, and a name tells them apart", async () => {
    if (skip() || !PTY) return;
    const startOnce = async (name: string) => {
      const p = await page("/agents?ws=north&start=1");
      await openDialog(p);
      await p.click('#ag-persona [data-pid="reviewer"]');
      const as = (await p.textContent("#ag-as")) ?? "";
      await p.fill("#ag-name", name);
      const [res] = await Promise.all([
        p.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname === "/api/workspaces/north/agents",
          { timeout: 20_000 },
        ),
        p.click("#ag-go"),
      ]);
      expect(res.status()).toBe(200);
      const sent = JSON.parse(res.request().postData() ?? "{}");
      expect(sent).toMatchObject({
        persona: "reviewer",
        ...(name ? { name } : {}),
      });
      const id = ((await res.json()) as { agent: { id: string } }).agent.id;
      await p.context().close();
      return { as, id };
    };
    // No Name: the persona's id, then the next suffix.
    const one = await startOnce("");
    expect(one).toEqual({ as: "Starts as reviewer", id: "reviewer" });
    const two = await startOnce("");
    expect(two).toEqual({ as: "Starts as reviewer-2", id: "reviewer-2" });
    // A Name: its slug is the id (AG-10.10b), the title as typed.
    const three = await startOnce("Second");
    expect(three.id).toBe("second");
  }, 90_000);

  it("AG-10.10b: the Name is the id; a running match says Open it and Start is off", async () => {
    if (skip() || !PTY) return;
    const p = await page("/agents?ws=north&start=1");
    await openDialog(p);
    await p.click('#ag-persona [data-pid="reviewer"]');
    // "reviewer" runs (the test before), and "second", titled "Second":
    // by id, and by a title typed another way.
    for (const typed of ["reviewer", "SECOND"]) {
      await p.fill("#ag-name", typed);
      await p
        .waitForFunction(
          () =>
            /already running/.test(
              document.querySelector("#ag-as")?.textContent ?? "",
            ),
          undefined,
          { timeout: 8_000 },
        )
        .catch(async () => {
          throw new Error(`#ag-as said: ${await p.textContent("#ag-as")}`);
        });
      expect(await p.isDisabled("#ag-go")).toBe(true);
    }
    await p.fill("#ag-name", "API spike");
    expect(await p.textContent("#ag-as")).toBe("Starts as api-spike");
    expect(await p.isDisabled("#ag-go")).toBe(false);
    // Open it opens the running one's pane.
    await p.fill("#ag-name", "reviewer");
    await p.click("#ag-as button");
    await p.waitForSelector("#ag-dlg:not([open])", { state: "hidden" });
    await p.waitForSelector(".pane .xterm-rows");
    await p.context().close();
  }, 60_000);

  it("finds a persona: search, the category and source chips, Plain shell pinned last, Details and What's a persona?", async () => {
    if (skip()) return;
    const p = await page("/agents?ws=north&start=1");
    await openDialog(p);
    // Grouped by category with no filter; Plain shell last.
    const heads = await p.$$eval("#ag-persona .pgh span:first-child", (xs) =>
      xs.map((x) => (x.textContent ?? "").toLowerCase()),
    );
    expect(heads).toEqual(["engineering", "design", "shell"]);
    expect((await pids(p)).at(-1)).toBe(":plain");
    // Every option has its one-line description.
    for (const d of await p.$$eval("#ag-persona .pr .pd", (xs) =>
      xs.map((x) => x.textContent ?? ""),
    ))
      expect(d.length).toBeGreaterThan(5);
    await p.fill("#ag-q", "review");
    expect(await pids(p)).toEqual(["reviewer", ":plain"]);
    await p.fill("#ag-q", "");
    await p.click('[data-pf="cat"][data-v="design"]');
    expect(await pids(p)).toEqual(["ux-designer", ":plain"]);
    await shot(p, "start-filtered-1440");
    await p.click('[data-pf="src"][data-v="local"]');
    expect(await p.textContent("#ag-persona .pempty")).toMatch(
      /No persona matches/,
    );
    await p.click('#ag-persona [data-x="clear"]');
    expect((await pids(p)).length).toBeGreaterThan(5);
    // What's a persona? and Details.
    await p.click('[data-x="what"]');
    expect(await p.isVisible("#ag-what")).toBe(true);
    await p.click('#ag-persona [data-pid="reviewer"]');
    await p.click('[data-x="det"]');
    await p.waitForSelector("#ag-det pre");
    await p.waitForFunction(
      () =>
        !/Loading/.test(
          document.querySelector("#ag-det pre")?.textContent ?? "",
        ),
    );
    expect(await p.textContent("#ag-det")).toMatch(/Ask for everything/);
    expect(await p.textContent("#ag-det")).toMatch(/gh pr diff/);
    // Plain shell hides the agent's fields.
    await p.click('#ag-persona [data-pid=":plain"]');
    expect(await p.isHidden("#ag-adv")).toBe(true);
    expect(await p.isHidden("#ag-task-l")).toBe(true);
    expect(await p.isDisabled("#ag-go")).toBe(false);
    await p.context().close();
  }, 60_000);

  it("Advanced: the preview follows the mode and the extra commands; a pattern says to use a plain prefix", async () => {
    if (skip()) return;
    const p = await page("/agents?ws=north&start=1");
    await openDialog(p);
    await p.click('#ag-persona [data-pid="reviewer"]');
    await p.click("#ag-adv summary");
    // A persona with no model of its own: the short label, which fits the
    // select at 638px (the long "the runtime's default · latest" was cut).
    expect(
      await p.$eval(
        "#ag-model option:first-child",
        (o) => (o as HTMLOptionElement).textContent,
      ),
    ).toBe("Persona default (latest)");
    const pv = () => p.textContent("#ag-pv");
    expect(await pv()).toMatch(/--permission-mode default/);
    expect(await pv()).toMatch(/Bash\(gh pr diff\)/);
    await p.click('[data-pm="edits"]');
    expect(await pv()).toMatch(/--permission-mode acceptEdits/);
    await p.click("#ag-xtra summary");
    await p.fill("#ag-tools", "npm test\nnpm *");
    expect(await pv()).toMatch(/Bash\(npm test \*\)/);
    expect(await p.textContent('#ag-pv [data-cmd="npm *"]')).toMatch(
      /use a plain prefix/,
    );
    expect(await p.textContent("#ag-xn")).toBe("2");
    // The version follows the model.
    await p.selectOption("#ag-model", "opus");
    const vers = await p.$$eval("#ag-ver option", (os) =>
      os.map((o) => (o as HTMLOptionElement).value),
    );
    expect(vers).toEqual(
      expect.arrayContaining(["", "latest", "claude-opus-4-8"]),
    );
    // Start is refused in the dialog while a command is a pattern.
    await p.click("#ag-go");
    await p.waitForSelector("#ag-err:not([hidden])");
    expect(await p.textContent("#ag-err")).toMatch(
      /isn't a plain command prefix/,
    );
    expect(await p.isVisible("#ag-dlg")).toBe(true);
    await p.context().close();
  }, 60_000);

  it("+ New persona writes one of your own; the dialog picks it; Settings › Personas lists it with Edit", async () => {
    if (skip()) return;
    const p = await page("/agents?ws=north&start=1");
    await openDialog(p);
    await p.click('[data-x="newp"]');
    await p.waitForSelector("#pe-dlg[open]");
    // A role fills the form in (AG-11.2).
    expect(await p.inputValue("#pe-instr")).toMatch(/failing test/);
    await p.fill("#pe-name", "Rita");
    await p.selectOption("#pe-role", "reviewer");
    expect(await p.inputValue("#pe-instr")).toMatch(/acceptance criteria/);
    await p.fill("#pe-desc", "Reviews <b>copy</b> & tone.");
    await p.selectOption("#pe-model", "sonnet");
    await shot(p, "editpersona-1440");
    const ed = await size(p, "#pe-dlg");
    const nm = await size(p, "#pe-name");
    const ins = await size(p, "#pe-instr");
    near(ed.w, MOCK.editorW);
    near(nm.w, MOCK.editorNameW);
    near(nm.h, MOCK.editorNameH);
    near(ins.w, MOCK.editorInstrW);
    if (SHOTS)
      fs.writeFileSync(
        path.join(SHOTS, "measured-editor.json"),
        JSON.stringify({ ed, nm, ins }),
      );
    await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/personas",
      ),
      p.click("#pe-go"),
    ]);
    await p.waitForSelector(
      '#ag-persona [data-pid="rita"][aria-checked="true"]',
    );
    // Its description is text, never markup.
    expect(await p.textContent('#ag-persona [data-pid="rita"] .pd')).toBe(
      "Reviews <b>copy</b> & tone.",
    );
    expect(await p.$('#ag-persona [data-pid="rita"] .pd b')).toBeNull();
    expect(fs.existsSync(path.join(s!.stateDir, "personas", "rita.md"))).toBe(
      true,
    );
    await p.context().close();

    const st = await page("/settings#agents");
    await st.waitForSelector('.prow[data-pid="rita"]', { timeout: 20_000 });
    expect(await st.textContent('.prow[data-pid="rita"] [data-x="edit"]')).toBe(
      "Edit",
    );
    expect(await st.$('.prow[data-pid="planner"] [data-x="edit"]')).toBeNull();
    expect(
      await st.textContent('.prow[data-pid="planner"] [data-x="view"]'),
    ).toBe("View");
    await st.locator('.prow[data-pid="rita"]').scrollIntoViewIfNeeded();
    await shot(st, "settings-personas-1440");
    await st.setViewportSize({ width: 390, height: 844 });
    await shot(st, "settings-personas-390");
    expect(
      await st.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await st.context().close();
  }, 90_000);

  it("its sizes are the prototype's at 1440; at 390 it fits the window", async () => {
    if (skip()) return;
    const p = await page("/agents?ws=north&start=1");
    await openDialog(p);
    const m = {
      dialogW: (await size(p, "#ag-dlg")).w,
      plistW: (await size(p, "#ag-persona")).w,
      prH: (await size(p, "#ag-persona .pr")).h,
      searchH: (await size(p, "#ag-q")).h,
      chipH: (await size(p, ".pfc")).h,
      pghH: (await size(p, "#ag-persona .pgh")).h,
      taskH: (await size(p, "#ag-task")).h,
      selectH: (await size(p, "#ag-runtime")).h,
      h2H: (await size(p, "#ag-dlg-h")).h,
      labelH: (await size(p, "#ag-r-t")).h,
      advClosedH: (await size(p, "#ag-adv")).h,
    };
    await p.click("#ag-adv summary");
    const pmW = (await size(p, '[data-pm="ask"]')).w;
    if (SHOTS)
      fs.writeFileSync(
        path.join(SHOTS, "measured-start.json"),
        JSON.stringify({ ...m, pmW }),
      );
    for (const [k, v] of Object.entries(m))
      near(v, MOCK[k as keyof typeof MOCK]);
    near(pmW, MOCK.pmW, 2.5);
    await p.setViewportSize({ width: 390, height: 844 });
    await p.click("#ag-adv summary");
    await shot(p, "start-default-390");
    const d = await size(p, "#ag-dlg");
    expect(d.w).toBe(358);
    for (const sel of ["#ag-go", "#ag-cancel", "#ag-persona", "#ag-q"]) {
      const b = (await p.locator(sel).boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(390 - 16 + 0.5);
    }
    await p.click("#ag-adv summary");
    await p.locator("#ag-pv").scrollIntoViewIfNeeded();
    await shot(p, "start-advanced-390");
    await p.fill("#ag-q", "review");
    await shot(p, "start-filtered-390");
    await p.click('[data-x="newp"]');
    await p.waitForSelector("#pe-dlg[open]");
    expect((await size(p, "#pe-dlg")).w).toBe(358);
    await shot(p, "editpersona-390");
    await p.context().close();
  }, 60_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
