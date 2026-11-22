/**
 * Issue 786 part 3b: the layout routes' logic (layout-routes.ts) with a
 * temp state folder: the revision, the stale-save check, the list and a
 * restore that keeps the layout it replaces.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  listLayoutSnapshots,
  snapshotLayout,
} from "../../../src/shared/layout-snapshots.js";
import {
  layoutRev,
  layoutSnapshotsAnswer,
  restoreLayout,
  staleLayoutSave,
} from "../../../src/ui/server/layout-routes.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const stateDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-786-routes-"));
  tmps.push(d);
  return d;
};
const at = (min: number) => new Date(Date.UTC(2026, 10, 22, 8, min));

describe("layout routes", () => {
  it("a save is stale only when it sends a revision that isn't the stored one", () => {
    const stored = { hidden: ["logs"] };
    expect(staleLayoutSave(layoutRev(stored), stored)).toBe(false);
    expect(staleLayoutSave(layoutRev({ hidden: [] }), stored)).toBe(true);
    expect(staleLayoutSave(undefined, stored)).toBe(false);
  });

  it("lists the snapshots, newest first, marking the layout now", () => {
    const d = stateDir();
    snapshotLayout(d, { pins: [{ item: "a" }], hidden: ["x", "y"] }, at(0));
    snapshotLayout(d, { collapsed: true }, at(30));
    const a = layoutSnapshotsAnswer(d, { collapsed: true });
    expect(
      a.snapshots.map((s) => [s.pins, s.hidden, s.collapsed, s.current]),
    ).toEqual([
      [0, 0, true, true],
      [1, 2, false, false],
    ]);
    expect(a.shell_rev).toBe(layoutRev({ collapsed: true }));
  });

  it("a restore puts the snapshot back and keeps the layout it replaces", () => {
    const d = stateDir();
    const old = snapshotLayout(d, { hidden: ["logs"] }, at(0));
    let shell: unknown = { hidden: ["agents", "tests"] };
    const r = restoreLayout(
      d,
      old?.id,
      () => shell,
      (s) => (shell = s),
      at(5),
    );
    expect(r).toEqual({
      status: 200,
      body: { ok: true, shell_rev: layoutRev({ hidden: ["logs"] }) },
    });
    expect(shell).toEqual({ hidden: ["logs"] });
    expect(listLayoutSnapshots(d)[0].shell).toEqual({
      hidden: ["agents", "tests"],
    });
    expect(
      restoreLayout(
        d,
        "nope",
        () => shell,
        () => {},
      ).status,
    ).toBe(404);
    expect(
      restoreLayout(
        d,
        7,
        () => shell,
        () => {},
      ).status,
    ).toBe(400);
  });
});
