/**
 * ON-3's approval dialog (shell.js, on every page): an agent's held write
 * opens "<agent> wants to … · Review · Deny · Allow" in the person's
 * browser. Its words are Den's (the agent's note only quoted), Review
 * shows what it will do, Allow runs it once, Deny runs nothing. A request
 * with no agent identity says so, and to Deny it if no agent was asked.
 * A browser that isn't signed in can't list what waits: a banner says to
 * sign in, and nothing runs. Looks like the Start dialog (persona-ui.css's
 * frame).
 *
 * Real chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. No code or key is
 * printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import { startDenServer } from "../../child-servers.js";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { denAuth } from "./helpers/den-auth.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
let browser: Browser | null = null;
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS: Den's own Playwright server instead of a local browser.
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-apdlg-")));
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: stateDir,
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 60_000 },
  );
  server = started.server;
  port = started.port;
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [server],
    after: () => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
});

const skip = () => !browser;
/** The dialog is shut (a closed <dialog> is hidden, so wait on `open`). */
const closed = (p: Page) =>
  p.waitForFunction(
    () =>
      !(document.getElementById("den-ap-dlg") as HTMLDialogElement | null)
        ?.open,
    undefined,
    { timeout: 15_000 },
  );
const base = () => `http://localhost:${port}`;

/** The ask's ticket per id: what lets the asker read its own request. */
const tickets = new Map<string, string>();

/** What an MCP tool with no agent token does: ask the server to hold a write. */
async function ask(
  action: string,
  args: unknown,
  note?: string,
): Promise<string> {
  // The CLI's credential, as the MCP server sends it (mcp/api.ts).
  const r = await fetch(`${base()}/api/approvals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...denAuth(stateDir),
    },
    body: JSON.stringify({ action, args, ...(note ? { note } : {}) }),
  });
  expect(r.status).toBe(202);
  const a = (await r.json()) as { id: string; ticket: string };
  tickets.set(a.id, a.ticket);
  return a.id;
}
const stateOf = async (id: string) =>
  (
    (await (
      await fetch(`${base()}/api/approvals/${id}`, {
        headers: { "x-den-approval-ticket": tickets.get(id) ?? "" },
      })
    ).json()) as {
      state: string;
    }
  ).state;
const workspaces = async () =>
  Object.keys(
    (
      (await (await fetch(`${base()}/api/workspaces`)).json()) as {
        workspaces?: Record<string, unknown>;
      }
    ).workspaces ?? {},
  );

async function page(signIn: boolean): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  // A refused poll is a console error; the dialog's polling must make none.
  p.on("console", (m) => {
    if (m.type() !== "error") return;
    // A signed-out page's refused read or write (401) is expected (0.4.71):
    // only that line, and only on the signed-out page.
    if (
      !signIn &&
      m.text() ===
        "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
    )
      return;
    errors.push(`console: ${m.text()}`);
  });
  if (signIn) {
    // Issue 819: first run, then approved by a signed-in browser.
    await signInPage(p, stateDir, base());
    await p.waitForFunction(
      () => localStorage.getItem("den.approveKey")?.length === 43,
    );
  }
  await p.goto(`${base()}/settings`);
  return p;
}

describe("the approval dialog (ON-3)", () => {
  it("opens on any page with Den's words; Review shows what it will do; Allow runs it once", async () => {
    if (skip()) return;
    const p = await page(true);
    const id = await ask(
      "workspace_create",
      { name: "web" },
      "set up EVERYTHING",
    );
    await p.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
    // No agent token: the dialog says so, and what to do if no agent was asked.
    expect(await p.textContent("#den-ap-h")).toBe(
      "Something on this machine (no agent identity) wants to:",
    );
    expect(await p.isVisible("#den-ap-who")).toBe(true);
    expect(await p.textContent("#den-ap-who")).toBe(
      "If you didn't ask an agent to do this, Deny.",
    );
    expect(await p.textContent("#den-ap-what")).toBe(
      'Create the project "web"',
    );
    expect(await p.textContent("#den-ap-note")).toContain(
      "“set up EVERYTHING”",
    );
    expect(await p.isVisible("#den-ap-det")).toBe(false);
    await p.click("#den-ap-review");
    expect(await p.textContent("#den-ap-det")).toContain(
      'A new, empty project named "web", made active so its services can start.',
    );
    // The Start dialog's frame and footer.
    const box = await p.$eval("#den-ap-dlg", (d) => {
      const r = d.getBoundingClientRect();
      return { w: Math.round(r.width), cls: d.className };
    });
    expect(box.cls).toContain("pe-dlg");
    expect(box.w).toBe(638);
    await p.click("#den-ap-allow");
    await closed(p);
    expect(await stateOf(id)).toBe("done");
    expect(await workspaces()).toContain("web");
    await p.context().close();
  }, 90_000);

  it("Deny runs nothing", async () => {
    if (skip()) return;
    const p = await page(true);
    const id = await ask("workspace_create", { name: "nope" });
    await p.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
    await p.click("#den-ap-deny");
    await closed(p);
    expect(await stateOf(id)).toBe("denied");
    expect(await workspaces()).not.toContain("nope");
    await p.context().close();
  }, 90_000);

  it("a browser that isn't signed in sees no request, only a banner to sign in; nothing runs", async () => {
    if (skip()) return;
    const p = await page(false);
    const id = await ask("workspace_create", { name: "anon" });
    await p.waitForSelector('[data-banner="approvals"]', { timeout: 15_000 });
    expect(await p.textContent('[data-banner="approvals"]')).toMatch(
      /waiting for your approval.*sign in/i,
    );
    expect(await p.$("#den-ap-dlg[open]")).toBeNull();
    // Signed out on this machine too: the page says so in one line.
    await p.waitForSelector('[data-banner="signin"]', { timeout: 15_000 });
    expect(await p.textContent('[data-banner="signin"]')).toContain(
      "Sign in to make changes here.",
    );
    expect(await p.content()).not.toContain("anon&quot;");
    expect(await stateOf(id)).toBe("pending");
    expect(await workspaces()).not.toContain("anon");
    await p.context().close();
  }, 90_000);

  it("SRV-1a: Allow on a restart: the dialog says why; then Den's in-place restart wait, not a toast", async () => {
    if (skip()) return;
    const p = await page(true);
    const id = await ask("den_restart", { reason: "pick up the new pin" });
    const want = "Restart Den (pick up the new pin)";
    // An earlier test's request may still wait: Deny it, until this one shows.
    for (let i = 0; i < 5; i++) {
      await p.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
      if ((await p.textContent("#den-ap-what")) === want) break;
      await p.click("#den-ap-deny");
      await closed(p);
    }
    expect(await p.textContent("#den-ap-what")).toBe(want);
    await p.click("#den-ap-review");
    expect(await p.textContent("#den-ap-det")).toContain(
      "Agents and terminals carry on where they were",
    );
    // The page's part only: the decide answers as a restart's run does,
    // and this server stays up for the other tests (a real restart is
    // srv1a-restart.integration's).
    await p.route(`**/api/approvals/${id}/decide`, (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          id,
          action: "den_restart",
          state: "done",
          result: { ok: true, restarting: true, pid: 1 },
        }),
      }),
    );
    await p.click("#den-ap-allow");
    await closed(p);
    // The restart is under way: the page waits for the new server in place
    // (UK-2: the kit's working pop-up, reconnect mode).
    await p.waitForSelector('dialog.bz-dlg[open][data-state="working"]', {
      timeout: 15_000,
    });
    await p.context().close();
  }, 90_000);

  it("issue 199: a project's mode names the agents with their own; Allow keeps theirs unless the person makes them follow", async () => {
    if (skip()) return;
    // Project web (the first test made it): pinned has its own mode, scout follows.
    const rec = (id: string, own: boolean) =>
      writeRecord(stateDir, {
        id,
        persona: "builder",
        runtime: "den-claude",
        workspace: "web",
        session: { backend: "den-pty", id: `gone-${id}` },
        sessionName: `acme-web:${id}`,
        startedAt: "2026-11-01T09:59:00.000Z",
        permission: "auto",
        ...(own ? { overrides: ["permission" as const] } : {}),
      });
    rec("pinned", true);
    rec("scout", false);
    const own = () =>
      (
        JSON.parse(
          fs.readFileSync(
            path.join(stateDir, "agents", "pinned.json"),
            "utf-8",
          ),
        ) as { overrides?: string[] }
      ).overrides ?? [];
    const p = await page(true);
    const show = async (want: RegExp) => {
      for (let i = 0; i < 5; i++) {
        await p.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
        if (want.test((await p.textContent("#den-ap-what")) ?? "")) return;
        await p.click("#den-ap-deny");
        await closed(p);
      }
    };
    const first = await ask("project_mode", { project: "web", mode: "all" });
    await show(/web's mode: .* → all/);
    expect(await p.isVisible("#den-ap-own")).toBe(true);
    expect(await p.textContent("#den-ap-own-h")).toBe(
      "These agents keep their own mode and won't follow the project:",
    );
    expect(await p.textContent("#den-ap-own-list")).toBe(
      "pinned (own mode: auto)",
    );
    expect(await p.textContent("#den-ap-follow-row")).toContain(
      "Also make these follow the project",
    );
    expect(await p.isChecked("#den-ap-follow")).toBe(false);
    await p.click("#den-ap-allow");
    await closed(p);
    expect(await stateOf(first)).toBe("done");
    expect(await p.textContent(".den-toast")).toContain(
      "Keep their own mode: pinned (own mode: auto).",
    );
    expect(own()).toContain("permission");
    // Again, with the choice: pinned follows.
    const second = await ask("project_mode", { project: "web", mode: "edits" });
    await show(/web's mode: all → edits/);
    await p.check("#den-ap-follow");
    await p.click("#den-ap-allow");
    await closed(p);
    expect(await stateOf(second)).toBe("done");
    expect(await p.textContent(".den-toast")).toContain(
      "Follow the project now: pinned, scout.",
    );
    expect(own()).not.toContain("permission");
    await p.context().close();
  }, 90_000);

  it("project_mode's Review lines in the person's language (es)", async () => {
    if (skip()) return;
    const userYml = path.join(tmp, "dist", "config", "local", "user.yml");
    fs.mkdirSync(path.dirname(userYml), { recursive: true });
    const before = fs.existsSync(userYml)
      ? fs.readFileSync(userYml, "utf-8")
      : null;
    fs.writeFileSync(userYml, `${before ?? ""}\nlanguage: es\n`);
    try {
      const p = await page(true);
      const id = await ask("project_mode", { project: "web", mode: "auto" });
      await p.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
      const det = (await p.textContent("#den-ap-det")) ?? "";
      expect(det).toContain("Proyecto: web");
      expect(det).toContain(
        "Los agentes nuevos empiezan en él; los que están en marcha cambian tras su turno actual, en la misma conversación.",
      );
      expect(det).not.toContain("running agents");
      await p.click("#den-ap-deny");
      await closed(p);
      expect(await stateOf(id)).toBe("denied");
      await p.context().close();
    } finally {
      fs.writeFileSync(userYml, before ?? "");
    }
  }, 90_000);

  it("issue 592: keep_running's Allow asks this browser for the admin password, then runs", async () => {
    if (skip()) return;
    const p = await page(true);
    // keep_running is macOS's (launchd): the page's part only. What waits,
    // the decide and the password are the server's answers, faked here.
    const id = "KeepRunningAsk01";
    const item = {
      id,
      action: "keep_running",
      agent: "server",
      summary: "keep agents running after logout",
      params: { from: "login", to: "always" },
      details: [
        "How Den runs: login → always.",
        "Den restarts; running agents come back where they were.",
        "The admin password is asked once, in this browser, when you Allow. The agent never sees it.",
        "No sign-in token is set: agents won't be able to sign in after you log out. Set one in Settings › Agents › Sign-in token.",
      ],
      detailKeys: [
        {
          key: "ap.det.keep_running.mode",
          vars: { from: "login", to: "always" },
        },
        { key: "ap.det.keep_running.restart" },
        { key: "ap.det.keep_running.sudo" },
        { key: "ap.det.keep_running.noToken" },
      ],
      link: {
        href: "/settings#agents.keep_running",
        key: "ap.link.signinToken",
      },
      state: "pending",
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    let done = false;
    await p.route("**/api/approvals", (r) =>
      r.request().method() === "GET"
        ? r.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, pending: done ? [] : [item] }),
          })
        : r.fallback(),
    );
    const decides: string[] = [];
    let passwordSet = false;
    await p.route(`**/api/approvals/${id}/decide`, (r) => {
      decides.push(r.request().postData() ?? "");
      if (!passwordSet)
        return r.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            code: "needs_sudo",
            error: "needs the admin password",
            needsSudo: { command: "den service install --mode always" },
          }),
        });
      done = true;
      return r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          ...item,
          state: "done",
          result: { ok: true, applied: true, mode: "always" },
        }),
      });
    });
    await p.route("**/api/sudo-password/status", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ set: passwordSet }),
      }),
    );
    const typed: string[] = [];
    await p.route("**/api/sudo-password", (r) => {
      if (r.request().method() !== "POST") return r.fallback();
      typed.push(
        String(
          (JSON.parse(r.request().postData() ?? "{}") as { password?: string })
            .password,
        ),
      );
      passwordSet = true;
      return r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
    await p.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
    // Den's words from the keys: the dialog shows the switch and each
    // Review line the server sent (en here, so as sent).
    expect(await p.textContent("#den-ap-what")).toContain(
      `${item.params.from} → ${item.params.to}`,
    );
    await p.click("#den-ap-review");
    const det = (await p.textContent("#den-ap-det")) ?? "";
    for (const line of item.details) expect(det).toContain(line);
    expect(await p.isVisible("#den-ap-link")).toBe(true);
    expect(await p.getAttribute("#den-ap-link", "href")).toBe(item.link.href);
    const linkText = (await p.textContent("#den-ap-link")) ?? "";
    expect(linkText.length).toBeGreaterThan(0);
    expect(linkText).not.toBe(item.link.key);
    await p.click("#den-ap-allow");
    // The existing password dialog, in this browser.
    await p.waitForSelector("#den-lock-pw", { timeout: 15_000 });
    expect(decides).toHaveLength(1);
    await p.fill("#den-lock-pw", "pw-for-test");
    await p.click("#den-lock-go");
    await closed(p);
    expect(typed).toEqual(["pw-for-test"]);
    // Allowed again once the password was set; the decide never carries it.
    expect(decides).toHaveLength(2);
    for (const d of decides) expect(d).not.toContain("pw-for-test");
    await p.context().close();
  }, 90_000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});
