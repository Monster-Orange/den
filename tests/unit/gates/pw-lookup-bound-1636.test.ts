import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  playwrightVersion,
  PW_DOWN_DEPTH,
  PW_DOWN_DIRS,
} from "../../../src/ui/cli/gate-command.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-pw1636-")),
  );
  tmps.push(d);
  return d;
};

/** Playwright declared and installed in `dir`, at `version`. */
function playwrightIn(dir: string, version: string): void {
  fs.mkdirSync(path.join(dir, "node_modules", "@playwright", "test"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ devDependencies: { "@playwright/test": `^${version}` } }),
  );
  fs.writeFileSync(
    path.join(dir, "node_modules", "@playwright", "test", "package.json"),
    JSON.stringify({ version }),
  );
}

function counted(cap = 200): {
  n: number;
  list: (dir: string) => fs.Dirent[];
} {
  const seen = {
    n: 0,
    list: (dir: string): fs.Dirent[] => {
      seen.n++;
      if (seen.n > cap) throw new Error("EACCES: listing refused by the test");
      return fs.readdirSync(dir, { withFileTypes: true });
    },
  };
  return seen;
}

describe("the look below the run's folder is bounded", () => {
  it("from the root folder: answers at once, and lists no folder", () => {
    const listed = counted();
    const t0 = Date.now();
    expect(playwrightVersion("/", { list: listed.list })).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(listed.n).toBe(0);
  });

  it("from the home folder, or a folder above it: never looks below", () => {
    const home = tmp();
    const app = path.join(home, "work", "app");
    fs.mkdirSync(app, { recursive: true });
    playwrightIn(app, "1.63.1");
    const listed = counted();
    const o = { home, list: listed.list };
    expect(playwrightVersion(home, o)).toBeUndefined();
    expect(playwrightVersion(path.dirname(home), o)).toBeUndefined();
    expect(listed.n).toBe(0);
    expect(playwrightVersion(path.join(home, "work"), { home })).toBe("1.63.1");
  });

  it(`at most ${PW_DOWN_DEPTH} levels down`, () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, ".git"));
    const near = path.join(repo, ...Array(PW_DOWN_DEPTH).fill("d"));
    fs.mkdirSync(near, { recursive: true });
    playwrightIn(near, "1.61.4");
    expect(playwrightVersion(repo)).toBe("1.61.4");

    const deep = tmp();
    fs.mkdirSync(path.join(deep, ".git"));
    const far = path.join(deep, ...Array(PW_DOWN_DEPTH + 1).fill("d"));
    fs.mkdirSync(far, { recursive: true });
    playwrightIn(far, "1.61.4");
    expect(playwrightVersion(deep)).toBeUndefined();
  });

  it(`lists at most ${PW_DOWN_DIRS} folders`, () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, ".git"));
    for (let i = 0; i < PW_DOWN_DIRS + 50; i++)
      fs.mkdirSync(path.join(repo, `f${String(i).padStart(5, "0")}`));
    const listed = counted(PW_DOWN_DIRS * 4);
    expect(playwrightVersion(repo, { list: listed.list })).toBeUndefined();
    expect(listed.n).toBeLessThanOrEqual(PW_DOWN_DIRS);
  });
});
