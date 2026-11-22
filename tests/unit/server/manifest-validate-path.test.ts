/**
 * Issue 583: GET /api/manifest/validate?path=… (validateAtPath). Every file
 * it opens passes the same containment check as the requested path: the
 * repo's own manifest inside that repo, a held manifest or override inside
 * the held manifests folder. A configured repo root that is far too broad
 * is never a root.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { validateAtPath } from "../../../src/ui/server/manifest-validate-path.js";

const GOOD =
  "name: shop\nservices:\n  web:\n    urls:\n      local: https://shop.example.com\n";

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-validate-path-")),
  );
  tmpDirs.push(dir);
  return dir;
}

let held: string;
let repo: string;
let outside: string;
let home: string;

beforeEach(() => {
  held = tempDir();
  process.env.DEN_MANIFESTS_DIR = held;
  home = tempDir();
  // A checkout with no origin: the held lookup falls back to the folder name.
  repo = path.join(tempDir(), "shop");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  outside = tempDir();
  fs.writeFileSync(path.join(outside, "elsewhere.yml"), GOOD);
});

afterEach(() => {
  delete process.env.DEN_MANIFESTS_DIR;
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const deps = () => ({
  repoRoots: [repo],
  heldDir: held,
  home,
  stateDir: path.join(home, ".den"),
});

/** The one answer for a manifest that can't be read, whatever the cause. */
const UNREADABLE = "The manifest couldn't be read.";

const messages = (b: Body) => [
  ...new Set((b.errors ?? []).map((e) => e.message)),
];

/** A git config naming `url` as the origin. */
const originConfig = (url: string) =>
  `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n`;

type Body = {
  valid?: boolean;
  code?: string;
  errors?: { message: string; file?: string }[];
};

describe("validateAtPath", () => {
  it("validates a repo's own manifest", () => {
    fs.writeFileSync(path.join(repo, ".den.yml"), GOOD);
    const r = validateAtPath(repo, deps());
    expect(r.status).toBe(200);
    expect((r.body as Body).valid).toBe(true);
  });

  it("refuses a path outside every repo", () => {
    const r = validateAtPath(path.join(outside, "elsewhere.yml"), deps());
    expect(r.status).toBe(403);
    expect((r.body as Body).code).toBe("outside_repos");
  });

  it("clause 1: never reads a repo manifest that links outside the repo", () => {
    fs.symlinkSync(
      path.join(outside, "elsewhere.yml"),
      path.join(repo, ".den.yml"),
    );
    const body = validateAtPath(repo, deps()).body as Body;
    expect(body.valid).toBe(false);
    expect(messages(body)).toEqual([UNREADABLE]);
  });

  it("clause 1: never reads a held manifest that links outside the held folder", () => {
    fs.symlinkSync(
      path.join(outside, "elsewhere.yml"),
      path.join(held, "shop.den.yml"),
    );
    const body = validateAtPath(repo, deps()).body as Body;
    expect(body.valid).toBe(false);
    expect(messages(body)).toEqual([UNREADABLE]);
  });

  it("clause 1: never reads an override that links outside the held folder", () => {
    fs.writeFileSync(path.join(repo, ".den.yml"), GOOD);
    fs.writeFileSync(
      path.join(outside, "over.yml"),
      "services:\n  web:\n    urls:\n      local: https://other.example.com\n",
    );
    fs.symlinkSync(
      path.join(outside, "over.yml"),
      path.join(held, "shop.override.yml"),
    );
    const body = validateAtPath(repo, deps()).body as Body;
    expect(body.valid).toBe(false);
    expect(messages(body)).toEqual([UNREADABLE]);
  });

  it("still reads held manifests and overrides inside the held folder", () => {
    fs.writeFileSync(path.join(held, "shop.den.yml"), GOOD);
    const body = validateAtPath(repo, deps()).body as Body & {
      manifestLayers?: string[];
    };
    expect(body.valid).toBe(true);
    expect(body.manifestLayers).toEqual(["held"]);
  });

  it("clause 3: a repo root that is the home folder is not a root", () => {
    fs.writeFileSync(path.join(home, "notes.yml"), GOOD);
    const r = validateAtPath(path.join(home, "notes.yml"), {
      ...deps(),
      repoRoots: [home],
    });
    expect(r.status).toBe(403);
  });

  it("clause 3: a repo root that is the whole disk is not a root", () => {
    const r = validateAtPath(path.join(outside, "elsewhere.yml"), {
      ...deps(),
      repoRoots: [path.parse(outside).root],
    });
    expect(r.status).toBe(403);
  });

  it("a root that isn't a repo is refused", () => {
    const plain = path.join(tempDir(), "plain");
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, ".den.yml"), GOOD);
    const r = validateAtPath(plain, { ...deps(), repoRoots: [plain] });
    expect(r.status).toBe(403);
  });

  it("every read failure says the same", () => {
    // A manifest that links outside, one whose link leads nowhere, and one
    // that can't be opened: the same whole reply for all three.
    const linked = path.join(tempDir(), "shop");
    fs.mkdirSync(path.join(linked, ".git"), { recursive: true });
    fs.symlinkSync(
      path.join(outside, "elsewhere.yml"),
      path.join(linked, ".den.yml"),
    );
    const dangling = path.join(tempDir(), "shop");
    fs.mkdirSync(path.join(dangling, ".git"), { recursive: true });
    fs.symlinkSync(
      path.join(outside, "none.yml"),
      path.join(dangling, ".den.yml"),
    );
    const closed = path.join(tempDir(), "shop");
    fs.mkdirSync(path.join(closed, ".git"), { recursive: true });
    fs.writeFileSync(path.join(closed, ".den.yml"), GOOD);
    fs.chmodSync(path.join(closed, ".den.yml"), 0o000);
    const roots = [linked, dangling, closed];
    // Each reply with its own repo's folder written the same way.
    const answers = roots.map((r) =>
      JSON.stringify(validateAtPath(r, { ...deps(), repoRoots: roots }).body)
        .split(r)
        .join("<repo>"),
    );
    fs.chmodSync(path.join(closed, ".den.yml"), 0o600);
    expect(answers[0]).toContain(UNREADABLE);
    expect(answers[1]).toBe(answers[0]);
    if (process.getuid?.() !== 0) expect(answers[2]).toBe(answers[0]);
  });

  it("a root whose .git is an empty file is refused", () => {
    const root = path.join(tempDir(), "shop");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, ".git"), "");
    fs.writeFileSync(path.join(root, ".den.yml"), GOOD);
    const r = validateAtPath(root, { ...deps(), repoRoots: [root] });
    expect(r.status).toBe(403);
  });

  it("a configured monorepo subfolder validates", () => {
    const mono = path.join(tempDir(), "mono");
    const web = path.join(mono, "apps", "web");
    fs.mkdirSync(path.join(mono, ".git"), { recursive: true });
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(web, ".den.yml"), GOOD);
    const r = validateAtPath(web, { ...deps(), repoRoots: [web] });
    expect(r.status).toBe(200);
    expect((r.body as Body).valid).toBe(true);
  });

  it("a home folder kept in git is still no root, nor a broad folder in it", () => {
    fs.mkdirSync(path.join(home, ".git"));
    const library = path.join(home, "Library");
    fs.mkdirSync(library);
    fs.writeFileSync(path.join(library, ".den.yml"), GOOD);
    for (const root of [home, library]) {
      const r = validateAtPath(root, { ...deps(), repoRoots: [root] });
      expect(r.status).toBe(403);
    }
  });

  it("a folder's manifest may link to another folder of the same repo", () => {
    fs.mkdirSync(path.join(repo, "shared"));
    fs.mkdirSync(path.join(repo, "sub"));
    fs.writeFileSync(path.join(repo, "shared", ".den.yml"), GOOD);
    fs.symlinkSync("../shared/.den.yml", path.join(repo, "sub", ".den.yml"));
    const body = validateAtPath(path.join(repo, "sub"), deps()).body as Body;
    expect(body.valid).toBe(true);
  });

  it("a checkout's origin names its held manifest", () => {
    fs.writeFileSync(
      path.join(repo, ".git", "config"),
      originConfig("https://example.com/acme/store.git"),
    );
    fs.writeFileSync(path.join(held, "store.den.yml"), GOOD);
    const body = validateAtPath(repo, deps()).body as Body & {
      manifestLayers?: string[];
    };
    expect(body.manifestLayers).toEqual(["held"]);
  });

  /** A linked worktree of `main` at `wt` (as git lays one out). */
  function worktree(main: string, wt: string) {
    const admin = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(admin, { recursive: true });
    // A git folder as git lays one out: HEAD and objects in the main one,
    // HEAD and commondir in the worktree's.
    fs.mkdirSync(path.join(main, ".git", "objects"));
    fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/wt\n");
    fs.writeFileSync(
      path.join(main, ".git", "config"),
      originConfig("https://example.com/acme/store.git"),
    );
    fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
    fs.writeFileSync(path.join(admin, "gitdir"), path.join(wt, ".git") + "\n");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${admin}\n`);
    fs.writeFileSync(path.join(held, "store.den.yml"), GOOD);
  }

  it("a worktree whose main repo is configured uses its origin", () => {
    const main = path.join(tempDir(), "main");
    fs.mkdirSync(main);
    const wt = path.join(tempDir(), "shop");
    fs.mkdirSync(wt);
    worktree(main, wt);
    const body = validateAtPath(wt, {
      ...deps(),
      repoRoots: [wt, main],
    }).body as Body & { manifestLayers?: string[] };
    expect(body.manifestLayers).toEqual(["held"]);
  });

  it("a real git worktree add checkout validates with its origin", () => {
    const main = path.join(tempDir(), "main");
    fs.mkdirSync(main);
    const run = (args: string[]) =>
      spawnSync("git", args, { cwd: main, encoding: "utf-8" }).status;
    expect(run(["init", "-q"])).toBe(0);
    expect(
      run(["remote", "add", "origin", "https://example.com/acme/store.git"]),
    ).toBe(0);
    expect(
      run([
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
    ).toBe(0);
    const wt = path.join(tempDir(), "shop");
    expect(run(["worktree", "add", "-q", wt, "-b", "wt"])).toBe(0);
    fs.writeFileSync(path.join(held, "store.den.yml"), GOOD);
    const r = validateAtPath(wt, { ...deps(), repoRoots: [wt, main] });
    expect(r.status).toBe(200);
    expect(
      (r.body as Body & { manifestLayers?: string[] }).manifestLayers,
    ).toEqual(["held"]);
  });

  it("a root whose .git file names an ordinary folder is refused", () => {
    const root = path.join(tempDir(), "shop");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${outside}\n`);
    fs.writeFileSync(path.join(root, ".den.yml"), GOOD);
    const r = validateAtPath(root, { ...deps(), repoRoots: [root] });
    expect(r.status).toBe(403);
  });

  it("a worktree whose main repo isn't configured falls back to the folder name", () => {
    const main = path.join(tempDir(), "main");
    fs.mkdirSync(main);
    const wt = path.join(tempDir(), "shop");
    fs.mkdirSync(wt);
    worktree(main, wt);
    fs.writeFileSync(
      path.join(held, "shop.den.yml"),
      GOOD.replace("name: shop", "name: by-folder"),
    );
    const body = validateAtPath(wt, { ...deps(), repoRoots: [wt] })
      .body as Body & { layers?: { file: string | null }[] };
    expect(body.layers?.[0]?.file).toBe(path.join(held, "shop.den.yml"));
  });

  it("the origin lookup never looks above the checkout the root is in", () => {
    // The root is a folder in a checkout with no origin; a checkout above
    // that one has an origin, which is not this repo's.
    const above = tempDir();
    fs.mkdirSync(path.join(above, ".git"));
    fs.writeFileSync(
      path.join(above, ".git", "config"),
      originConfig("https://example.com/acme/store.git"),
    );
    const mono = path.join(above, "mono");
    fs.mkdirSync(path.join(mono, ".git"), { recursive: true });
    const root = path.join(mono, "shop");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(held, "store.den.yml"), GOOD);
    fs.writeFileSync(path.join(held, "shop.den.yml"), GOOD);
    const body = validateAtPath(root, { ...deps(), repoRoots: [root] })
      .body as Body & { layers?: { file: string | null }[] };
    expect(body.layers?.[0]?.file).toBe(path.join(held, "shop.den.yml"));
  });
});
