/**
 * Issue 728: installs that share an OS user list their state folders in a
 * registry, so an agent of one install is denied the others' credential
 * files and keys. Each install's server registers itself at start; the
 * entry stays while the folder does (its keys outlive a stop).
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  listOtherInstalls,
  registerInstall,
  registryDir,
} from "../../../src/shared/install-registry.js";
import { edgeKeyDirs } from "../../../src/shared/edge/key-dirs.js";
import { product } from "../../../src/shared/product.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inst-reg-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A state folder as an install leaves it: 0700, with a web.secret. */
function stateDir(name: string): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { mode: 0o700 });
  fs.chmodSync(d, 0o700);
  fs.writeFileSync(path.join(d, "web.secret"), "x", { mode: 0o600 });
  return d;
}

/** An edge key folder: an existing directory of this user. */
function keyDir(rel: string): string {
  const d = path.join(tmp, rel);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("issue 728: the install registry", () => {
  it("one folder per OS user, the same for every distribution (beside the gate slots)", () => {
    const home = "/home/someone";
    expect(registryDir({ HOME: home })).toBe(
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "den", "installs")
        : path.join(home, ".local", "state", "den", "installs"),
    );
    if (process.platform !== "darwin")
      expect(registryDir({ HOME: home, XDG_STATE_HOME: "/xs" })).toBe(
        "/xs/den/installs",
      );
    expect(registryDir({ HOME: home, DEN_INSTALLS_DIR: "/r" })).toBe("/r");
    // No distribution's CLI name in it.
    expect(registryDir({ HOME: home })).not.toContain(`/.${product().cli}`);
  });

  it("lists the other installs, with their edge key folders, never this one", () => {
    const reg = path.join(tmp, "reg");
    const mine = stateDir("mine");
    const other = stateDir("other");
    registerInstall(reg, { stateDir: mine, edgeKeyDirs: [] });
    const ca = keyDir("edge/ca");
    registerInstall(reg, { stateDir: other, edgeKeyDirs: [ca] });
    expect(listOtherInstalls(reg, { ownStateDir: mine })).toEqual([
      { stateDir: other, edgeKeyDirs: [ca] },
    ]);
    expect(fs.statSync(reg).mode & 0o777).toBe(0o700);
    for (const f of fs.readdirSync(reg))
      expect(fs.statSync(path.join(reg, f)).mode & 0o777).toBe(0o600);
  });

  it("registering again replaces the entry (one per state folder)", () => {
    const reg = path.join(tmp, "reg");
    const other = stateDir("other");
    registerInstall(reg, { stateDir: other, edgeKeyDirs: [keyDir("a/ca")] });
    registerInstall(reg, { stateDir: other, edgeKeyDirs: [keyDir("b/ca")] });
    expect(fs.readdirSync(reg)).toHaveLength(1);
    expect(
      listOtherInstalls(reg, { ownStateDir: stateDir("mine") })[0].edgeKeyDirs,
    ).toEqual([path.join(tmp, "b", "ca")]);
  });

  it("an install that stopped stays listed; one whose folder is gone does not", () => {
    const reg = path.join(tmp, "reg");
    const kept = stateDir("kept");
    const gone = stateDir("gone");
    registerInstall(reg, { stateDir: kept, edgeKeyDirs: [] });
    registerInstall(reg, { stateDir: gone, edgeKeyDirs: [] });
    fs.rmSync(gone, { recursive: true });
    expect(
      listOtherInstalls(reg, { ownStateDir: stateDir("mine") }).map(
        (i) => i.stateDir,
      ),
    ).toEqual([kept]);
  });

  it("skips entries that fail a check: wrong mode, a link, not a state folder, bad JSON", () => {
    const reg = path.join(tmp, "reg");
    const mine = stateDir("mine");
    registerInstall(reg, { stateDir: stateDir("good"), edgeKeyDirs: [] });
    const write = (n: string, body: string, mode = 0o600) =>
      fs.writeFileSync(path.join(reg, n), body, { mode });
    write("loose.json", JSON.stringify({ stateDir: stateDir("loose") }), 0o644);
    fs.chmodSync(path.join(reg, "loose.json"), 0o644);
    write("plain.json", JSON.stringify({ stateDir: tmp }));
    write("rel.json", JSON.stringify({ stateDir: "relative/dir" }));
    write("bad.json", "{not json");
    fs.symlinkSync(
      path.join(reg, fs.readdirSync(reg).find((n) => n.length === 21)!),
      path.join(reg, "link.json"),
    );
    expect(
      listOtherInstalls(reg, { ownStateDir: mine }).map((i) =>
        path.basename(i.stateDir),
      ),
    ).toEqual(["good"]);
  });

  it("a path that could break a permission rule is refused, so an entry can't void the deny list", () => {
    const reg = path.join(tmp, "reg");
    fs.mkdirSync(reg, { mode: 0o700 });
    const mine = stateDir("mine");
    for (const bad of ["x) Bash(*", "star*", "nl\nx", 'q"x']) {
      const d = stateDir(`bad-${Math.random().toString(36).slice(2)}`);
      const odd = path.join(tmp, bad);
      fs.renameSync(d, odd);
      expect(() =>
        registerInstall(reg, { stateDir: odd, edgeKeyDirs: [] }),
      ).toThrow(/path/);
      fs.writeFileSync(
        path.join(reg, `${Math.random().toString(36).slice(2)}.json`),
        JSON.stringify({ stateDir: odd, edgeKeyDirs: [] }),
        { mode: 0o600 },
      );
    }
    const ok = stateDir("ok");
    fs.writeFileSync(
      path.join(reg, "edge.json"),
      JSON.stringify({ stateDir: ok, edgeKeyDirs: ["/e/ca)", "rel/ca"] }),
      { mode: 0o600 },
    );
    expect(listOtherInstalls(reg, { ownStateDir: mine })).toEqual([
      { stateDir: ok, edgeKeyDirs: [] },
    ]);
  });

  it("an unsafe edge folder is dropped, and the install is still registered", () => {
    const reg = path.join(tmp, "reg");
    const other = stateDir("other");
    const ca = keyDir("edge/ca");
    const r = registerInstall(reg, {
      stateDir: other,
      edgeKeyDirs: [path.join(tmp, "share", "*", "edge", "ca"), ca],
    });
    expect(r.dropped).toEqual([path.join(tmp, "share", "*", "edge", "ca")]);
    expect(listOtherInstalls(reg, { ownStateDir: stateDir("mine") })).toEqual([
      { stateDir: other, edgeKeyDirs: [ca] },
    ]);
  });

  it("an install whose edge config is broken is still registered (its state folder)", () => {
    const reg = path.join(tmp, "reg");
    const other = stateDir("other");
    const root = path.join(tmp, "root");
    fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", "den.yml"),
      "edge:\n  org: acme\n  domain: acme.localhost\n  aliases: not-a-list\n",
    );
    const keys = edgeKeyDirs(root);
    expect(keys.some((k) => k.includes("*"))).toBe(true);
    registerInstall(reg, { stateDir: other, edgeKeyDirs: keys });
    expect(
      listOtherInstalls(reg, { ownStateDir: stateDir("mine") }).map(
        (i) => i.stateDir,
      ),
    ).toEqual([other]);
  });

  it("an edge folder given through a symlink is stored by its real path, so readers keep it", () => {
    const reg = path.join(tmp, "reg");
    const other = stateDir("other");
    const ca = keyDir("real-edge/ca");
    const link = path.join(tmp, "linked-edge");
    fs.symlinkSync(path.dirname(ca), link);
    registerInstall(reg, {
      stateDir: other,
      edgeKeyDirs: [path.join(link, "ca")],
    });
    expect(listOtherInstalls(reg, { ownStateDir: stateDir("mine") })).toEqual([
      { stateDir: other, edgeKeyDirs: [ca] },
    ]);
  });

  it("glob characters are unsafe too: ? [ ] { }", () => {
    const reg = path.join(tmp, "reg");
    for (const c of ["?", "[", "]", "{", "}"]) {
      const d = stateDir(`g${Math.random().toString(36).slice(2)}`);
      const odd = path.join(tmp, `a${c}b`);
      fs.renameSync(d, odd);
      expect(() =>
        registerInstall(reg, { stateDir: odd, edgeKeyDirs: [] }),
      ).toThrow(/path/);
      fs.rmSync(odd, { recursive: true });
    }
  });

  it("another entry's key folder can't over-deny: not /, not home or its parents, not our own folders, only a real directory of this user", () => {
    const reg = path.join(tmp, "reg");
    fs.mkdirSync(reg, { mode: 0o700 });
    const home = keyDir("home/someone");
    const mine = path.join(home, ".acme");
    fs.mkdirSync(mine, { mode: 0o700 });
    const dist = keyDir("home/someone/projects/den");
    const other = stateDir("other");
    const ca = keyDir("other-edge/ca");
    const file = path.join(tmp, "a-file");
    fs.writeFileSync(file, "x");
    fs.symlinkSync(ca, path.join(tmp, "ca-link"));
    fs.writeFileSync(
      path.join(reg, "poisoned.json"),
      JSON.stringify({
        stateDir: other,
        edgeKeyDirs: [
          "/",
          home,
          path.dirname(home),
          mine,
          path.join(home, "projects"),
          dist,
          file,
          path.join(tmp, "missing"),
          path.join(tmp, "ca-link"),
          ca,
        ],
      }),
      { mode: 0o600 },
    );
    expect(
      listOtherInstalls(reg, { ownStateDir: mine, home, protect: [dist] }),
    ).toEqual([{ stateDir: other, edgeKeyDirs: [ca] }]);
  });

  it("no registry yet: none, and no throw", () => {
    expect(
      listOtherInstalls(path.join(tmp, "none"), { ownStateDir: tmp }),
    ).toEqual([]);
  });
});
