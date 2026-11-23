/**
 * Issue 750: gate/750.mjs checks the bed's own groups read through Den. A
 * read that fails (no person token, a network error) says why in the
 * skipped row, never a bare "null". The module is plain JavaScript, so it
 * runs in a child node, as the bed runs it. Its rows are the 7th and 8th
 * (the real-Hub leg's four follow them). Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function verdict(result: Record<string, unknown>): Row[] {
  const js = `
    const g = await import("./gate/750.mjs");
    const rows = g.expect([{ cell: {}, result: ${JSON.stringify(result)} }]);
    process.stdout.write(JSON.stringify(rows.slice(6, 8)));
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", js], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as Row[];
}

describe("issue 750: the bed's own groups read", () => {
  it("a failed read skips with its reason in the row", () => {
    const [hub, off] = verdict({
      tag: "chromium-1280",
      real: null,
      realError: "bed: no person token",
    });
    expect(hub.ok).toBeNull();
    expect(hub.skip).toBe("needs-hub-groups");
    expect(hub.detail).toContain("bed: no person token");
    expect(off.detail).toContain("bed: no person token");
  });

  it("a read that answers keeps its state and adds nothing", () => {
    const [hub, off] = verdict({ tag: "chromium-1280", real: "off" });
    expect(hub.detail).toBe("the bed's Hub: off");
    expect(off).toMatchObject({ ok: true, detail: "the bed's Den: off" });
  });
});
