/**
 * Issue 601's live check (gate/601.mjs) finds Den's loopback port from
 * the bed's host address (ctx.hostUrl), so it needs no signed-in call:
 * once the address is proven, a loopback sign-in is sent to the address
 * and the bed's signed calls on loopback can't sign in. With no port, the
 * loopback clauses report "not run", never a failure.
 * The gate file is ESM: run in a child node.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function node(js: string): unknown {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe("issue 601's check: the loopback port", () => {
  it("comes from the bed's host address, with no signed-in call", () => {
    const out = node(`
      const g = await import("./gate/601.mjs");
      console.log(JSON.stringify([
        await g.loopbackPort({ hostUrl: "http://127.0.0.1:7796", api: async () => { throw new Error("no session"); } }),
        await g.loopbackPort({ api: async () => ({ port: 7801 }) }),
        await g.loopbackPort({ api: async () => { throw new Error("no session"); } }),
      ]));
    `);
    expect(out).toEqual([7796, 7801, 0]);
  });

  it("with no port, the after-the-address-left clause is not run, not a failure", () => {
    const rows = node(`
      const g = await import("./gate/601.mjs");
      const r = { origin: "https://den.example.test", https: true, proven: true, port: 0,
        afterDead: { status: 401, waitedMs: 1, timedOut: false, windowMs: 95000, windowTimedOut: false } };
      console.log(JSON.stringify(g.expect([{ result: r }])));
    `) as { clause: string; ok: boolean | null; skip?: string }[];
    const last = rows[rows.length - 1]!;
    expect(last.clause).toMatch(/after the address stops answering/);
    expect(last.ok).toBeNull();
    expect(last.skip).toBe("needs-loopback-port");
  });
});
