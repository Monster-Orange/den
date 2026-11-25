/**
 * Issue 750: gate/750.mjs's rows 7 and 8 read the bed's own Den through
 * its CLI (`hub groups --fresh`, the read the Agents page gets): row 7
 * with hub.groups on, row 8 with it off. A read of the bed's Hub that
 * finds no groups there skips by name; a CLI or config that fails is the
 * product's, and fails, saying how. The module is plain JavaScript, so it
 * runs in a child node, as the bed runs it. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function verdict(bed: unknown): Row[] {
  const js = `
    const g = await import("./gate/750.mjs");
    const rows = g.expect([{ cell: {}, result: { tag: "chromium-1280", bed: ${JSON.stringify(bed ?? null)} } }]);
    process.stdout.write(JSON.stringify(rows.slice(6, 8)));
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", js], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as Row[];
}

const OFF = { ok: true, state: "off" };

describe("issue 750: the bed's own groups read", () => {
  it("the bed's Hub answers groups, and off reads off: both pass", () => {
    const [hub, off] = verdict({ real: { ok: true, state: "ok" }, off: OFF });
    expect(hub).toMatchObject({ ok: true, detail: "the bed's Hub: ok" });
    expect(off.ok).toBe(true);
  });

  it("a bed Hub with no groups route skips row 7 by name; row 8 still runs", () => {
    const [hub, off] = verdict({ real: OFF, off: OFF });
    expect(hub).toMatchObject({ ok: null, skip: "needs-hub-groups" });
    expect(off.ok).toBe(true);
    const [none] = verdict({ real: { ok: true, state: "none" }, off: OFF });
    expect(none.skip).toBe("needs-bed-hub");
  });

  it("a CLI that fails fails the row, with its words", () => {
    const [hub, off] = verdict({
      real: { error: "hub groups: 2: usage: den-gate hub <put|pull>" },
      off: { error: "hub groups: 1: boom" },
    });
    expect(hub.ok).toBe(false);
    expect(hub.detail).toContain("usage");
    expect(off.ok).toBe(false);
    expect(off.detail).toContain("boom");
  });

  it("off that doesn't read off fails", () => {
    const [, off] = verdict({ real: OFF, off: { ok: true, state: "ok" } });
    expect(off.ok).toBe(false);
  });

  it("config that fails fails both rows, never skips", () => {
    for (const x of verdict({ fail: "config", why: "hub.groups=on: 1" })) {
      expect(x.ok).toBe(false);
      expect(x.detail).toContain("hub.groups=on: 1");
    }
  });

  it("no ctx.cli, or no step: a named skip", () => {
    for (const x of verdict({ skip: "needs-bed-cli", why: "no ctx.cli" }))
      expect(x.skip).toBe("needs-bed-cli");
    for (const x of verdict(null)) expect(x.skip).toBe("needs-bed-groups");
  });

  it("a bed Hub that refuses Den's token fails row 7, never a skip", () => {
    const [hub] = verdict({ real: { ok: true, state: "rejected" }, off: OFF });
    expect(hub.ok).toBe(false);
    expect(hub.skip).toBeUndefined();
  });
});

/** bedGroups against a fake CLI: what it ran, and what it left set. */
function bedRun(start: string | undefined): {
  ran: string[];
  left: string | undefined;
} {
  const js = `
    const g = await import("./gate/750.mjs");
    let v = ${JSON.stringify(start ?? null)};
    const ran = [];
    const cli = (args) => {
      ran.push(args.join(" "));
      if (args[0] === "config" && args[1] === "hub.groups")
        return { code: 0, out: (v ?? "auto") + "\\n" };
      if (args[0] === "config" && args[1] === "rm") { v = null; return { code: 0, out: "" }; }
      if (args[0] === "config") { v = args[1].split("=")[1]; return { code: 0, out: "" }; }
      return { code: 0, out: JSON.stringify({ ok: true, state: v === "off" ? "off" : "ok" }) };
    };
    g.bedGroups({ cli });
    process.stdout.write(JSON.stringify({ ran, left: v }));
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", js], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  const o = JSON.parse(r.stdout) as { ran: string[]; left: string | null };
  return { ran: o.ran, left: o.left ?? undefined };
}

describe("issue 750: the bed's hub.groups is put back", () => {
  it("unset before: removed after", () => {
    const r = bedRun(undefined);
    expect(r.ran).toContain("config hub.groups=on");
    expect(r.ran).toContain("config hub.groups=off");
    expect(r.left).toBeUndefined();
  });

  it("set before: the same value after", () => {
    for (const v of ["on", "off"]) expect(bedRun(v).left).toBe(v);
  });
});
