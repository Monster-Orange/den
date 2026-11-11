/**
 * A fresh `den create` distribution in the browser (a consumer's dev.24
 * run): loading its pages runs no gh (the scaffold sets no github_org, so
 * GitHub is not configured), and the lock popover's not-configured note
 * names the distribution's real config file (config/acme.yml), never a
 * placeholder like config/<cli>.yml.
 *
 * The real web server in a throwaway distribution, with recording fakes
 * for gh, op, doppler and mkcert first on PATH, driven by Playwright's
 * headless Chromium. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1
 * skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { Browser } from "playwright";
import {
  runningDenVersion,
  writeDistribution,
} from "../../../src/ui/cli/create.js";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const FAKES = ["gh", "op", "doppler", "mkcert"];
let tmp = "";
let calls = "";
let port = 0;
let server: ChildProcess;
let browser: Browser | null = null;

function getBody(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "localhost", port, path: p, timeout: 5_000, agent: false },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-fresh-")));
  const dist = path.join(tmp, "acme");
  writeDistribution(dist, {
    name: "acme",
    denVersion: runningDenVersion(ENGINE),
  });
  const fakeBin = path.join(tmp, "fake-bin");
  calls = path.join(tmp, "cli-calls");
  fs.mkdirSync(fakeBin);
  for (const bin of FAKES)
    fs.writeFileSync(
      path.join(fakeBin, bin),
      `#!/bin/sh\necho "${bin} $*" >> ${calls}\nexit 1\n`,
      { mode: 0o755 },
    );

  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!/^(DEN_|ACME_|OP_|DOPPLER_|GH_|GITHUB_)/.test(k)) env[k] = v;
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: dist,
      env: {
        ...env,
        PATH: [fakeBin, process.env.PATH].join(path.delimiter),
        DEN_ROOT: dist,
        DEN_ENGINE_ROOT: ENGINE,
        HOME: path.join(tmp, "home"),
        ACME_HOME: path.join(tmp, "acme-home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 30_000 },
  );
  server = started.server;
  port = started.port;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function page() {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const latest = (
    JSON.parse((await getBody("/api/changelog")).body) as {
      version: string;
    }[]
  )[0]?.version;
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("acme-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest ?? "");
  const p = await ctx.newPage();
  // Locked, whatever this machine's sudo is: the popover shows its form.
  await p.route("**/api/sudo-password/status", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ set: false, passwordless: false }),
    }),
  );
  return { ctx, p };
}

describe("a fresh den create distribution in the browser", () => {
  it("loading every page runs no gh (github_org is not set)", async () => {
    if (!browser) return;
    const { ctx, p } = await page();
    const asked: string[] = [];
    p.on("request", (r) => asked.push(new URL(r.url()).pathname));
    for (const route of [
      "/",
      "/services",
      "/local-dev",
      "/environments",
      "/logs",
      "/release",
      "/settings",
    ]) {
      const res = await p.goto(`http://localhost:${port}${route}`);
      expect([route, res?.status()]).toEqual([route, 200]);
      await p.waitForLoadState("networkidle");
    }
    // Local Dev asked for the GitHub repos, and got none without gh.
    expect(asked).toContain("/api/github/repos");
    await ctx.close();
    const ran = fs.existsSync(calls) ? fs.readFileSync(calls, "utf-8") : "";
    expect(ran.split("\n").filter((l) => l.startsWith("gh "))).toEqual([]);
  }, 120_000);

  it("the admin-password prompt's not-configured note names config/acme.yml", async () => {
    if (!browser) return;
    const { ctx, p } = await page();
    await p.goto(`http://localhost:${port}/services`);
    await p.waitForSelector("#den-lock", { state: "attached" });
    await p.evaluate(() =>
      (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
    );
    // LK-0: the prompt opens only when sudo needs the password; ask it
    // as a run's needs-sudo would.
    // A string, so the browser does the import (not the test's compiler).
    await p.evaluate(
      "import('/topbar.js').then((m) => void m.askSudo({ command: 'sudo true' }))",
    );
    await p.waitForSelector("#den-lock-pop .den-lock-cfg:not([hidden])");
    const note = await p.$eval(
      "#den-lock-pop .den-lock-cfg",
      (el) => (el as HTMLElement).innerText,
    );
    expect(note).toBe(
      "Saving the password is off: set secrets.provider and secrets.refs.sudo in config/acme.yml.",
    );
    expect(await p.$eval("#den-lock-pop", (el) => el.textContent)).not.toMatch(
      /<cli>|&lt;cli/,
    );
    // No save option: nothing to save to.
    expect(
      await p.$eval("#den-lock-pop .den-lock-save", (el) =>
        el.hasAttribute("hidden"),
      ),
    ).toBe(true);
    await ctx.close();
  }, 60_000);
});
