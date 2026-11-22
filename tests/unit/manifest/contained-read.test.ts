/**
 * Issue 583: Validate's path checks. A file is read only when where it
 * really is (every symlink resolved) lies inside an allowed folder, and
 * what is read is that same resolved file; a configured repo root that is
 * far too broad (the whole disk, a top-level folder, the home folder or
 * one holding it, Den's own state folder) is refused, with the reason.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import {
  broadRootReason,
  isWithin,
  readWithin,
  rootRefusal,
} from "../../../src/shared/manifest/contained-read.js";

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-contained-")),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readWithin", () => {
  it("reads a file inside a root", () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.yml"), "name: a\n");
    expect(readWithin(path.join(root, "a.yml"), [root])).toBe("name: a\n");
  });

  it("refuses a symlink inside a root that points outside it", () => {
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "secret.yml"), "name: secret\n");
    fs.symlinkSync(
      path.join(outside, "secret.yml"),
      path.join(root, "link.yml"),
    );
    expect(() => readWithin(path.join(root, "link.yml"), [root])).toThrow(
      /outside/,
    );
  });

  it("keeps ENOENT for a missing file", () => {
    const root = tempDir();
    let code: string | undefined;
    try {
      readWithin(path.join(root, "none.yml"), [root]);
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code;
    }
    expect(code).toBe("ENOENT");
  });

  it("reads the path it checked: a file swapped for a link after the check is refused", () => {
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "secret.yml"), "name: secret\n");
    const file = path.join(root, "a.yml");
    fs.writeFileSync(file, "name: a\n");
    expect(() =>
      readWithin(file, [root], {
        afterCheck: () => {
          fs.rmSync(file);
          fs.symlinkSync(path.join(outside, "secret.yml"), file);
        },
      }),
    ).toThrow();
  });

  it("reads the path it checked: a folder swapped for a link after the check is refused", () => {
    const root = tempDir();
    const outside = tempDir();
    fs.mkdirSync(path.join(outside, "sub"));
    fs.writeFileSync(path.join(outside, "sub", "a.yml"), "name: secret\n");
    fs.mkdirSync(path.join(root, "sub"));
    const file = path.join(root, "sub", "a.yml");
    fs.writeFileSync(file, "name: a\n");
    expect(() =>
      readWithin(file, [root], {
        afterCheck: () => {
          fs.rmSync(path.join(root, "sub"), { recursive: true });
          fs.symlinkSync(path.join(outside, "sub"), path.join(root, "sub"));
        },
      }),
    ).toThrow();
  });
});

describe("readWithin: roots and odd files", () => {
  it("uses the roots as given: a root that is a link is not followed", () => {
    const real = tempDir();
    fs.writeFileSync(path.join(real, "a.yml"), "name: a\n");
    const link = path.join(tempDir(), "link");
    fs.symlinkSync(real, link);
    expect(() => readWithin(path.join(real, "a.yml"), [link])).toThrow(
      /outside/,
    );
  });

  it("a file that isn't a regular file is refused without waiting", () => {
    const root = tempDir();
    const odd = path.join(root, "odd.yml");
    expect(spawnSync("mkfifo", [odd]).status).toBe(0);
    // In a child: a read that waits would hold this process too.
    const tsx = path.resolve("node_modules/.bin/tsx");
    const mod = path.resolve("src/shared/manifest/contained-read.ts");
    const r = spawnSync(
      tsx,
      [
        "-e",
        `import { readWithin } from ${JSON.stringify(mod)};
         try { readWithin(${JSON.stringify(odd)}, [${JSON.stringify(root)}]); console.log("read"); }
         catch { console.log("refused"); }`,
      ],
      { encoding: "utf-8", timeout: 20000 },
    );
    expect(r.error).toBeUndefined();
    expect(r.stdout.trim()).toBe("refused");
  });
});

describe("isWithin", () => {
  it("a folder whose name starts with two dots is inside", () => {
    const root = tempDir();
    expect(isWithin(path.join(root, "..x"), root)).toBe(true);
    expect(isWithin(path.join(root, "..x", "a.yml"), root)).toBe(true);
    expect(isWithin(path.dirname(root), root)).toBe(false);
    expect(isWithin(path.join(path.dirname(root), "other"), root)).toBe(false);
  });
});

describe("rootRefusal", () => {
  it("a root that isn't a repo is refused", () => {
    const home = tempDir();
    const plain = path.join(home, "work", "plain");
    fs.mkdirSync(plain, { recursive: true });
    expect(rootRefusal(plain, { home })).toMatch(/not a git checkout/);
  });

  it("a repo root passes", () => {
    const home = tempDir();
    const repo = path.join(home, "work", "shop");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    expect(rootRefusal(repo, { home })).toBe(null);
  });

  it("a root whose .git is an empty file is refused", () => {
    const home = tempDir();
    const root = path.join(home, "work", "shop");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "");
    expect(rootRefusal(root, { home })).toMatch(/not a git checkout/);
  });

  it("a root whose .git file names a folder that isn't there is refused", () => {
    const home = tempDir();
    const root = path.join(home, "work", "shop");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, ".git"),
      `gitdir: ${path.join(home, "gone", ".git", "worktrees", "shop")}\n`,
    );
    expect(rootRefusal(root, { home })).toMatch(/not a git checkout/);
  });

  it("a root whose .git file names a folder in a far too broad place is refused", () => {
    const home = tempDir();
    const root = path.join(home, "work", "shop");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(home, ".git", "worktrees", "shop"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, ".git"),
      `gitdir: ${path.join(home, ".git", "worktrees", "shop")}\n`,
    );
    expect(rootRefusal(root, { home })).not.toBe(null);
  });

  it("a real worktree's .git file still works", () => {
    const home = tempDir();
    const main = path.join(home, "work", "main");
    const admin = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(admin, { recursive: true });
    const wt = path.join(home, "work", "wt");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${admin}\n`);
    expect(rootRefusal(wt, { home })).toBe(null);
    // A relative gitdir, as git can write it, works too.
    fs.writeFileSync(
      path.join(wt, ".git"),
      `gitdir: ${path.relative(wt, admin)}\n`,
    );
    expect(rootRefusal(wt, { home })).toBe(null);
  });

  it("a folder inside a repo can be a root", () => {
    const home = tempDir();
    const mono = path.join(home, "work", "mono");
    fs.mkdirSync(path.join(mono, ".git"), { recursive: true });
    fs.mkdirSync(path.join(mono, "apps", "web"), { recursive: true });
    expect(rootRefusal(path.join(mono, "apps", "web"), { home })).toBe(null);
  });

  it("a folder whose enclosing repo is the home folder is refused", () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, ".git"));
    fs.mkdirSync(path.join(home, "Library"));
    fs.mkdirSync(path.join(home, "work", "plain"), { recursive: true });
    expect(rootRefusal(path.join(home, "Library"), { home })).not.toBe(null);
    expect(rootRefusal(path.join(home, "work", "plain"), { home })).not.toBe(
      null,
    );
  });

  it("a far too broad root is refused even when it holds a .git", () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, ".git"));
    expect(rootRefusal(home, { home })).toMatch(/home folder/);
  });
});

describe("broadRootReason", () => {
  it("passes a repo folder", () => {
    const home = tempDir();
    const repo = path.join(home, "work", "shop");
    fs.mkdirSync(repo, { recursive: true });
    expect(
      broadRootReason(repo, { home, stateDir: path.join(home, ".x") }),
    ).toBe(null);
  });

  it("refuses the whole disk", () => {
    expect(broadRootReason(path.parse(process.cwd()).root)).toMatch(
      /whole disk/,
    );
  });

  it("refuses a top-level folder", () => {
    expect(
      broadRootReason(path.join(path.parse(process.cwd()).root, "opt")),
    ).toMatch(/top-level folder/);
  });

  it("refuses the home folder and a folder that holds it", () => {
    const top = tempDir();
    const home = path.join(top, "people", "me");
    fs.mkdirSync(home, { recursive: true });
    expect(broadRootReason(home, { home })).toMatch(/home folder/);
    expect(broadRootReason(path.join(top, "people"), { home })).toMatch(
      /home folder/,
    );
  });

  it("refuses a folder that holds the state folder", () => {
    const top = tempDir();
    const stateDir = path.join(top, "state");
    fs.mkdirSync(stateDir);
    expect(broadRootReason(top, { home: tempDir(), stateDir })).toMatch(
      /state folder/,
    );
  });

  const onMac = process.platform === "darwin" ? it : it.skip;

  onMac("refuses the home folder spelled in other capitals", () => {
    const home = path.join(tempDir(), "me");
    fs.mkdirSync(home);
    const other = path.join(path.dirname(home), "ME");
    expect(broadRootReason(other, { home })).toMatch(/home folder/);
  });

  onMac("refuses the home folder reached through the data volume", () => {
    const home = path.join(tempDir(), "me");
    fs.mkdirSync(home);
    const data = "/System/Volumes/Data";
    if (!fs.existsSync(path.join(data, home))) return;
    expect(broadRootReason(path.join(data, home), { home })).toMatch(
      /home folder/,
    );
  });
});
