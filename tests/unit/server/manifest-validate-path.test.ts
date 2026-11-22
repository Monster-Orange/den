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
  // Not a git checkout: the held lookup falls back to the folder name.
  repo = path.join(tempDir(), "shop");
  fs.mkdirSync(repo);
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
    expect(JSON.stringify(body.errors)).toMatch(/outside/);
  });

  it("clause 1: never reads a held manifest that links outside the held folder", () => {
    fs.symlinkSync(
      path.join(outside, "elsewhere.yml"),
      path.join(held, "shop.den.yml"),
    );
    const body = validateAtPath(repo, deps()).body as Body;
    expect(body.valid).toBe(false);
    expect(JSON.stringify(body.errors)).toMatch(/outside/);
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
    expect(JSON.stringify(body.errors)).toMatch(/outside/);
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
});
