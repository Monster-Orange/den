/**
 * Issue 583: GET /api/manifest/validate?path=… (validateAtPath). Every file
 * it opens passes the same containment check as the requested path: the
 * repo's own manifest inside that repo, a held manifest or override inside
 * the held manifests folder. A configured repo root that is far too broad
 * is never a root.
 */
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
    // that can't be opened: one answer for all three.
    const answers: string[][] = [];
    const linked = path.join(tempDir(), "one");
    fs.mkdirSync(path.join(linked, ".git"), { recursive: true });
    fs.symlinkSync(
      path.join(outside, "elsewhere.yml"),
      path.join(linked, ".den.yml"),
    );
    const dangling = path.join(tempDir(), "two");
    fs.mkdirSync(path.join(dangling, ".git"), { recursive: true });
    fs.symlinkSync(
      path.join(outside, "none.yml"),
      path.join(dangling, ".den.yml"),
    );
    const closed = path.join(tempDir(), "three");
    fs.mkdirSync(path.join(closed, ".git"), { recursive: true });
    fs.writeFileSync(path.join(closed, ".den.yml"), GOOD);
    fs.chmodSync(path.join(closed, ".den.yml"), 0o000);
    const roots = [linked, dangling, closed];
    for (const r of roots)
      answers.push(
        messages(
          validateAtPath(r, { ...deps(), repoRoots: roots }).body as Body,
        ),
      );
    fs.chmodSync(path.join(closed, ".den.yml"), 0o600);
    const canOpenAnything = process.getuid?.() === 0;
    expect(answers[0]).toEqual([UNREADABLE]);
    expect(answers[1]).toEqual([UNREADABLE]);
    if (!canOpenAnything) expect(answers[2]).toEqual([UNREADABLE]);
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

  it("the origin lookup never looks above the repo root", () => {
    // The root's .git names no git folder; a checkout above it has an origin.
    const above = tempDir();
    fs.mkdirSync(path.join(above, ".git"));
    fs.writeFileSync(
      path.join(above, ".git", "config"),
      originConfig("https://example.com/acme/store.git"),
    );
    const root = path.join(above, "shop");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, ".git"), "not a git pointer\n");
    fs.writeFileSync(path.join(held, "store.den.yml"), GOOD);
    fs.writeFileSync(path.join(held, "shop.den.yml"), GOOD);
    const body = validateAtPath(root, { ...deps(), repoRoots: [root] })
      .body as Body & { layers?: { file: string | null }[] };
    expect(body.layers?.[0]?.file).toBe(path.join(held, "shop.den.yml"));
  });
});
