/**
 * Issue 233: browser suites tear down through one helper
 * (tests/browser-teardown.ts), and a check finds any that does not.
 *
 * - The check: every *.browser.test.ts under tests/ closes through
 *   closeBrowserSuite; a suite with a bare afterAll fails it.
 * - The order: contexts (routes dropped, ignoring errors, then closed),
 *   then browsers, then servers in the order given, then `after`; a failing
 *   step does not skip the later ones.
 * - The time limit: a browser suite whose teardown takes past Jest's
 *   default 10 s still passes (the browser suites' setting, tests/setup.ts).
 * - Why a stop took seconds: an in-process server's bare close() waits for
 *   every open connection, and an event stream never ends by itself. The
 *   helper closes the connections first. A test's Den server (a child
 *   process) stops at once with an event stream open too.
 */
import { describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { bareTeardowns, closeBrowserSuite } from "../browser-teardown.js";
import { startAgentsPageServer } from "./server/helpers/agents-page-server.js";
import { denAuth } from "./server/helpers/den-auth.js";

const TESTS = path.resolve(__dirname, "..");

function browserSuites(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...browserSuites(p));
    else if (e.name.endsWith(".browser.test.ts")) out.push(p);
  }
  return out;
}

describe("the check: browser suites close through closeBrowserSuite", () => {
  it("finds every browser suite (there are many)", () => {
    expect(browserSuites(TESTS).length).toBeGreaterThan(50);
  });

  it("no browser suite under tests/ closes in a bare afterAll", () => {
    const bad = browserSuites(TESTS).flatMap((f) =>
      bareTeardowns(fs.readFileSync(f, "utf-8")).map(
        (w) => `${path.relative(TESTS, f)}: ${w}`,
      ),
    );
    expect(bad).toEqual([]);
  });

  it("fails on a suite with a bare afterAll", () => {
    const bare = `
let browser = null;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => {
  await browser?.close();
  await s?.stop();
});`;
    expect(bareTeardowns(bare)).toEqual([
      "line 4: an afterAll closes without closeBrowserSuite",
      "it opens a browser and no afterAll calls closeBrowserSuite",
    ]);
    // A nested afterAll that stops a server alone is bare too.
    expect(
      bareTeardowns(
        `describe("x", () => {\n  afterAll(() => stopServer(s));\n});`,
      ),
    ).toEqual(["line 2: an afterAll closes without closeBrowserSuite"]);
    // A browser and no teardown at all.
    expect(
      bareTeardowns(
        `beforeAll(async () => { b = await pw.chromium.connect(ws); });`,
      ),
    ).toEqual(["it opens a browser and no afterAll calls closeBrowserSuite"]);
  });

  it("passes a suite that closes through the helper", () => {
    const ok = `
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => {
  await s?.settings({ language: "en" }); // .close() in a comment is fine
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});`;
    expect(bareTeardowns(ok)).toEqual([]);
  });
});

describe("closeBrowserSuite", () => {
  it("drops routes, closes contexts, then browsers, then servers in order, then after", async () => {
    const log: string[] = [];
    const ctx = (name: string) => ({
      unrouteAll: async (o: { behavior?: string }) => {
        log.push(`${name}.unrouteAll(${o.behavior})`);
      },
      close: async () => {
        log.push(`${name}.close`);
      },
    });
    const own = ctx("ctxB");
    const browser = {
      contexts: () => [own],
      close: async () => {
        log.push("browser.close");
      },
    };
    await closeBrowserSuite({
      contexts: [ctx("ctxA") as never, null],
      browsers: [browser as never, undefined],
      servers: [
        { stop: async () => void log.push("server1.stop") },
        null,
        () => void log.push("server2"),
        { close: () => void log.push("host.close") },
      ],
      after: () => void log.push("after"),
    });
    expect(log).toEqual([
      "ctxA.unrouteAll(ignoreErrors)",
      "ctxB.unrouteAll(ignoreErrors)",
      "ctxA.close",
      "ctxB.close",
      "browser.close",
      "server1.stop",
      "server2",
      "host.close",
      "after",
    ]);
  });

  it("a failing step does not skip the later ones; the first failure is thrown", async () => {
    const log: string[] = [];
    const p = closeBrowserSuite({
      contexts: [
        {
          unrouteAll: async () => {
            throw new Error("gone");
          },
          close: async () => {
            throw new Error("gone");
          },
        } as never,
      ],
      browsers: [
        {
          contexts: () => [],
          close: async () => {
            throw new Error("browser close failed");
          },
        } as never,
      ],
      servers: [
        () => {
          throw new Error("stop failed");
        },
        () => void log.push("second server"),
      ],
      after: () => void log.push("after"),
    });
    await expect(p).rejects.toThrow("browser close failed");
    expect(log).toEqual(["second server", "after"]);
  });

  it("an in-process server with an open event stream closes at once", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hi\n\n");
      // Never ends: as a page's event stream.
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    const req = http.get(`http://127.0.0.1:${port}/`);
    await new Promise<void>((r) =>
      req.on("response", (res) => res.once("data", () => r())),
    );
    req.on("error", () => {});
    const t = Date.now();
    const closed = closeBrowserSuite({ servers: [server] }).then(() => true);
    const done = await Promise.race([
      closed,
      new Promise<false>((r) => setTimeout(() => r(false), 2_000)),
    ]);
    req.destroy();
    await closed;
    expect(done).toBe(true);
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it("a test's Den server stops at once with an event stream open", async () => {
    const s = await startAgentsPageServer();
    let req: http.ClientRequest | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        req = http.get(
          `${s.base}/api/server-log`,
          { headers: denAuth(s.stateDir) },
          (res) => {
            expect(res.headers["content-type"]).toMatch(/event-stream/);
            res.once("data", () => resolve());
          },
        );
        req.on("error", reject);
      });
      const t = Date.now();
      await closeBrowserSuite({ servers: [s] });
      expect(Date.now() - t).toBeLessThan(2_000);
    } finally {
      (req as http.ClientRequest | null)?.destroy();
      await s.stop();
    }
  }, 60_000);
});

describe("the time limit", () => {
  it("a browser suite whose teardown takes past 10 s still passes", async () => {
    // A browser suite of its own, in a temp dir, run by its own Jest with
    // this checkout's setup: its one teardown step takes 10.5 s.
    const root = path.resolve(TESTS, "..");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-slow-teardown-"));
    const helper = path.join(root, "tests", "browser-teardown.js");
    fs.writeFileSync(
      path.join(dir, "slow.browser.test.ts"),
      [
        `import { afterAll, expect, it } from "@jest/globals";`,
        `import { closeBrowserSuite } from ${JSON.stringify(helper)};`,
        `it("passes", () => expect(1).toBe(1));`,
        `afterAll(() => closeBrowserSuite({ servers: [() => new Promise((r) => setTimeout(r, 10_500))] }));`,
      ].join("\n"),
    );
    const config = {
      rootDir: root,
      roots: [dir],
      testMatch: ["**/*.test.ts"],
      testEnvironment: "node",
      extensionsToTreatAsEsm: [".ts"],
      moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1", "^(/.*)\\.js$": "$1" },
      transform: {
        "^.+\\.[jt]sx?$": [
          "ts-jest",
          {
            useESM: true,
            tsconfig: path.join(root, "tsconfig.jest.json"),
            diagnostics: false,
          },
        ],
      },
      setupFilesAfterEnv: [path.join(root, "tests", "setup.ts")],
    };
    const env = { ...process.env };
    delete env.DEN_BROWSER_TEST_TIMEOUT_MS;
    const child = spawn(
      process.execPath,
      [
        path.join(root, "node_modules", "jest", "bin", "jest.js"),
        "--config",
        JSON.stringify(config),
        "--runInBand",
        "--ci",
        "--forceExit",
      ],
      { cwd: root, env },
    );
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (out += b.toString()));
    const code = await new Promise<number | null>((r) =>
      child.on("close", (c) => r(c)),
    );
    fs.rmSync(dir, { recursive: true, force: true });
    expect([code, out.includes("1 passed")]).toEqual([0, true]);
    expect(out).not.toMatch(/Exceeded timeout/);
  }, 120_000);
});
