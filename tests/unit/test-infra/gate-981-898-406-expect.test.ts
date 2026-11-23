/**
 * Issues 981, 898 and 406: their live checks (gate/981.mjs, gate/898.mjs,
 * gate/406.mjs) can fail. Each check's expect() is fed cells with the
 * measures the bug gave (red) and the measures the fix gives (green), in a
 * child node (the gate files are ESM), as the bed's harness calls it:
 * expect(cells) with one argument.
 */
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
    // Not digits-dash-digits: the bed masks that shape as a pairing code.
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
  const row = (fixed: boolean) => ({
    tag: "webkit-820x1180",
    text: "a-project-whose-name-is-far-too-long-for-the-menu-row",
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

  it("before the fix (the row two lines, the mark absolute): the clause fails", () => {
    expect(rows(898, [cell("webkit", [row(false)])])[0].ok).toBe(false);
  });

  it("with the fix: the clause passes, and says how long the label was against the row", () => {
    const [r] = rows(898, [cell("webkit", [row(true)])]);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("label 420px of a 300px row");
  });
});

describe("issue 406's live check", () => {
  const line = (cls: string, text: string, fontSize: number, top: number) => ({
    cls,
    text,
    top,
    height: fontSize * 1.3,
    fontSize,
    lineHeight: fontSize * 1.4,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });

  it("before the fix (one line while a name is known): the two-line clause fails", () => {
    const r = rows(406, [
      cell("webkit", {
        tag: "webkit-1280",
        name: "Pat Example",
        login: "pexample",
        entry: [line("den-acct-l", "@pexample", 13, 800)],
      }),
    ]);
    expect(r[0].ok).toBe(false);
  });

  it("a second line no smaller than the first fails the look clause", () => {
    const r = rows(406, [
      cell("webkit", {
        tag: "webkit-1280",
        name: "Pat Example",
        login: "pexample",
        entry: [
          line("den-acct-n", "Pat Example", 13, 790),
          line("den-acct-l", "@pexample", 13, 808),
        ],
      }),
    ]);
    expect(r[1].ok).toBe(false);
  });

  it("with the fix: name over @login, the second smaller: both pass", () => {
    const r = rows(406, [
      cell("chromium", {
        tag: "chromium-1280",
        name: "Pat Example",
        login: "pexample",
        entry: [
          line("den-acct-n", "Pat Example", 13, 790),
          line("den-acct-l", "@pexample", 11, 808),
        ],
      }),
    ]);
    expect(r.map((x) => x.ok)).toEqual([true, true]);
  });

  it("no name anywhere: the two-line clause is not run (needs-person-name), never failed", () => {
    const r = rows(406, [
      cell("webkit", {
        tag: "webkit-1280",
        name: null,
        login: "pexample",
        entry: [line("den-acct-l", "@pexample", 11, 800)],
      }),
    ]);
    expect(r[0]).toMatchObject({ ok: null, skip: "needs-person-name" });
    expect(r[1].ok).toBe(true);
  });
});
