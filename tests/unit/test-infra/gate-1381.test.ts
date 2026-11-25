/**
 * Issue 1381's live check (gate/1381.mjs), judged on made-up results: a
 * box whose copy reports "low on memory: N MB" and then gets its slot,
 * leaving no den-box-* folder, passes all three clauses; "memory unknown"
 * fails the first. A missing, held or unreachable box skips with a reason
 * that names what's missing, never a pass. The copy carries how the box is
 * reached and never more than one slot. In a child node: the file is ESM.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function call(expr: string): unknown {
  const js = `
    const g = await import("./gate/1381.mjs");
    process.stdout.write(JSON.stringify(${expr}));
  `;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DEN_ROOT: ROOT },
  });
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout);
}
type Row = { ok: unknown; skip?: string; detail: string };
const judge = (r: unknown) =>
  call(`g.expect([{ cell: {}, result: ${JSON.stringify(r)} }])`) as Row[];

const phase = (o: Record<string, unknown>) => ({
  code: 0,
  state: "open",
  granted: false,
  leftTemps: 0,
  ...o,
});
const good = {
  name: "box-a",
  low: phase({
    code: null,
    state: "low",
    reason: "box low on memory: 6123 MB free, needs 100000000 MB",
  }),
  open: phase({ granted: true }),
  mb: 6123,
};

describe("gate/1381 expect", () => {
  it("a number, a slot and no folder left: all three pass", () => {
    const rows = judge({ boxes: [good] });
    expect(rows.map((r) => r.ok)).toEqual([true, true, true]);
    expect(rows[0]!.detail).toContain("6123 MB");
  });

  it("memory unknown fails the first clause", () => {
    const bad = {
      ...good,
      low: phase({
        state: "unknown",
        reason: "memory unknown: /proc/meminfo has no MemAvailable",
      }),
      mb: undefined,
    };
    const rows = judge({ boxes: [bad] });
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.detail).toContain("no MemAvailable");
  });

  it("no slot given fails the second; a folder left fails the third", () => {
    const rows = judge({
      boxes: [{ ...good, open: phase({ granted: false, leftTemps: 1 }) }],
    });
    expect(rows.map((r) => r.ok)).toEqual([true, false, false]);
  });

  it("one good box and one failing: the clause fails", () => {
    const rows = judge({
      boxes: [
        good,
        {
          ...good,
          name: "box-b",
          mb: undefined,
          low: phase({ state: "unknown" }),
        },
      ],
    });
    expect(rows[0]!.ok).toBe(false);
  });

  it("no box, held boxes, or unreachable ones skip, saying what's missing", () => {
    const none = judge({
      boxes: [
        { name: "box-a", unusable: "not on this gate machine's box list" },
      ],
    });
    expect(
      none.every((r) => r.ok === null && r.skip === "needs-test-box"),
    ).toBe(true);
    expect(none[0]!.detail).toContain(
      "box-a: not on this gate machine's box list",
    );
    const held = judge({ boxes: [{ ...good, low: phase({ state: "held" }) }] });
    expect(held[0]).toMatchObject({ ok: null, skip: "needs-test-box-free" });
    const far = judge({
      boxes: [
        {
          ...good,
          low: phase({
            state: "unreachable",
            reason: "no answer over ssh in 5 s",
          }),
        },
      ],
    });
    expect(far[0]).toMatchObject({ ok: null, skip: "needs-test-box-reach" });
    expect(far[0]!.detail).toContain("no answer over ssh");
    const mac = judge({
      skip: "needs-macos-gate-host",
      detail: "this gate host is linux",
    });
    expect(mac[0]).toMatchObject({ ok: null, skip: "needs-macos-gate-host" });
  });
});

describe("gate/1381 helpers", () => {
  it("the copy carries how the box is reached, one slot, under its own name", () => {
    const c = call(
      `g.copyOf({ name: "box-a", browser_slots: 2, ssh: "den@h", ssh_port: 2222, ssh_identity: "/k", playwright: "ws://h:1", playwright_version: "1.2.3", hold_file: "/tmp/hold", min_free_mem_mb: 512 }, 9)`,
    ) as { box: Record<string, unknown> };
    expect(c.box).toEqual({
      name: "gate1381-box-a",
      browser_slots: 1,
      ssh: "den@h",
      ssh_port: 2222,
      ssh_identity: "/k",
      playwright: "ws://h:1",
      playwright_version: "1.2.3",
      hold_file: "/tmp/hold",
      min_free_mem_mb: 9,
    });
  });

  it("a box missing, without ssh, or turned off can't be used", () => {
    expect(call(`g.copyOf(undefined, 1)`)).toMatchObject({
      why: expect.stringContaining("not on"),
    });
    expect(
      call(`g.copyOf({ name: "x", playwright: "ws://h:1" }, 1)`),
    ).toMatchObject({
      why: expect.stringContaining("without ssh"),
    });
    expect(
      call(`g.copyOf({ name: "x", ssh: "h", enabled: false }, 1)`),
    ).toMatchObject({
      why: expect.stringContaining("turned off"),
    });
  });

  it("reads the MB from a low reason, the boxes asked for, and a grant", () => {
    expect(call(`g.lowMb("box low on memory: 42 MB free, needs 9 MB")`)).toBe(
      42,
    );
    expect(call(`g.lowMb("memory unknown: x") ?? null`)).toBeNull();
    expect(
      call(
        `g.boxNames({}, [{ name: "a", ssh: "h" }, { name: "b", playwright: "ws://h:1" }, { name: "c", ssh: "h2" }])`,
      ),
    ).toEqual(["a", "c"]);
    expect(call(`g.boxNames({ BG_1381_BOXES: " a , b,," })`)).toEqual([
      "a",
      "b",
    ]);
    const log = [
      JSON.stringify({ event: "asked", id: "x" }),
      JSON.stringify({ event: "granted", machine: "gate1381-box-a" }),
      "not json",
    ].join("\n");
    expect(call(`g.grantedOn(${JSON.stringify(log)}, "gate1381-box-a")`)).toBe(
      true,
    );
    expect(call(`g.grantedOn(${JSON.stringify(log)}, "local")`)).toBe(false);
  });

  it("a key path with ~/ is checked in the home folder, as ssh reads it", () => {
    expect(call(`g.expandHome("~/.ssh/k", "/h")`)).toBe("/h/.ssh/k");
    expect(call(`g.expandHome("/abs/k", "/h")`)).toBe("/abs/k");
    expect(call(`g.expandHome("~", "/h")`)).toBe("/h");
  });

  it("the machine's gate folder is where Den looks (macOS and Linux)", () => {
    expect(call(`g.machineGateDir({ HOME: "/h" }, "darwin")`)).toBe(
      "/h/Library/Application Support/den/gate-slots",
    );
    expect(call(`g.machineGateDir({ HOME: "/h" }, "linux")`)).toBe(
      "/h/.local/state/den/gate-slots",
    );
  });
});
