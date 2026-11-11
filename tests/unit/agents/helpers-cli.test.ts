/**
 * `agents helpers <id> [<helper>]` (D32): an agent's helpers, the current
 * conversation's by default (--all: the earlier ones too, marked), or one
 * helper's transcript (--limit: its last lines). Read-only, and says why.
 * A rig (nothing runs), Claude Code's files under its own HOME.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as path from "path";
import { HELPERS_READ_ONLY_NOTE } from "../../../src/shared/agents/helpers.js";
import { resetHelperCache } from "../../../src/shared/agents/claude-helpers.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";
import { H0, H1, seedScout } from "./helpers/seed-helpers.js";

afterEach(async () => {
  await cleanupRigs();
  resetHelperCache();
});

async function scout(opts: { lines?: number; earlier?: boolean } = {}) {
  const r = await rig();
  const home = path.join(r.dir, "home");
  r.deps.env = { ...r.deps.env, HOME: home };
  seedScout(r.stateDir, r.wsDir("north"), home, opts);
  return r;
}
const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const out = (r: Rig) => r.out.join("\n");

describe("agents helpers <id>", () => {
  it("the current conversation's helpers; the earlier ones counted, not shown", async () => {
    const r = await scout({ earlier: true });
    expect(await agents(r, "helpers", "scout", "-w", "north")).toBe(0);
    expect(out(r)).toMatch(/^HELPER\s+WHAT\s+TYPE/m);
    expect(out(r)).toContain(H1);
    expect(out(r)).toContain("Count the notes");
    expect(out(r)).not.toContain(H0);
    expect(out(r)).toContain("1 more from earlier conversations: --all");
    expect(out(r)).toContain(HELPERS_READ_ONLY_NOTE);
  });

  it("--all: the earlier ones too, marked", async () => {
    const r = await scout({ earlier: true });
    expect(await agents(r, "helpers", "scout", "-w", "north", "--all")).toBe(0);
    const line = r.out.find((l) => l.includes(H0)) ?? "";
    expect(line).toContain("Sort the notes");
    expect(line).toContain("done (earlier)");
    expect(out(r)).not.toContain("more from earlier");
  });

  it("--json: the helpers as data, earlier ones only with --all", async () => {
    const r = await scout({ earlier: true });
    expect(await agents(r, "helpers", "scout", "-w", "north", "--json")).toBe(
      0,
    );
    const j = JSON.parse(out(r)) as {
      supported: boolean;
      helpers: Array<{ id: string; earlier?: true }>;
      note: string;
    };
    expect(j.supported).toBe(true);
    expect(j.helpers.map((h) => h.id)).toEqual([H1]);
    expect(j.note).toBe(HELPERS_READ_ONLY_NOTE);
    r.out.length = 0;
    await agents(r, "helpers", "scout", "-w", "north", "--json", "--all");
    const all = JSON.parse(out(r)) as typeof j;
    expect(all.helpers.map((h) => [h.id, h.earlier])).toEqual([
      [H1, undefined],
      [H0, true],
    ]);
  });

  it("an agent whose conversation started none: says so", async () => {
    const r = await rig();
    r.deps.env = { ...r.deps.env, HOME: path.join(r.dir, "home") };
    seedScout(r.stateDir, r.wsDir("north"), path.join(r.dir, "elsewhere"));
    expect(await agents(r, "helpers", "scout", "-w", "north")).toBe(0);
    expect(out(r)).toContain("scout has started no helpers");
  });
});

describe("agents helpers <id> <helper>", () => {
  it("its transcript: what it was asked, then its lines, then why it's read-only", async () => {
    const r = await scout({ lines: 4 });
    expect(await agents(r, "helpers", "scout", H1, "-w", "north")).toBe(0);
    expect(r.out[0]).toBe("Count the notes (done, Explore)");
    expect(r.out).toContain("asked: Count the notes");
    expect(r.out).toContain("step 3");
    expect(r.out.at(-1)).toBe(HELPERS_READ_ONLY_NOTE);
  });

  it("--limit: its last lines, the rest counted", async () => {
    const r = await scout({ lines: 6 });
    expect(
      await agents(r, "helpers", "scout", H1, "-w", "north", "--limit", "2"),
    ).toBe(0);
    expect(r.out).toContain("… 4 earlier lines");
    expect(r.out).toContain("step 5");
    expect(r.out).not.toContain("step 3");
  });

  it("a bad --limit is a usage error; a helper it doesn't have, an error", async () => {
    const r = await scout();
    for (const bad of ["0", "-1", "2.5", "x"])
      expect(
        await agents(r, "helpers", "scout", H1, "-w", "north", "--limit", bad),
      ).toBe(2);
    expect(
      await agents(r, "helpers", "scout", "a9f0c0ffee0000009", "-w", "north"),
    ).toBe(1);
    expect(r.err.join("\n")).toContain('no helper "a9f0c0ffee0000009"');
  });
});
