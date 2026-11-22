/**
 * Issue 991: when the gate gives a run a test box (DEN_GATE_BOX), the
 * browser test helper holds every page to the run's base URLs
 * (DEN_GATE_ALLOW): a box's browser reaches this machine's loopback. With
 * `127.0.0.1:*`, only ports this run opened load; another listening port
 * on this machine, and 80 and 443, are refused and reported. With a box
 * but no base URLs, no browser opens at all.
 *
 * The box's browser is stood in for by a local one: the guard is the
 * helper's, the same whichever browser it holds.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as http from "http";
import type { AddressInfo } from "net";
import type { Browser } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { boxGuardBlocks, launchBrowser } from "../helpers/browser.js";

const saved = { ...process.env };
let server: http.Server;
let port = 0;
// Another service on this machine: a port this run didn't open.
let other: ChildProcess;
let otherPort = 0;
let browser: Browser | undefined;

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end("<p>ok</p>"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  other = spawn(process.execPath, [
    "-e",
    'require("http").createServer((q, s) => s.end("other")).listen(0, "127.0.0.1", function () { console.log(this.address().port); });',
  ]);
  otherPort = await new Promise<number>((resolve, reject) => {
    other.once("error", reject);
    other.stdout!.once("data", (b: Buffer) =>
      resolve(Number(String(b).trim())),
    );
  });
});

afterAll(async () => {
  process.env = saved;
  await closeBrowserSuite({
    browsers: [browser],
    servers: [server, () => void other?.kill()],
  });
});

describe("issue 991: a box run's browser is held to its base URLs", () => {
  it("loads the run's own port; refuses :80, :443 and another listening port", async () => {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    process.env = {
      ...saved,
      DEN_GATE_BOX: "b1",
      DEN_GATE_ALLOW: "127.0.0.1:*",
    };
    delete process.env.DEN_PW_WS;
    browser = await launchBrowser("chromium");
    try {
      // Both ways a suite gets a page: its own context, and newPage().
      const page = await (await browser.newContext()).newPage();
      const bare = await browser.newPage();
      let bareFailed = false;
      await bare.goto("http://127.0.0.1:80/").catch(() => (bareFailed = true));
      expect(bareFailed).toBe(true);
      const ok = await page.goto(`http://127.0.0.1:${port}/`);
      expect(ok?.status()).toBe(200);
      for (const url of [
        "http://127.0.0.1:80/",
        "https://127.0.0.1:443/",
        `http://127.0.0.1:${otherPort}/`,
      ]) {
        let failed = false;
        await page.goto(url).catch(() => (failed = true));
        expect([url, failed]).toEqual([url, true]);
      }
      expect(boxGuardBlocks()).toEqual(
        expect.arrayContaining(["http://127.0.0.1/", "https://127.0.0.1/"]),
      );
    } finally {
      await browser?.close();
      browser = undefined;
    }
  }, 60_000);

  it("with a box and no base URLs, opens no browser", async () => {
    process.env = { ...saved, DEN_GATE_BOX: "b1", DEN_GATE_ALLOW: "" };
    delete process.env.DEN_PW_WS;
    await expect(launchBrowser("chromium")).rejects.toThrow(/DEN_GATE_ALLOW/);
  });
});
