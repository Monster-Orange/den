import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

const STATE = {
  url: "/services",
  ready: "complete",
  button: true,
  wired: "1",
  expanded: "false",
  pops: 1,
  popHidden: true,
  popBox: [0, 0],
  header: true,
  active: "den-bell",
};

function openBellOnStandIn(headerShows: boolean): {
  error: string | null;
  shots: string[];
} {
  const js = `
    const g = await import("./gate/93.mjs");
    const shots = [];
    let evals = 0;
    const never = async () => { throw new Error("locator.waitFor: Timeout 30000ms exceeded."); };
    const page = {
      __errs: ["TypeError: x is undefined"],
      goto: async () => {},
      waitForSelector: async () => {},
      click: async () => {},
      evaluate: async () => (++evals === 1 ? "#den-bell (in the bell)" : ${JSON.stringify(STATE)}),
      locator: (sel) => ({
        first() { return this; },
        waitFor: /^#den-bell-h$/.test(sel) && !${headerShows} ? never : /cl-overlay/.test(sel) ? never : async () => {},
      }),
    };
    const ctx = { page, url: "http://den.test", browser: "webkit", width: 1280, shot: async (n) => { shots.push(n); } };
    let error = null;
    try { await g.openBell(ctx); } catch (e) { error = String(e?.message ?? e); }
    console.log(JSON.stringify({ error, shots }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

describe("issue 1905: check 93 says what the bell was doing when its header didn't show", () => {
  it("the header never shows: the error gives the bell's state, what was under the click, page errors and a screenshot", () => {
    const r = openBellOnStandIn(false);
    expect(r.error).toMatch(
      /^the bell's header didn't show 30 s after the click: /,
    );
    const said = JSON.parse(r.error!.replace(/^[^{]*/, ""));
    expect(said).toMatchObject({
      ...STATE,
      atClick: "#den-bell (in the bell)",
      errors: ["TypeError: x is undefined"],
      shot: "bell-closed-webkit-1280",
    });
    expect(r.shots).toEqual(["bell-closed-webkit-1280"]);
  });

  it("the header shows: openBell returns, with no screenshot", () => {
    const r = openBellOnStandIn(true);
    expect(r.error).toBeNull();
    expect(r.shots).toEqual([]);
  });
});
