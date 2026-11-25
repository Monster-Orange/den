/**
 * The live check in gate/746.mjs withdraws its own two held writes in
 * teardown, each with `approvals withdraw <id>` and that stub's own token
 * file, before the stub is removed (removal revokes its token). It never
 * touches a request another run or another agent made, or one that already
 * ended. Run on a stand-in bed context; invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Out {
  ids: string[];
  calls: { args: string[]; tokenFile: string | null }[];
  order: string[];
  log: string[];
}

function runTeardown(withdrawCode = 0): Out {
  const js = `
    const g = await import("./gate/746.mjs");
    const ids = [];
    const calls = [];
    const order = [];
    const live = new Set();
    const ctx = {
      agent: (id) => ({
        start: () => { if (!ids.includes(id)) ids.push(id); live.add(id); },
        running: async () => true,
        state: () => (live.has(id) ? "running" : null),
        remove: () => { live.delete(id); order.push("remove " + id); },
      }),
      cli: (args, opts = {}) => {
        if (args[0] === "approvals") {
          calls.push({ args, tokenFile: opts.env?.DEN_ACTOR_TOKEN_FILE ?? null });
          order.push("withdraw " + args[2]);
          return { code: ${withdrawCode}, out: "", err: ${withdrawCode} ? "Only the one that asked may withdraw a request." : "" };
        }
        return { code: 0, out: "", err: "" };
      },
      listBed: (p) => (p.startsWith("state:actor-token/") ? ["token"] : []),
      readBed: (p) =>
        p === "state:held-writes.json"
          ? JSON.stringify({ items: [
              { id: "rqallowaaaaaaaaa", state: "pending", args: { agent: ids[0] } },
              { id: "rqdenybbbbbbbbbb", state: "pending", args: { agent: ids[1] } },
              { id: "rqendedccccccccc", state: "denied", args: { agent: ids[0] } },
              { id: "rqforeigndddddddd", state: "pending", args: { agent: "someone-else" } },
            ] })
          : "",
    };
    await g.setup(ctx);
    const origErr = process.stderr.write.bind(process.stderr);
    const log = [];
    process.stderr.write = (x) => (log.push(String(x)), true);
    await g.teardown(ctx);
    process.stderr.write = origErr;
    console.log(JSON.stringify({ ids, calls, order, log }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop() as string) as Out;
}

describe("issue 1293: issue 746's live check withdraws its own requests in teardown", () => {
  it("withdraws this run's two pending requests, each with its stub's own token", () => {
    const o = runTeardown();
    expect(o.ids).toHaveLength(2);
    expect(o.calls.map((c) => c.args)).toEqual([
      ["approvals", "withdraw", "rqallowaaaaaaaaa"],
      ["approvals", "withdraw", "rqdenybbbbbbbbbb"],
    ]);
    expect(o.calls[0].tokenFile).toMatch(
      new RegExp(`actor-token[/\\\\]${o.ids[0]}[/\\\\]token$`),
    );
    expect(o.calls[1].tokenFile).toMatch(
      new RegExp(`actor-token[/\\\\]${o.ids[1]}[/\\\\]token$`),
    );
  });

  it("never touches a request that ended, or another agent's", () => {
    const sent = runTeardown().calls.map((c) => c.args[2]);
    expect(sent).not.toContain("rqendedccccccccc");
    expect(sent).not.toContain("rqforeigndddddddd");
  });

  it("withdraws before it removes the stubs (removal revokes the token)", () => {
    const o = runTeardown();
    const lastWithdraw = Math.max(
      ...o.order.map((x, i) => (x.startsWith("withdraw") ? i : -1)),
    );
    const firstRemove = o.order.findIndex((x) => x.startsWith("remove"));
    expect(firstRemove).toBeGreaterThan(lastWithdraw);
  });

  it("the run's log shows each withdraw", () => {
    const o = runTeardown();
    const lines = o.log.join("");
    expect(lines).toContain(
      `746 teardown: ${o.ids[0]} withdrew rqallowaaaaaaaaa`,
    );
    expect(lines).toContain(
      `746 teardown: ${o.ids[1]} withdrew rqdenybbbbbbbbbb`,
    );
  });

  it("a refused withdraw doesn't stop the teardown: the stubs are still removed", () => {
    const o = runTeardown(1);
    expect(o.order.filter((x) => x.startsWith("remove"))).toHaveLength(2);
    expect(o.log.join("")).toContain("couldn't withdraw rqallowaaaaaaaaa");
  });
});
