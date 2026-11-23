/**
 * Issue 728: doctor says whether the edge's proof was rotated once, and
 * names each stack whose generated secrets agents could read before, for
 * its owning project's agent to rotate (never a value; never regenerated
 * by Den). A stack whose generated.env changed after the rotation is done.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { edgeRotationLines } from "../../../src/ui/cli/doctor-command.js";

let dir = "";
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-drot-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const proof = () =>
  fs.writeFileSync(path.join(dir, "den-edge-proof"), "a".repeat(64) + "\n", {
    mode: 0o600,
  });
const marker = (at: string) =>
  fs.writeFileSync(
    path.join(dir, "proof-rotated.json"),
    JSON.stringify({ at, rotated: true }),
  );
const stack = (folder: string, mtime: Date) => {
  const f = path.join(dir, "stacks", folder, "generated.env");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "SECRET_VALUE_NEVER_SHOWN=x\n", { mode: 0o600 });
  fs.utimesSync(f, mtime, mtime);
};
const rows = () =>
  edgeRotationLines("Den", {
    edgeDir: () => dir,
    projects: () => ["north", "south-side"],
  });

describe("issue 728: doctor's edge rotation rows", () => {
  it("not rotated yet: a warning that Den rotates it at its next start", () => {
    proof();
    const r = rows();
    expect(r.checks[0]).toMatchObject({ id: "edge_rotate", status: "warn" });
    expect(r.checks[0].detail).toMatch(/next start/);
  });

  it("rotated: ok, with when", () => {
    proof();
    marker("2026-11-23T08:00:00.000Z");
    const r = rows();
    expect(r.checks[0]).toMatchObject({ id: "edge_rotate", status: "ok" });
    expect(r.checks[0].detail).toContain("2026-11-23T08:00:00.000Z");
  });

  it("a stack not rotated since: named with its owning project, for that project's agent; no value shown", () => {
    proof();
    marker("2026-11-23T08:00:00.000Z");
    stack("db-north", new Date("2026-11-20T00:00:00Z"));
    stack("cache-south-side", new Date("2026-11-24T00:00:00Z"));
    const r = rows();
    const s = r.checks.find((c) => c.id === "edge_stack_secrets")!;
    expect(s.status).toBe("warn");
    expect(s.detail).toMatch(/db .*project north/);
    expect(s.detail).toMatch(/north's agent/);
    expect(s.detail).not.toMatch(/cache/);
    expect(r.lines.join("\n")).not.toContain("SECRET_VALUE_NEVER_SHOWN");
  });

  it("every stack rotated after the marker: ok", () => {
    proof();
    marker("2026-11-23T08:00:00.000Z");
    stack("db-north", new Date("2026-11-24T00:00:00Z"));
    expect(
      rows().checks.find((c) => c.id === "edge_stack_secrets")!.status,
    ).toBe("ok");
  });

  it("no edge here: no rows", () => {
    expect(
      edgeRotationLines("Den", {
        edgeDir: () => null,
        projects: () => [],
      }),
    ).toEqual({ lines: [], checks: [] });
  });
});
