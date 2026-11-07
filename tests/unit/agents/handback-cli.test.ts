/**
 * `<cli> agents handback-check <file|->` (den#5): the hand-back check from
 * the command line. Exit 0 when the hand-back is complete and plain, 1 with
 * each problem when it is not, 2 when it is asked wrong.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-hb-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const GOOD = [
  "## Hand-back",
  "- URL: https://x.example/agents",
  "- Machine: the laptop",
  "- Branch: main",
  "- What changed: the Start button works.",
  "- What to click: Agents, then Start.",
  "- Decisions:",
  "  1. Ship it today?",
].join("\n");

async function check(
  args: string[],
  stdin?: string,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdAgents(["handback-check", ...args], {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    ...(stdin !== undefined
      ? { readHandback: async (src: string) => (src === "-" ? stdin : "") }
      : {}),
  } as never);
  return { code, out, err };
}

describe("agents handback-check", () => {
  it("passes a good hand-back from a file", async () => {
    const f = path.join(tmp, "good.md");
    fs.writeFileSync(f, GOOD);
    expect(await check([f])).toEqual({
      code: 0,
      out: ["✓ the hand-back is complete and plain"],
      err: [],
    });
  });

  it("fails a bad one from stdin with each problem", async () => {
    const r = await check(["-"], GOOD.replace("the Start button", "#7"));
    expect(r.code).toBe(1);
    expect(r.out).toEqual([
      "✗ the hand-back is not ready:",
      `  - "#7" is not explained. Say what it is, e.g. "#7 (what it is)".`,
    ]);
  });

  it("--json gives the result as data", async () => {
    const r = await check(["-", "--json"], "## Hand-back\n");
    expect(r.code).toBe(1);
    const o = JSON.parse(r.out.join("\n")) as {
      ok: boolean;
      problems: string[];
    };
    expect(o.ok).toBe(false);
    expect(o.problems).toHaveLength(6);
  });

  it("a missing file is exit 1; no argument is a usage error", async () => {
    const r = await check([path.join(tmp, "none.md")]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/can't read .*none\.md \(ENOENT\)/);
    expect((await check([])).code).toBe(2);
  });
});
