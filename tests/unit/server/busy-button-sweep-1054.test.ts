/**
 * Issue 1054: every button that sends a request shows it is working on the
 * button itself: the kit's held button (dots in place of its label,
 * disabled, the same width, aria-busy="true"), with no Working pop-up for
 * one request.
 *
 * A write goes one of three ways, and this sweep reads every Den page
 * script (*.js and *.html under public/) and fails on a write that takes
 * none of them:
 *
 *   1. through denShell.busyAction with a button (its run passes the
 *      kit's `{ headers }`; busy-dots-sweep.test.ts checks the button);
 *   2. after denShell.holdDots(button) (or holdRow(row), a row that waits),
 *      within the same handler (HOLD_SPAN lines before the write), which
 *      gives it back on the answer;
 *   3. with a reason no button waits for it, in a comment at most three
 *      lines above the write: `// busy-ok: <why>` (a switch that saves on
 *      change, a drag, a background write). An empty or short reason does
 *      not count.
 *
 * The pages with no shell (busy-writes-ratchet.test.ts's NO_SHELL) have no
 * kit there and are left out.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { busyCalls } from "./busy-dots-sweep.test.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const NO_SHELL = new Set(["embed-page.js"]);

const WRITE =
  /api\??\.?\(\s*"(?:POST|PUT|PATCH|DELETE)"|method:\s*"(?:POST|PUT|PATCH|DELETE)"/g;
const BUSY_HEADERS = /\{\s*headers\s*,?\s*\}/;
/** How far above a write its handler's holdDots(button) may be. */
const HOLD_SPAN = 40;
const REASON = /busy-ok:\s*(\S.{9,})/;

/** Each write in `src` that shows no wait on a button: "line: text". */
export function unheldWrites(src: string): string[] {
  const lines = src.split("\n");
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  const out: string[] = [];
  for (const m of src.matchAll(WRITE)) {
    const call = src.slice(m.index!, m.index! + 300).split(";")[0]!;
    if (BUSY_HEADERS.test(call)) continue;
    const n = lineAt(m.index!);
    const near = lines.slice(Math.max(0, n - 4), n).join("\n");
    if (REASON.test(near)) continue;
    const above = lines.slice(Math.max(0, n - HOLD_SPAN), n).join("\n");
    if (/hold(Dots|Row)(\?\.)?\(/.test(above)) continue;
    out.push(`${n}: ${lines[n - 1]!.trim().slice(0, 90)}`);
  }
  return out;
}

describe("issue 1054: every write shows its wait on its button", () => {
  it("finds a bare write, and passes one held, one through the kit, one with a reason", () => {
    expect(
      unheldWrites('b.onclick = () => api("POST", "/api/x", {});'),
    ).toEqual(['1: b.onclick = () => api("POST", "/api/x", {});']);
    expect(
      unheldWrites(
        'const release = denShell.holdDots(b);\nawait api("POST", "/api/x", {});\nrelease();',
      ),
    ).toEqual([]);
    expect(
      unheldWrites(
        'busyAction("save", (headers) => api("POST", "/x", {}, { headers }), { button: b });',
      ),
    ).toEqual([]);
    expect(
      unheldWrites(
        '// busy-ok: a switch saves on change; its own state is the answer\napi("POST", "/x", {});',
      ),
    ).toEqual([]);
    // The optional-call form counts too.
    expect(
      unheldWrites(
        'const release = window.denShell?.holdDots?.(btn) ?? (async () => {});\napi("POST", "/x", {});',
      ),
    ).toEqual([]);
    // A write through an optional call is a write too.
    expect(
      unheldWrites('await window.denShell?.api?.("POST", "/api/x", {});'),
    ).toEqual(['1: await window.denShell?.api?.("POST", "/api/x", {});']);
    // A reason must say something.
    expect(unheldWrites('// busy-ok: x\napi("POST", "/x", {});')).toHaveLength(
      1,
    );
  });

  it("no Den page sends a request from a button without the kit's held state", () => {
    const bad: string[] = [];
    for (const f of fs
      .readdirSync(PUBLIC)
      .filter((x) => /\.(js|html)$/.test(x) && !NO_SHELL.has(x)))
      for (const w of unheldWrites(
        fs.readFileSync(path.join(PUBLIC, f), "utf-8"),
      ))
        bad.push(`${f}:${w}`);
    expect(bad).toEqual([]);
  });
});

// Den Builder's rulings on the writes that had no button (issue 1054).
describe("issue 1054: the waits with no button of their own", () => {
  const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");
  /** The text of `name`'s body, from its declaration to the next one. */
  const body = (src: string, start: string) => {
    const i = src.indexOf(start);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, i + 4000);
  };

  it("a drag's save holds the moved row (holdRow) and names a refusal inline, with no pop-up", () => {
    const fn = body(read("agents-page.js"), "async function moveOrder(");
    expect(fn).toMatch(/denShell\.holdRow\?\.\(row\)/);
    expect(fn).not.toMatch(/busyAction\(/);
    expect(fn).toMatch(/#ag-order-err/);
    expect(read("agents.html")).toMatch(
      /<p class="err" id="ag-order-err" role="alert" hidden><\/p>/,
    );
  });

  it("Delete project, on both pages: the last dialog's own button sends and holds, with no pop-up", () => {
    for (const [f, start] of [
      ["local-dev.html", "window.deleteWorkspace = async function (e, name)"],
      ["services.html", "window.deleteWorkspace = async function ()"],
    ] as const) {
      const fn = body(read(f), start);
      expect(fn).not.toMatch(/busyAction\(\s*"delete-project"/);
      expect(fn).toMatch(/onAnswer:/);
      expect(fn).toMatch(/onGo:/);
    }
  });

  it("the kit's dialog holds the pressed button through Den's held state", () => {
    expect(read("dialog-den.js")).toMatch(
      /hold:\s*\(b\)\s*=>\s*sh\(\)\?\.holdDots\?\.\(b\)/,
    );
  });

  it("only Restart sends with no button on screen (reconnect mode names its steps)", () => {
    const none: string[] = [];
    for (const f of fs
      .readdirSync(PUBLIC)
      .filter((x) => /\.(js|html)$/.test(x)))
      for (const c of busyCalls(read(f)))
        if (!c.button) none.push(`${f} ${c.action}`);
    expect(none).toEqual(["restart-den.js restart-den"]);
  });
});
