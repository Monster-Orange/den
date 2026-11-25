/**
 * The write guard and symlinks. An op that acts on a link itself (unlink,
 * rm, rmdir, rename, symlink, link, lchown, lutimes) judges the link's
 * own path: its folder resolved, its last name kept. Every other op
 * follows the link, so a write through it is judged where it lands.
 *
 * A fixture's PATH mirror holds links to real programs; on Node 22 its
 * afterAll rmSync unlinked each through the guarded fs.unlinkSync, and the
 * guard read that as writing the program (Node 24's rmSync runs natively,
 * so CI on 24 never saw it). These tests call the guard directly, so they
 * fail on the old guard on any Node.
 *
 * A guarded copy of fs with invented roots under the temp folder; no real
 * folder outside it is touched.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  installWriteGuard,
  refusedWrite,
  type WriteGuardRoots,
} from "../../write-guard.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-wgl-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** scratch: the guarded temp folder; outside: a folder it may not write. */
function rig() {
  const base = path.join(tmp, Math.random().toString(36).slice(2));
  const checkout = path.join(base, "checkout");
  const scratch = path.join(base, "scratch");
  const outside = path.join(base, "outside");
  for (const d of [checkout, scratch, outside])
    fs.mkdirSync(d, { recursive: true });
  const target = path.join(outside, "cpio");
  fs.writeFileSync(target, "a program\n");
  const link = path.join(scratch, "cpio");
  fs.symlinkSync(target, link);
  const roots: WriteGuardRoots = { checkout, temp: [scratch] };
  const f = { ...fs, promises: { ...fs.promises } } as typeof fs;
  const refused: string[] = [];
  installWriteGuard(f, roots, (p) => void refused.push(p));
  return { f, roots, scratch, outside, target, link, refused };
}

describe("the write guard and links", () => {
  it("(a) a link in a temp folder that points outside it can be unlinked", () => {
    const r = rig();
    expect(refusedWrite(r.link, r.roots, "unlinkSync")).toBe(false);
    r.f.unlinkSync(r.link);
    expect(fs.existsSync(r.link)).toBe(false);
    expect(fs.readFileSync(r.target, "utf8")).toBe("a program\n");
    expect(r.refused).toEqual([]);
  });

  it("rm, rename and the promise unlink act on the link too", async () => {
    const r = rig();
    r.f.rmSync(r.link, { force: true });
    expect(fs.existsSync(r.link)).toBe(false);
    fs.symlinkSync(r.target, r.link);
    const moved = path.join(r.scratch, "moved");
    r.f.renameSync(r.link, moved);
    expect(fs.lstatSync(moved).isSymbolicLink()).toBe(true);
    await r.f.promises.unlink(moved);
    expect(fs.existsSync(moved)).toBe(false);
    expect(fs.readFileSync(r.target, "utf8")).toBe("a program\n");
    expect(r.refused).toEqual([]);
  });

  it("(b) a write through that link is still refused, and nothing lands", () => {
    const r = rig();
    expect(refusedWrite(r.link, r.roots, "writeFileSync")).toBe(true);
    expect(refusedWrite(r.link, r.roots)).toBe(true);
    expect(() => r.f.writeFileSync(r.link, "changed\n")).toThrow(
      /wrote outside its temp folders/,
    );
    expect(() => r.f.appendFileSync(r.link, "more\n")).toThrow();
    expect(() => r.f.chmodSync(r.link, 0o600)).toThrow();
    expect(fs.readFileSync(r.target, "utf8")).toBe("a program\n");
    expect(r.refused.length).toBeGreaterThan(0);
  });

  it("a link's own path outside the temp folders stays refused", () => {
    const r = rig();
    const there = path.join(r.outside, "link-there");
    fs.symlinkSync(path.join(r.scratch, "x"), there);
    expect(refusedWrite(there, r.roots, "unlinkSync")).toBe(true);
    expect(() => r.f.unlinkSync(there)).toThrow(/wrote outside/);
    expect(fs.lstatSync(there).isSymbolicLink()).toBe(true);
  });

  it("a folder reached through a linked parent is judged where it really is", () => {
    const r = rig();
    const viaLink = path.join(r.scratch, "out");
    fs.symlinkSync(r.outside, viaLink);
    expect(
      refusedWrite(path.join(viaLink, "cpio"), r.roots, "unlinkSync"),
    ).toBe(true);
  });
});
