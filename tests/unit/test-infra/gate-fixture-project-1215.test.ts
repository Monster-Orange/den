/**
 * Issue 1215: a live check makes a project as the fixture person and
 * removes it at the end, even when the check throws
 * (gate/lib/fixture-project.mjs). The module is loaded by node itself (as
 * the bed loads it), against a fake ctx.fetch that records the calls.
 */
import { beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const MOD = path.join(process.cwd(), "gate", "lib", "fixture-project.mjs");

const SCRIPT = `
const { withFixtureProject } = await import(${JSON.stringify(MOD)});
function fakeCtx(o = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (p, init) => {
      calls.push({ path: p, method: init.method, body: JSON.parse(init.body) });
      if (p === "/api/workspaces/create")
        return (o.create ?? 200) === 200
          ? { status: 200, body: JSON.stringify({ ok: true, slug: "fx-long-name" }) }
          : { status: o.create, body: { ok: false, code: "fixture_scope" } };
      return { status: o.remove ?? 200, body: {} };
    },
  };
}
async function run(o, fn) {
  const ctx = fakeCtx(o);
  let ran = false;
  try {
    const value = await withFixtureProject(ctx, "fx long name", async (slug) => {
      ran = slug;
      return fn(slug);
    });
    return { value, ran, calls: ctx.calls };
  } catch (e) {
    return { error: e.message, ran, calls: ctx.calls };
  }
}
const out = {
  pass: await run({}, async () => "done"),
  throws: await run({}, async () => { throw new Error("clause failed"); }),
  refused: await run({ create: 403 }, async () => "never"),
  stuck: await run({ remove: 500 }, async () => "ok"),
};
console.log(JSON.stringify(out));
`;

type Run = {
  value?: string;
  error?: string;
  ran: string | false;
  calls: { path: string; method: string; body: Record<string, unknown> }[];
};
let out: Record<"pass" | "throws" | "refused" | "stuck", Run>;
beforeAll(() => {
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", SCRIPT], {
    encoding: "utf-8",
  });
  expect(p.stderr).toBe("");
  out = JSON.parse(p.stdout);
});

describe("withFixtureProject (issue 1215)", () => {
  it("makes the project, hands the check its slug, then deletes it", () => {
    expect([out.pass.value, out.pass.ran]).toEqual(["done", "fx-long-name"]);
    expect(out.pass.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/workspaces/create",
      "DELETE /api/workspaces",
    ]);
    expect(out.pass.calls[0].body).toEqual({ name: "fx long name" });
    expect(out.pass.calls[1].body).toEqual({
      name: "fx-long-name",
      agents: "stop",
    });
  });

  it("deletes it when the check throws, and the check's error is the one thrown", () => {
    expect(out.throws.error).toBe("clause failed");
    expect(out.throws.calls.at(-1)?.method).toBe("DELETE");
  });

  it("a refused create throws, naming the status and code, and runs nothing", () => {
    expect(out.refused.error).toMatch(/403 fixture_scope/);
    expect(out.refused.ran).toBe(false);
    expect(out.refused.calls).toHaveLength(1);
  });

  it("a failed delete after a passing check throws: a project never stays behind silently", () => {
    expect(out.stuck.error).toMatch(
      /couldn't delete the project "fx-long-name".*500/,
    );
  });
});
