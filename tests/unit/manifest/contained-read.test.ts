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
  gitTop,
  isWithin,
  readWithin,
  rootRefusal,
} from "../../../src/shared/manifest/contained-read.js";

/** Run git in `cwd`; true when it succeeds. */
const git = (cwd: string, args: string[]): boolean =>
  spawnSync("git", args, { cwd, encoding: "utf-8" }).status === 0;

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
  it("a configured folder that isn't a git checkout can be a root", () => {
    const home = tempDir();
    const plain = path.join(home, "work", "plain");
    fs.mkdirSync(plain, { recursive: true });
    expect(rootRefusal(plain, { home })).toBe(null);
  });

  it("a repo root passes", () => {
    const home = tempDir();
    const repo = path.join(home, "work", "shop");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    expect(rootRefusal(repo, { home })).toBe(null);
  });

  it("a far too broad root is refused even when it holds a .git", () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, ".git"));
    expect(rootRefusal(home, { home })).toMatch(/home folder/);
  });

  it("a home folder kept in git stays refused; a folder in it may be a root", () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, ".git"));
    fs.mkdirSync(path.join(home, "work", "plain"), { recursive: true });
    expect(rootRefusal(home, { home })).not.toBe(null);
    expect(rootRefusal(path.join(home, "work", "plain"), { home })).toBe(null);
  });
});

describe("gitTop", () => {
  /** A folder at home/work/<name>, made. */
  function folder(home: string, name: string): string {
    const dir = path.join(home, "work", name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("a .git that is an empty file is no checkout", () => {
    const home = tempDir();
    const root = folder(home, "shop");
    fs.writeFileSync(path.join(root, ".git"), "");
    expect(gitTop(root, { home })).toBe(null);
  });

  it("a .git file naming a folder that isn't there is no checkout", () => {
    const home = tempDir();
    const root = folder(home, "shop");
    fs.writeFileSync(
      path.join(root, ".git"),
      `gitdir: ${path.join(home, "gone", ".git", "worktrees", "shop")}\n`,
    );
    expect(gitTop(root, { home })).toBe(null);
  });

  it("a .git file naming an ordinary folder is no checkout", () => {
    const home = tempDir();
    const root = folder(home, "shop");
    const plain = folder(home, "plain");
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${plain}\n`);
    expect(gitTop(root, { home })).toBe(null);
  });

  it("a .git file naming a folder with only a HEAD file is no checkout", () => {
    const home = tempDir();
    const root = folder(home, "shop");
    const half = folder(home, "half");
    fs.writeFileSync(path.join(half, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${half}\n`);
    expect(gitTop(root, { home })).toBe(null);
  });

  it("a .git file naming a git folder in a far too broad place is no checkout of its own", () => {
    const home = tempDir();
    const root = folder(home, "shop");
    // A home folder kept in git, with a worktree's git folder in it.
    const common = path.join(home, ".git");
    fs.mkdirSync(path.join(common, "objects"), { recursive: true });
    fs.writeFileSync(path.join(common, "HEAD"), "ref: refs/heads/main\n");
    const admin = path.join(common, "worktrees", "shop");
    fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/shop\n");
    fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${admin}\n`);
    expect(gitTop(root, { home })).not.toBe(root);
  });

  it("a real repo is its own checkout", () => {
    const home = tempDir();
    const repo = folder(home, "repo");
    expect(git(repo, ["init", "-q"])).toBe(true);
    expect(gitTop(repo, { home })).toBe(fs.realpathSync.native(repo));
    expect(rootRefusal(repo, { home })).toBe(null);
  });

  it("a real git worktree add checkout is its own checkout", () => {
    const home = tempDir();
    const main = folder(home, "main");
    expect(git(main, ["init", "-q"])).toBe(true);
    expect(
      git(main, [
        "-c",
        "user.email=a@example.com",
        "-c",
        "user.name=a",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      ]),
    ).toBe(true);
    const wt = path.join(home, "work", "wt");
    expect(git(main, ["worktree", "add", "-q", wt, "-b", "wt"])).toBe(true);
    expect(gitTop(wt, { home })).toBe(fs.realpathSync.native(wt));
    // A relative gitdir, as git can write it, works too.
    const line = fs.readFileSync(path.join(wt, ".git"), "utf-8");
    const admin = line.replace(/^gitdir:\s*/, "").trim();
    fs.writeFileSync(
      path.join(wt, ".git"),
      `gitdir: ${path.relative(wt, admin)}\n`,
    );
    expect(gitTop(wt, { home })).toBe(fs.realpathSync.native(wt));
  });

  it("a folder inside a repo is in that repo's checkout", () => {
    const home = tempDir();
    const mono = folder(home, "mono");
    fs.mkdirSync(path.join(mono, ".git"));
    fs.mkdirSync(path.join(mono, "apps", "web"), { recursive: true });
    expect(gitTop(path.join(mono, "apps", "web"), { home })).toBe(
      fs.realpathSync.native(mono),
    );
    expect(rootRefusal(path.join(mono, "apps", "web"), { home })).toBe(null);
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
