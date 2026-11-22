/**
 * Issue 786 clauses 4 and 5: rolling layout snapshots (at most every 15
 * minutes, at most 48 kept, a broken layout put back from one), and save
 * on shutdown (a SIGTERM or SIGHUP runs the pending saves before the
 * process ends). A temp state folder only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  MAX_SNAPSHOTS,
  MIN_GAP_MS,
  listLayoutSnapshots,
  snapshotLayout,
} from "../../src/shared/layout-snapshots.js";
import { cmdLayout } from "../../src/ui/cli/layout-command.js";

const ROOT = path.join(__dirname, "../..");
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const stateDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-786-layout-"));
  tmps.push(d);
  return d;
};
const T0 = Date.UTC(2026, 10, 22, 8, 0);
const at = (min: number) => new Date(T0 + min * 60_000);
const layout = (n: number) => ({ pins: [{ item: `repo-${n}` }] });

describe("layout snapshots", () => {
  it("at most one every 15 minutes, and none for an unchanged layout", () => {
    const d = stateDir();
    expect(snapshotLayout(d, layout(1), at(0))).not.toBeNull();
    expect(snapshotLayout(d, layout(2), at(14))).toBeNull();
    expect(snapshotLayout(d, layout(1), at(30))).toBeNull();
    expect(snapshotLayout(d, layout(2), at(15))).not.toBeNull();
    expect(listLayoutSnapshots(d).map((s) => s.shell)).toEqual([
      layout(2),
      layout(1),
    ]);
    expect(MIN_GAP_MS).toBe(15 * 60_000);
  });

  it(`keeps the newest ${MAX_SNAPSHOTS}`, () => {
    const d = stateDir();
    for (let i = 0; i < MAX_SNAPSHOTS + 5; i++)
      snapshotLayout(d, layout(i), at(i * 15));
    const all = listLayoutSnapshots(d);
    expect(all).toHaveLength(MAX_SNAPSHOTS);
    expect(all[0].shell).toEqual(layout(MAX_SNAPSHOTS + 4));
    expect(all.at(-1)?.shell).toEqual(layout(5));
  });

  it("a broken layout is put back from a snapshot, and the restore can be undone", () => {
    const d = stateDir();
    snapshotLayout(d, layout(1), at(0));
    let shell: unknown = { pins: [], hidden: ["agents", "logs", "tests"] };
    const out: string[] = [];
    const deps = {
      stateDir: () => d,
      readShell: () => shell,
      writeShell: (s: unknown) => (shell = s),
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
      now: () => at(5),
      cli: () => "den",
    };
    expect(cmdLayout(["restore"], deps)).toBe(0);
    expect(shell).toEqual(layout(1));
    // The broken one was kept first, though it is under 15 minutes later.
    const kept = listLayoutSnapshots(d);
    expect(kept[0].shell).toEqual({
      pins: [],
      hidden: ["agents", "logs", "tests"],
    });
    expect(cmdLayout(["restore", kept[0].id], deps)).toBe(0);
    expect(shell).toEqual({ pins: [], hidden: ["agents", "logs", "tests"] });
    expect(cmdLayout(["restore", "2020-01-01T00-00-00-000Z"], deps)).toBe(1);
  });
});

describe("save on shutdown", () => {
  /** A child that registers a save, then ends the way the web server does. */
  const child = (dir: string, signal: string) => `
import { installExitFlush, onShutdownFlush } from ${JSON.stringify(
    path.join(ROOT, "src/shared/state-flush.ts"),
  )};
import fs from "node:fs";
installExitFlush();
onShutdownFlush("probe", () =>
  fs.writeFileSync(${JSON.stringify(path.join(dir, "flushed"))}, "yes"),
);
process.on(${JSON.stringify(signal)}, () => process.exit(0));
process.kill(process.pid, ${JSON.stringify(signal)});
setTimeout(() => {}, 10_000);
`;

  it.each(["SIGTERM", "SIGHUP"])("%s runs the pending saves", (signal) => {
    const d = stateDir();
    const f = path.join(d, "child.mts");
    fs.writeFileSync(f, child(d, signal));
    const r = spawnSync(process.execPath, ["--import", "tsx", f], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(d, "flushed"), "utf8")).toBe("yes");
  });

  it("the web server shuts down on SIGHUP and flushes on exit", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src/ui/server/index.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /process\.on\("SIGHUP", \(\) => \{\s*beginShutdown\("SIGHUP"\);/,
    );
    expect(src).toMatch(/installExitFlush\(\);/);
    expect(src).toMatch(/onShutdownFlush\("layout-snapshot"/);
  });
});
