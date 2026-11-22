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
import {
  broadRootReason,
  readWithin,
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
});
