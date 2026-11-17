/**
 * Issue 380: the one shared atomic write (src/shared/atomic-write.ts). It
 * leaves no temp file behind, keeps an existing file's mode, sets the mode
 * asked for exactly, creates exclusively when asked, and cleans up when the
 * rename fails. A temp folder only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeFileAtomic } from "../../src/shared/atomic-write.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-atomic-"));
  tmps.push(d);
  return d;
};
const modeOf = (f: string) => fs.statSync(f).mode & 0o777;

describe("writeFileAtomic", () => {
  it("writes the body, makes the folder, and leaves no temp file", () => {
    const d = tmp();
    const f = path.join(d, "a", "b", "state.json");
    for (let i = 0; i < 20; i++) writeFileAtomic(f, `{"n":${i}}\n`);
    expect(fs.readFileSync(f, "utf-8")).toBe('{"n":19}\n');
    expect(fs.readdirSync(path.dirname(f))).toEqual(["state.json"]);
  });

  it("keeps the mode of the file it replaces", () => {
    const d = tmp();
    const f = path.join(d, "user.yml");
    fs.writeFileSync(f, "old\n");
    fs.chmodSync(f, 0o640);
    writeFileAtomic(f, "new\n");
    expect(fs.readFileSync(f, "utf-8")).toBe("new\n");
    expect(modeOf(f)).toBe(0o640);
    fs.chmodSync(f, 0o600);
    writeFileAtomic(f, Buffer.from("bytes\n"));
    expect(modeOf(f)).toBe(0o600);
    expect(fs.readdirSync(d)).toEqual(["user.yml"]);
  });

  it("sets the mode asked for exactly, over an older looser file", () => {
    const d = tmp();
    const f = path.join(d, "secret");
    fs.writeFileSync(f, "old\n");
    fs.chmodSync(f, 0o644);
    writeFileAtomic(f, "new\n", { mode: 0o600 });
    expect(modeOf(f)).toBe(0o600);
    expect(fs.readdirSync(d)).toEqual(["secret"]);
  });

  it("a new file without a mode gets the usual default", () => {
    const d = tmp();
    const plain = path.join(d, "plain");
    fs.writeFileSync(plain, "x");
    const f = path.join(d, "fresh");
    writeFileAtomic(f, "x");
    expect(modeOf(f)).toBe(modeOf(plain));
  });

  it("exclusive: creates once, then fails with EEXIST and leaves no temp file", () => {
    const d = tmp();
    const f = path.join(d, "slot.json");
    writeFileAtomic(f, "first", { exclusive: true, mode: 0o600 });
    expect(() => writeFileAtomic(f, "second", { exclusive: true })).toThrow(
      expect.objectContaining({ code: "EEXIST" }) as unknown as Error,
    );
    expect(fs.readFileSync(f, "utf-8")).toBe("first");
    expect(modeOf(f)).toBe(0o600);
    expect(fs.readdirSync(d)).toEqual(["slot.json"]);
  });

  it("a failed rename removes the temp file and throws", () => {
    const d = tmp();
    const f = path.join(d, "taken");
    fs.mkdirSync(path.join(f, "inner"), { recursive: true });
    expect(() => writeFileAtomic(f, "x")).toThrow();
    expect(fs.readdirSync(d)).toEqual(["taken"]);
  });
});
