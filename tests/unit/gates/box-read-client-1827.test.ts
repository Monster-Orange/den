import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  realBrowserRead,
  visualFit,
  PwClientMismatch,
  type BrowserRead,
  type VisualEnv,
} from "../../../src/shared/gates/visual.js";
import type { GateBox } from "../../../src/shared/gates/boxes.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1827-"));
  tmps.push(d);
  return d;
};

function project(version: string, answer428 = false): string {
  const r = tmp();
  const pkg = path.join(r, "node_modules", "@playwright", "test");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@playwright/test", version, main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(pkg, "index.js"),
    `const fs = require("fs");
const path = require("path");
exports.chromium = {
  connect: async (ws) => {
    fs.writeFileSync(path.join(__dirname, "connected"), ws);
    if (${answer428}) throw new Error("browserType.connect: WebSocket error: " + ws + " 428 Precondition Required");
    const page = {
      route: async () => {},
      goto: async () => {},
      evaluate: async () => ({ platform: "linux/amd64", fonts: {} }),
      close: async () => {},
    };
    return { version: () => "stub-${version}", newPage: async () => page, close: async () => {} };
  },
};
`,
  );
  return r;
}
const connected = (r: string) => {
  const f = path.join(r, "node_modules", "@playwright", "test", "connected");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : undefined;
};
const clientDir = (r: string) =>
  fs.realpathSync(path.join(r, "node_modules", "@playwright", "test"));

describe("the box read uses the run's own Playwright (issue 1827)", () => {
  it("connects with the Playwright resolved from the run's folder, and reads the box", async () => {
    const r = project("1.61.1");
    const env = await realBrowserRead("ws://m1.test:3931/", 2000, {
      from: r,
      serves: "1.61.1",
    });
    expect(env.chromium).toBe("stub-1.61.1");
    expect(connected(r)).toBe("ws://m1.test:3931/");
  });

  it("a client of another version than the box's server is refused before connecting, in plain words", async () => {
    const r = project("1.64.1");
    const read = realBrowserRead("ws://m1.test:3931/", 2000, {
      from: r,
      serves: "1.61.1",
    });
    await expect(read).rejects.toBeInstanceOf(PwClientMismatch);
    await expect(read).rejects.toThrow(
      `serves Playwright 1.61.1; this run's client is 1.64.1 (from ${clientDir(r)})`,
    );
    expect(connected(r)).toBeUndefined();
  });

  it("a 428 from a box of an unknown version reads as a version mismatch, naming the client", async () => {
    const r = project("1.64.1", true);
    const read = realBrowserRead("ws://m1.test:3931/", 2000, { from: r });
    await expect(read).rejects.toBeInstanceOf(PwClientMismatch);
    await expect(read).rejects.toThrow(
      `serves another Playwright version (it answered 428); this run's client is 1.64.1 (from ${clientDir(r)})`,
    );
  });
});

describe("visualFit hands the read the run's folder and the box's version (issue 1827)", () => {
  const ENV: VisualEnv = {
    platform: "linux/amd64",
    chromium: "149",
    fonts: {},
  };
  const box: GateBox = {
    name: "m1",
    ssh: "ci@m1.test",
    playwright: "ws://m1.test:3931/",
    playwright_version: "1.61.1",
  } as GateBox;

  it("passes the run's folder and the endpoint's version to the read", async () => {
    const seen: unknown[] = [];
    const read: BrowserRead = (ws, _t, o) => {
      seen.push({ ws, ...o });
      return Promise.resolve(ENV);
    };
    const fit = await visualFit({
      boxes: [box],
      records: [{ file: "t.browser.test.ts", env: ENV }],
      pwVersion: "1.61.1",
      read,
      timeoutMs: 1000,
      dir: tmp(),
      now: () => 0,
      from: "/work/project",
    });
    expect(fit.fit).toEqual(["m1"]);
    expect(seen).toEqual([
      { ws: "ws://m1.test:3931/", from: "/work/project", serves: "1.61.1" },
    ]);
  });

  it("a mismatch says both versions and the client's path, not that the browser couldn't be read", async () => {
    const read: BrowserRead = () =>
      Promise.reject(
        new PwClientMismatch({
          serves: "1.61.1",
          client: "1.64.1",
          from: "/den/node_modules/@playwright/test",
        }),
      );
    const fit = await visualFit({
      boxes: [box],
      records: [{ file: "t.browser.test.ts", env: ENV }],
      pwVersion: "1.61.1",
      read,
      timeoutMs: 1000,
      dir: tmp(),
      now: () => 0,
      from: "/work/project",
    });
    expect(fit.unfit).toEqual([
      {
        name: "m1",
        why: "box m1 serves Playwright 1.61.1; this run's client is 1.64.1 (from /den/node_modules/@playwright/test)",
      },
    ]);
  });
});
