import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function rows(issue: number, cells: unknown[]): Row[] {
  const js = `
    const g = await import("./gate/${issue}.mjs");
    process.stdout.write(JSON.stringify(await g.expect(${JSON.stringify(cells)})));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as Row[];
}

const cell = (browser: string, result: unknown) => ({
  cell: { browser, width: 1280 },
  result,
});

describe("issue 981's live check", () => {
  const bar = (fixed: boolean) => ({
    tag: "webkit-820x1180",
    pill: { left: 300, right: fixed ? 440 : 520, top: 8, bottom: 40 },
    search: { left: fixed ? 452 : 410, right: 700 },
    atPill: fixed,
    coarse: true,
    menu: fixed,
    searchOpen: !fixed,
  });

  it("before the fix (Search over the picker, a tap opens Search): both clauses fail", () => {
    const r = rows(981, [cell("webkit", [bar(false)])]);
    expect(r.map((x) => x.ok)).toEqual([false, false]);
  });

  it("with the fix: both clauses pass", () => {
    const r = rows(981, [cell("webkit", [bar(true)])]);
    expect(r.map((x) => x.ok)).toEqual([true, true]);
    expect(r[0].detail).toContain("picker x 300 to 440, Search from x 452");
    expect(r[0].detail).not.toMatch(/\d+-\d+/);
  });

  it("a cell that couldn't measure fails, never passes", () => {
    const r = rows(981, [
      cell("webkit", [{ tag: "webkit-768x1024", error: "timeout" }]),
    ]);
    expect(r.map((x) => x.ok)).toEqual([false, false]);
  });
});

describe("issue 898's live check", () => {
  const LONG =
    "GATE 898 WWW MMM WWW MMM WWW MMM WWW MMM WWW MMM WWW MMM WWW MMM";
  const row = (fixed: boolean, text = LONG) => ({
    tag: "webkit-820x1180",
    text,
    want: LONG,
    origW: 420,
    origCut: true,
    fills: 0,
    cut: fixed,
    clipped: fixed,
    ellipsis: fixed,
    nowrap: fixed,
    rowH: fixed ? 44 : 64,
    padY: 20,
    line: 18,
    parts: fixed ? [18] : [36],
    labelRight: fixed ? 380 : 400,
    rowRight: 400,
    labelW: 420,
    rowW: 300,
    mark: '"✓"',
    markPos: fixed ? "static" : "absolute",
    coarse: true,
  });

  it("before the fix (the long name wraps to two lines, the mark absolute): both clauses fail", () => {
    const r = rows(898, [cell("webkit", [row(false)])]);
    expect(r.map((x) => x.ok)).toEqual([false, false]);
  });

  it("with the fix: both pass, and the detail says the long label was cut short", () => {
    const r = rows(898, [cell("webkit", [row(true)])]);
    expect(r.map((x) => x.ok)).toEqual([true, true]);
    expect(r[1].detail).toContain(
      "label 420px of a 300px row; cut short; overflow hidden; ellipsis; nowrap",
    );
  });

  it("a short checked row proves the line but not the cut: the long-name clause fails", () => {
    const r = rows(898, [
      cell("webkit", [{ ...row(true, "All active (8)"), cut: false }]),
    ]);
    expect(r.map((x) => x.ok)).toEqual([true, false]);
  });

  it("the bed's name fits the row (as ed96400d's run found): the FAIL says the name was never cut", () => {
    const r = rows(898, [cell("webkit", [{ ...row(true), cut: false }])]);
    expect(r.map((x) => x.ok)).toEqual([true, false]);
    expect(r[1].detail).toMatch(/^even filled, the name was never cut\. /);
  });

  it("the name fits a wide row, so the page fills it past the row: the cut is judged on that, and the detail says so", () => {
    const r = rows(898, [
      cell("webkit", [
        { ...row(true), origW: 641, origCut: false, fills: 1, rowW: 679 },
      ]),
    ]);
    expect(r.map((x) => x.ok)).toEqual([true, true]);
    expect(r[1].detail).toContain(
      "(641px, fits as it is, so filled 1× in the page;",
    );
  });

  it("the label's overflow isn't hidden, so no cut can show: the long-name clause fails", () => {
    const r = rows(898, [cell("webkit", [{ ...row(true), clipped: false }])]);
    expect(r.map((x) => x.ok)).toEqual([true, false]);
    expect(r[1].detail).toMatch(/the overflow isn't hidden/);
  });

  it("the bed has no long-named project: both clauses are not run (needs-long-project), never failed", () => {
    const r = rows(898, [
      cell("webkit", [{ tag: "webkit", skip: "needs-long-project" }]),
    ]);
    expect(r.map((x) => [x.ok, x.skip])).toEqual([
      [null, "needs-long-project"],
      [null, "needs-long-project"],
    ]);
  });

  it("the checked row isn't the bed's long-named project: the long-name clause fails", () => {
    const r = rows(898, [
      cell("webkit", [{ ...row(true), text: "Another project" }]),
    ]);
    expect(r[1].ok).toBe(false);
  });

  it("the project couldn't be put in view: both clauses fail with the reason", () => {
    const r = rows(898, [
      cell("webkit", [{ tag: "webkit", error: "couldn't put it in view" }]),
    ]);
    expect(r.map((x) => x.ok)).toEqual([false, false]);
    expect(r[0].detail).toContain("couldn't put it in view");
  });
});
