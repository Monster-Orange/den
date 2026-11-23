/**
 * Issue 121: the sudo store's folder in the temp dir.
 *  - Made fresh with a name nobody can guess (mkdtemp), never one already
 *    there at a known name; checked before anything is written in it: a
 *    real folder (not a link), this user's, 0700.
 *  - Stale ones (their process gone) are swept at start: this user's only,
 *    never a link, never a live process's.
 *  - Made only in a temp folder nobody else can swap things in: this
 *    user's, or root's and sticky or written by root only; else the next.
 * Each test has its own TMPDIR. Invented content only: no real password.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  clearSudoShims,
  getSudoEnv,
  privateDirProblem,
  setSudoPassword,
  tempParentProblem,
  sweepStaleSudoDirs,
} from "../../../src/ui/server/sudo-store.js";
import { product } from "../../../src/shared/product.js";

const PW = "not-a-real-password";
let tmp: string;
const was = process.env.TMPDIR;
const prefix = () => `${product().cli}-sudo-`;
const shimDirs = () =>
  fs.readdirSync(tmp).filter((n) => n.startsWith(prefix()));
/** A process id that is surely gone: a child that already exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid as number;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-121-")));
  process.env.TMPDIR = tmp;
});
afterEach(() => {
  clearSudoShims();
  if (was === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = was;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the sudo store's folder", () => {
  it("is made fresh, not at the old known name, and is this user's, 0700, not a link", () => {
    // Something already at the old known name: a link to a folder elsewhere.
    const elsewhere = fs.mkdtempSync(path.join(tmp, "elsewhere-"));
    fs.symlinkSync(elsewhere, path.join(tmp, `${prefix()}${process.pid}`));
    setSudoPassword(PW);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    const dir = (getSudoEnv().PATH ?? "").split(":")[0];
    expect(dir.startsWith(path.join(tmp, prefix()))).toBe(true);
    expect(dir).not.toBe(path.join(tmp, `${prefix()}${process.pid}`));
    const st = fs.lstatSync(dir);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect(st.uid).toBe(process.getuid?.());
    expect(fs.existsSync(path.join(dir, "sudo"))).toBe(true);
  });

  it("the no-password shim's folder is made the same way", () => {
    fs.mkdirSync(path.join(tmp, `${prefix()}${process.pid}-ask`), {
      mode: 0o777,
    });
    fs.chmodSync(path.join(tmp, `${prefix()}${process.pid}-ask`), 0o777);
    const dir = (getSudoEnv().PATH ?? "").split(":")[0];
    expect(dir.startsWith(path.join(tmp, prefix()))).toBe(true);
    expect(dir).not.toBe(path.join(tmp, `${prefix()}${process.pid}-ask`));
    expect(fs.lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it("names what is wrong with a folder before anything is written in it", () => {
    const ok = fs.mkdtempSync(path.join(tmp, "ok-"));
    expect(privateDirProblem(ok)).toBeNull();
    const open = fs.mkdtempSync(path.join(tmp, "open-"));
    fs.chmodSync(open, 0o755);
    expect(privateDirProblem(open)).toMatch(/0700/);
    const link = path.join(tmp, "link");
    fs.symlinkSync(ok, link);
    expect(privateDirProblem(link)).toMatch(/link/);
    expect(privateDirProblem(ok, (process.getuid?.() ?? 0) + 1)).toMatch(
      /someone else/,
    );
    expect(privateDirProblem(path.join(tmp, "none"))).toMatch(/missing/);
  });
});

describe("the sweep at start", () => {
  it("removes this user's folders whose process is gone, old names and new", () => {
    const dead = deadPid();
    const oldName = path.join(tmp, `${prefix()}${dead}`);
    const oldAsk = path.join(tmp, `${prefix()}${dead}-ask`);
    fs.mkdirSync(oldName, { mode: 0o700 });
    fs.mkdirSync(oldAsk, { mode: 0o700 });
    fs.writeFileSync(path.join(oldName, "pw"), "x\n");
    const fresh = fs.mkdtempSync(path.join(tmp, prefix()));
    fs.writeFileSync(path.join(fresh, "pid"), `${dead}\n`);
    sweepStaleSudoDirs();
    expect(shimDirs()).toEqual([]);
  });

  it("keeps a live process's folder, and never follows or removes a link", () => {
    const live = fs.mkdtempSync(path.join(tmp, prefix()));
    fs.writeFileSync(path.join(live, "pid"), `${process.ppid}\n`);
    const liveOld = path.join(tmp, `${prefix()}${process.ppid}`);
    fs.mkdirSync(liveOld, { mode: 0o700 });
    const target = fs.mkdtempSync(path.join(tmp, "target-"));
    fs.writeFileSync(path.join(target, "keep"), "x\n");
    const link = path.join(tmp, `${prefix()}${deadPid()}`);
    fs.symlinkSync(target, link);
    sweepStaleSudoDirs();
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(liveOld)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(target)).toEqual(["keep"]);
  });
});

describe("the temp folder it is made in", () => {
  // Another user, never root (uid 0).
  const other = (process.getuid?.() ?? 0) + 1;

  it("is one nobody else can rename things in", () => {
    // A folder's owner can always rename what is in it, sticky or not: OK
    // only when it is this user's, or root's and sticky or owner-written.
    const dir = fs.mkdtempSync(path.join(tmp, "parent-"));
    fs.chmodSync(dir, 0o777);
    expect(tempParentProblem(dir)).toBeNull(); // this user's own
    // Seen as another (non-root) user: the folder is someone else's.
    expect(tempParentProblem(dir, other)).toMatch(/someone else/);
    fs.chmodSync(dir, 0o1777);
    expect(tempParentProblem(dir, other)).toMatch(/someone else/);
    fs.chmodSync(dir, 0o755);
    expect(tempParentProblem(dir, other)).toMatch(/someone else/);
    // Root's: sticky (/tmp) or only root writes (/) passes.
    expect(tempParentProblem("/tmp", other)).toBeNull();
    expect(tempParentProblem("/", other)).toBeNull();
    expect(tempParentProblem(path.join(tmp, "none"))).toMatch(/missing/);
  });

  it("when TMPDIR can't be used, the folder is made in a safe one instead", () => {
    process.env.TMPDIR = path.join(tmp, "none");
    setSudoPassword(PW);
    const dir = (getSudoEnv().PATH ?? "").split(":")[0];
    expect(dir.startsWith(path.join(tmp, "none"))).toBe(false);
    expect(tempParentProblem(path.dirname(dir))).toBeNull();
    expect(privateDirProblem(dir)).toBeNull();
  });
});
