/**
 * Issue 1381 (dev.2 bed): a live check with no matrix gets its result
 * itself from the harness, not cells; gate/1381.mjs read `cells.find` and
 * threw on the bed. No gate/<n>.mjs with no matrix throws on the result
 * itself where it judges the same result in cells. In a child node: the
 * modules are ESM.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

const js = `
  import * as fs from "node:fs";
  import * as path from "node:path";
  import { pathToFileURL } from "node:url";
  const judge = async (mod, arg) => {
    try {
      return { rows: await mod.expect(arg) };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  };
  const out = [];
  for (const f of fs.readdirSync("gate").filter((f) => /^\\d+\\.mjs$/.test(f)).sort()) {
    const mod = await import(pathToFileURL(path.resolve("gate", f)).href);
    if ("matrix" in mod) continue;
    const result = { skip: "needs-nothing", detail: "made up" };
    out.push({
      file: f,
      bare: await judge(mod, result),
      cells: await judge(mod, [{ cell: {}, result }]),
      empty: await judge(mod, {}),
      emptyCells: await judge(mod, [{ cell: {}, result: {} }]),
    });
  }
  process.stdout.write(JSON.stringify(out));
`;

type Judged = { rows?: unknown; error?: string };
type Out = {
  file: string;
  bare: Judged;
  cells: Judged;
  empty: Judged;
  emptyCells: Judged;
};

describe("issue 1381: a gate with no matrix takes its result itself", () => {
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DEN_ROOT: ROOT },
  });
  const out = p.status === 0 ? (JSON.parse(p.stdout) as Out[]) : [];

  it("finds the modules", () => {
    expect(p.stderr).toBe("");
    expect(out.map((o) => o.file)).toContain("1381.mjs");
  });

  it("the result itself never throws where the same result in cells is judged", () => {
    const fails = out
      .flatMap((o) => [
        [o.file, o.bare, o.cells] as const,
        [o.file, o.empty, o.emptyCells] as const,
      ])
      .filter(([, bare, cells]) => bare.error && !cells.error)
      .map(([file, bare]) => `${file}: ${bare.error}`);
    expect(fails).toEqual([]);
  });
});
