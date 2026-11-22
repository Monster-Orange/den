/**
 * Issue 583, clause 3: doctor says why a configured repo root is refused
 * (far too broad for Validate to read inside), naming its project.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { repoRootLines } from "../../../src/ui/cli/doctor-repo-roots.js";

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-doctor-roots-")),
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

describe("repoRootLines", () => {
  it("is ok when every repo root is one repo's folder", () => {
    const home = tempDir();
    const repo = path.join(home, "work", "shop");
    fs.mkdirSync(repo, { recursive: true });
    const r = repoRootLines([{ project: "north", repoPath: repo }], {
      home,
      stateDir: path.join(home, ".den"),
    });
    expect(r.check.status).toBe("ok");
    expect(r.problem).toBe(false);
  });

  it("fails on a root that is the home folder, naming project, path and why", () => {
    const home = tempDir();
    const r = repoRootLines([{ project: "north", repoPath: home }], {
      home,
      stateDir: path.join(home, ".den"),
    });
    expect(r.check.id).toBe("repo_roots");
    expect(r.check.status).toBe("fail");
    expect(r.problem).toBe(true);
    expect(r.check.detail).toContain("north");
    expect(r.check.detail).toContain(home);
    expect(r.check.detail).toMatch(/home folder/);
    expect(r.check.detail).toMatch(/Validate/);
    expect(r.lines.join("\n")).toMatch(/✗/);
  });

  it("fails on the whole disk", () => {
    const home = tempDir();
    const r = repoRootLines(
      [{ project: "north", repoPath: path.parse(home).root }],
      { home, stateDir: path.join(home, ".den") },
    );
    expect(r.check.status).toBe("fail");
    expect(r.check.detail).toMatch(/whole disk/);
  });
});
