/**
 * Issue 1356: a test that writes a real install's config/local or state
 * folder fails at the write, naming the path and the import order to fix.
 *
 * The guard is tried on a copy of fs with invented roots under the temp
 * folder (home, the checkout, another checkout), so no real folder is
 * touched. The last case checks setup.ts installed it on the real fs: a
 * write to this checkout's own config/local throws.
 */
import { afterAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  guardedWrites,
  installWriteGuard,
  writeGuardRoots,
  type WriteGuardRoots,
} from "../../write-guard.js";

const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-1356-")),
);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Invented roots: tmp/home is "the home", tmp/scratch "the temp folder". */
function rig() {
  const home = path.join(tmp, `home-${Math.random().toString(36).slice(2)}`);
  const checkout = path.join(home, "Projects", "den");
  const other = path.join(home, "Projects", "den-other");
  const scratch = path.join(home, "..", "scratch");
  for (const d of [
    path.join(checkout, "config", "local"),
    path.join(other, "config", "local"),
    path.join(home, ".den"),
    scratch,
  ])
    fs.mkdirSync(d, { recursive: true });
  const roots: WriteGuardRoots = { checkout, temp: [scratch] };
  const f = { ...fs, promises: { ...fs.promises } } as typeof fs;
  const refused: string[] = [];
  installWriteGuard(f, roots, (p) => void refused.push(p));
  return { f, home, checkout, other, scratch, refused };
}

describe("the write guard (issue 1356)", () => {
  it("refuses another checkout's config/local, naming the path and the import order", () => {
    const r = rig();
    const file = path.join(r.other, "config", "local", "user.yml");
    expect(() => r.f.writeFileSync(file, "agents: {}\n")).toThrow(
      /wrote outside its temp folders: .*den-other\/config\/local\/user\.yml/,
    );
    expect(() => r.f.writeFileSync(file, "x")).toThrow(
      /Set DEN_ROOT \(or DEN_HOME\) first, then import the module dynamically/,
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(r.refused).toEqual([file, file]);
  });

  it("refuses the checkout's own config/local, the home's state folders and anything else under the home", () => {
    const r = rig();
    for (const p of [
      path.join(r.checkout, "config", "local", "user.yml"),
      path.join(r.home, ".den", "web.secret"),
      path.join(
        r.home,
        "Library",
        "Application Support",
        "den",
        "installs",
        "x.json",
      ),
    ])
      expect(() => r.f.writeFileSync(p, "x")).toThrow(
        /outside its temp folders/,
      );
    expect(() => r.f.mkdirSync(path.join(r.home, ".den", "agents"))).toThrow(
      /outside its temp folders/,
    );
    expect(() =>
      r.f.rmSync(path.join(r.home, ".den"), { recursive: true }),
    ).toThrow(/outside its temp folders/);
    expect(fs.existsSync(path.join(r.home, ".den"))).toBe(true);
  });

  it("an atomic write's rename into a guarded folder is refused too, and the promise forms reject", async () => {
    const r = rig();
    const src = path.join(r.scratch, "u.yml.tmp");
    fs.writeFileSync(src, "x");
    expect(() =>
      r.f.renameSync(src, path.join(r.other, "config", "local", "user.yml")),
    ).toThrow(/outside its temp folders/);
    await expect(
      r.f.promises.writeFile(path.join(r.home, ".den", "x"), "x"),
    ).rejects.toThrow(/outside its temp folders/);
  });

  it("lets through the temp folder and the checkout outside its config/local", async () => {
    const r = rig();
    r.f.writeFileSync(path.join(r.scratch, "a"), "x");
    r.f.mkdirSync(path.join(r.checkout, "coverage"), { recursive: true });
    r.f.writeFileSync(path.join(r.checkout, "coverage", "lcov.info"), "x");
    await r.f.promises.writeFile(path.join(r.scratch, "b"), "x");
    r.f.renameSync(path.join(r.scratch, "a"), path.join(r.scratch, "c"));
    expect(r.refused).toEqual([]);
  });

  it("a config/local outside the home and the temp folders is refused too", () => {
    const r = rig();
    const f = { ...fs, promises: { ...fs.promises } } as typeof fs;
    installWriteGuard(
      f,
      { home: r.home, checkout: r.checkout, temp: [] },
      () => {},
    );
    expect(() =>
      f.writeFileSync(
        path.join(r.scratch, "x", "config", "local", "user.yml"),
        "x",
      ),
    ).toThrow(/outside its temp folders/);
  });
});

describe("the write guard is an allow-list (issue 1356)", () => {
  it("refuses a state folder outside the home: another user's, a shared folder, another volume", () => {
    const r = rig();
    for (const p of [
      "/Users/Shared/x",
      "/Users/someone-else/.den/web.secret",
      "/Volumes/x/.den/state.json",
      "/Library/LaunchDaemons/x.plist",
      "/opt/den/state/x",
    ])
      expect(() => r.f.writeFileSync(p, "x")).toThrow(
        /outside its temp folders/,
      );
    expect(r.refused).toHaveLength(5);
  });

  it("lets /dev/null through, and a root a suite names", () => {
    const r = rig();
    r.f.writeFileSync("/dev/null", "x");
    const extra = path.join(tmp, "named-root");
    fs.mkdirSync(extra, { recursive: true });
    const f = { ...fs, promises: { ...fs.promises } } as typeof fs;
    const refused: string[] = [];
    installWriteGuard(
      f,
      { checkout: r.checkout, temp: [], allow: [extra] },
      (p) => void refused.push(p),
    );
    f.writeFileSync(path.join(extra, "a"), "x");
    expect(() => f.writeFileSync(path.join(r.home, "a"), "x")).toThrow(
      /outside its temp folders/,
    );
    expect(refused).toEqual([path.join(r.home, "a")]);
    expect(r.refused).toEqual([]);
  });

  it("reads a file: URL as its path, escapes and all", () => {
    const r = rig();
    const p = path.join(r.other, "config", "local", "my file.yml");
    expect(() => r.f.writeFileSync(pathToFileURL(p), "x")).toThrow(
      /config\/local\/my file\.yml/,
    );
  });
});

describe("one refusal list per worker (issue 1356)", () => {
  it("a later test file's load of the guard sees a refusal made through the first load's wrappers", () => {
    const f = { ...fs, promises: { ...fs.promises } } as typeof fs;
    const r = rig();
    type M = typeof import("../../write-guard.js");
    let first: M | undefined;
    let second: M | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      first = require("../../write-guard") as M;
    });
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      second = require("../../write-guard") as M;
    });
    expect(first).not.toBe(second);
    const roots = { checkout: r.checkout, temp: [r.scratch] };
    first!.installWriteGuard(f, roots);
    second!.installWriteGuard(f, roots); // already guarded: a no-op
    const start = second!.guardedWrites().length;
    const file = path.join(r.home, ".den", "swallowed");
    try {
      f.writeFileSync(file, "x");
    } catch {
      /* a writer that swallows the error */
    }
    expect(second!.guardedWrites().slice(start)).toEqual([file]);
    second!.guardedWrites().splice(start);
  });
});

describe("setup.ts (issue 1356)", () => {
  it("installs the guard on the real fs: a write to this checkout's config/local throws", () => {
    const roots = writeGuardRoots();
    const probe = path.join(
      roots.checkout,
      "config",
      "local",
      "zz-1356-probe.yml",
    );
    try {
      expect(() => fs.writeFileSync(probe, "x")).toThrow(
        /outside its temp folders/,
      );
    } finally {
      // Red (no guard): the probe landed; take it away so nothing stays.
      try {
        fs.rmSync(probe, { force: true });
      } catch {
        /* the guard refuses the rm too, and then nothing was written */
      }
    }
    // This test's own refusals don't fail the file.
    guardedWrites().splice(0);
  });

  it("pins DEN_ROOT to the checkout when node_modules resolves into another one", () => {
    const roots = writeGuardRoots();
    const nm = fs.realpathSync(path.join(roots.checkout, "node_modules"));
    if (!nm.startsWith(fs.realpathSync(roots.checkout) + path.sep))
      expect(process.env.DEN_ROOT).toBe(roots.checkout);
  });
});
