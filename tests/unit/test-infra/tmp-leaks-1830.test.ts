import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import tmpLeaks from "../../tmp-leaks.cjs";

const base = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "lane-1830-")),
);
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("issue 1830: a run's den-* temp folders, by the test file that made them", () => {
  it("only a den-* folder right inside a temp folder counts", () => {
    const roots = [base];
    expect(tmpLeaks.isTempDen(path.join(base, "den-abc"), roots)).toBe(true);
    expect(tmpLeaks.isTempDen(path.join(base, "other-abc"), roots)).toBe(false);
    expect(tmpLeaks.isTempDen(path.join(base, "x", "den-abc"), roots)).toBe(
      false,
    );
  });

  it("the list names what is still there by file; setup's own folders apart; gone ones not at all", () => {
    const run = fs.mkdtempSync(path.join(base, "run-"));
    const kept = fs.mkdtempSync(path.join(base, "den-kept-"));
    const own = fs.mkdtempSync(path.join(base, "den-test-"));
    const list = path.join(run, "tmp-made-1.log");
    tmpLeaks.record(list, kept, "tests/a.test.ts");
    tmpLeaks.record(list, path.join(base, "den-gone"), "tests/b.test.ts");
    tmpLeaks.record(list, own, "setup");
    fs.writeFileSync(path.join(run, "other.log"), `${kept}\ttests/c.test.ts\n`);
    expect(tmpLeaks.leaksIn(run)).toEqual({
      leaks: [{ file: "tests/a.test.ts", dirs: [kept] }],
      own: [own],
    });
  });

  it("each mkdtemp form puts its den-* folder on the list with the current test file, and nothing else", async () => {
    const run = fs.mkdtempSync(path.join(base, "run-"));
    const stubs = path.join(run, "no-vendor-cli");
    const fake = {
      ...fs,
      mkdtempSync: fs.mkdtempSync,
      mkdtemp: fs.mkdtemp,
      promises: { ...fs.promises },
      [Symbol.for("den.tmpLeaks")]: false,
    } as typeof fs;
    const env = { DEN_TEST_GLOBAL_STUBS: stubs, TMPDIR: base };
    tmpLeaks.armTmpLeaks(fake, env);
    tmpLeaks.setTestFile("tests/x.test.ts", fake);
    const a = fake.mkdtempSync(path.join(base, "den-a-"));
    const b = await new Promise<string>((r, j) =>
      fake.mkdtemp(path.join(base, "den-b-"), (e, d) => (e ? j(e) : r(d))),
    );
    const c = await fake.promises.mkdtemp(path.join(base, "den-c-"));
    fake.mkdtempSync(path.join(base, "plain-"));
    const list = tmpLeaks.listFile(env);
    expect(list).toBe(path.join(run, `tmp-made-${process.pid}.log`));
    expect(tmpLeaks.leaksIn(run).leaks).toEqual([
      { file: "tests/x.test.ts", dirs: [a, b, c].sort() },
    ]);
  });

  it("each remove form notes a removed den-* folder with its time; the list still names only what is left", async () => {
    const run = fs.mkdtempSync(path.join(base, "run-"));
    const env = {
      DEN_TEST_GLOBAL_STUBS: path.join(run, "no-vendor-cli"),
      TMPDIR: base,
    };
    const fake = {
      ...fs,
      promises: { ...fs.promises },
      [Symbol.for("den.tmpLeaks")]: false,
    } as typeof fs;
    tmpLeaks.armTmpLeaks(fake, env);
    tmpLeaks.setTestFile("tests/y.test.ts", fake);
    const before = Date.now();
    const made = ["a", "b", "c", "d"].map((n) =>
      fake.mkdtempSync(path.join(base, `den-rm-${n}-`)),
    );
    fake.rmSync(made[0], { recursive: true, force: true });
    await new Promise<void>((r, j) =>
      fake.rm(made[1], { recursive: true }, (e) => (e ? j(e) : r())),
    );
    await fake.promises.rm(made[2], { recursive: true });
    fake.rmdirSync(made[3]);
    const kept = fake.mkdtempSync(path.join(base, "den-rm-kept-"));
    const h = tmpLeaks.historyIn(run);
    for (const d of made) {
      expect(h.get(d)?.made).toEqual([
        { owner: "tests/y.test.ts", at: expect.any(Number) },
      ]);
      expect(h.get(d)?.removed).toEqual([
        { owner: "tests/y.test.ts", at: expect.any(Number) },
      ]);
      expect(h.get(d)!.removed[0].at).toBeGreaterThanOrEqual(before);
    }
    expect(h.get(kept)?.removed).toEqual([]);
    expect(tmpLeaks.leaksIn(run).leaks).toEqual([
      { file: "tests/y.test.ts", dirs: [kept] },
    ]);
  });

  it("a leak's report: when it was made and removed, then its files by path and time, newest first, never their contents", () => {
    const run = fs.mkdtempSync(path.join(base, "run-"));
    const list = path.join(run, "tmp-made-2.log");
    const back = fs.mkdtempSync(path.join(base, "den-back-"));
    const never = fs.mkdtempSync(path.join(base, "den-never-"));
    tmpLeaks.record(list, back, "tests/z.test.ts", fs, "made", 1000);
    tmpLeaks.record(list, back, "tests/z.test.ts", fs, "removed", 2000);
    tmpLeaks.record(list, never, "tests/z.test.ts", fs, "made", 1000);
    fs.mkdirSync(path.join(back, "home", ".den"), { recursive: true });
    const older = path.join(back, "home", ".den", "web-boots.json");
    const newer = path.join(back, "home", ".den", "web-sessions.json");
    fs.writeFileSync(older, "SECRET-OLDER");
    fs.writeFileSync(newer, "SECRET-NEWER");
    fs.utimesSync(older, new Date(3000), new Date(3000));
    fs.utimesSync(newer, new Date(4000), new Date(4000));
    const h = tmpLeaks.historyIn(run);
    const lines = tmpLeaks.describeLeak(back, h);
    expect(lines).toEqual([
      "made 1970-01-01T00:00:01.000Z (tests/z.test.ts); removed 1970-01-01T00:00:02.000Z (tests/z.test.ts): made again after its remove",
      "1970-01-01T00:00:04.000Z  home/.den/web-sessions.json",
      "1970-01-01T00:00:03.000Z  home/.den/web-boots.json",
    ]);
    expect(lines.join("\n")).not.toContain("SECRET");
    expect(tmpLeaks.describeLeak(never, h)).toEqual([
      "made 1970-01-01T00:00:01.000Z (tests/z.test.ts); no fs remove of it was seen",
    ]);
  });

  it("a leak's file list stops at its limit and says how many more", () => {
    const dir = fs.mkdtempSync(path.join(base, "den-many-"));
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}`), "");
    const lines = tmpLeaks.describeLeak(dir, new Map(), fs, 3);
    expect(lines[0]).toBe("no record of it being made");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("(2 more)");
  });

  it("a file over its baseline count fails; one not listed may leave none; one under is reported", () => {
    const leak = (file: string, n: number) => ({
      file,
      dirs: Array.from({ length: n }, (_, i) => `/t/den-${i}`),
    });
    const { over, under } = tmpLeaks.judge(
      [leak("a.test.ts", 3), leak("b.test.ts", 1), leak("c.test.ts", 1)],
      { "a.test.ts": 2, "c.test.ts": 4 },
    );
    expect(
      over.map((o: { file: string; allowed: number }) => [o.file, o.allowed]),
    ).toEqual([
      ["a.test.ts", 2],
      ["b.test.ts", 0],
    ]);
    expect(under).toEqual([{ file: "c.test.ts", allowed: 4, now: 1 }]);
  });

  it("the baseline names test files that exist, with positive counts, in order", () => {
    const root = path.join(__dirname, "../../..");
    const baseline = JSON.parse(
      fs.readFileSync(
        path.join(root, "tests/fixtures/tmp-leak-baseline.json"),
        "utf-8",
      ),
    ) as Record<string, number>;
    const files = Object.keys(baseline);
    expect(files).toEqual([...files].sort());
    expect(files.filter((f) => !fs.existsSync(path.join(root, f)))).toEqual([]);
    expect(
      Object.values(baseline).filter((n) => !Number.isInteger(n) || n < 1),
    ).toEqual([]);
  });

  it("with no global setup there is no list, and recording is a no-op", () => {
    expect(tmpLeaks.listFile({})).toBeNull();
    expect(() => tmpLeaks.record(null, base, "x")).not.toThrow();
  });
});
