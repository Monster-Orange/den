/**
 * Issue 1086: "Remove all stopped (N)" on the stopped agents list's own
 * header (the Stopped group's summary), in place of the page header's
 * Clear stopped (AG-14.1b). It counts and removes stopped agents only,
 * never a running one and never a shell (exited shells are on Terminals).
 * One confirm names the count; its Remove sends and holds the kit's busy
 * state on itself until the server answers (issue 1054); then a toast
 * says how many, with Undo as a single Remove has. Shown only when one is
 * stopped. en, es and ja.
 *
 * The page's behaviour runs on CI (agents-ag14.browser.test.ts); this
 * reads the page script, so it fails where the code no longer says so.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.join(process.cwd(), "src/ui/server/public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");
const PAGE = read("agents-page.js");

/** A top-level function's text, from its declaration to the next. */
function fn(src: string, start: string): string {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThan(-1);
  const rest = src.slice(i + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return src.slice(i, end < 0 ? undefined : i + 1 + end);
}

/** The catalog's text of `key` in a language's file. */
function word(f: string, key: string): string | undefined {
  const m = read(f).match(
    new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]*)"`),
  );
  return m?.[1];
}

describe("issue 1086: Remove all stopped (N), on the stopped list's own header", () => {
  it("the page header's Clear stopped is gone", () => {
    expect(read("agents.html")).not.toMatch(/id="ag-clear"/);
    expect(PAGE).not.toMatch(/#ag-clear|function clearStopped\(/);
  });

  it("the Stopped group's summary has it, small, counting stopped agents only, shown only when one is stopped", () => {
    const g = fn(PAGE, "function stoppedGroupHtml(");
    expect(g).toMatch(/\.filter\(isStopped\)/);
    expect(g).toMatch(
      /<button type="button" class="den-btn sm" data-act="remove-stopped" data-n="\$\{agents\}">/,
    );
    expect(g).toMatch(/t\("ag\.rmAll",\s*\{\s*n/);
    // None stopped (only exited shells): no button.
    expect(g).toMatch(/agents\s*\?/);
  });

  it("one confirm names the count; its own Remove sends and holds (no Working pop-up), agents only", () => {
    const f = fn(PAGE, "async function removeAllStopped(");
    expect(f).toMatch(/askConfirm\(/);
    expect(f).toMatch(/danger:\s*true/);
    expect(f).toMatch(/onAnswer:/);
    expect(f).toMatch(/"\/api\/agents\/clear-stopped"/);
    // Exactly the agents the confirm named (Reviewer: one that stopped
    // since the page looked is not removed with them).
    expect(f).toMatch(/\{\s*workspaces,\s*agents\s*\}/);
    expect(f).toMatch(/\.filter\(isStopped\)/);
    // Never a shell, never the pop-up.
    expect(f).not.toMatch(/\/api\/sessions\//);
    expect(f).not.toMatch(/busyAction\(/);
    // Its toast says how many; Undo, as a single Remove has.
    expect(f).toMatch(/removedToast\(/);
  });

  it("the list's click sends remove-stopped there, and the summary does not toggle", () => {
    expect(PAGE).toMatch(
      /which === "remove-stopped"\)\s*\{\s*e\.preventDefault\(\);\s*return void removeAllStopped\(act\);/,
    );
  });

  it("its words, with the count, in en, es and ja", () => {
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
      for (const k of ["ag.rmAll", "ag.rmAll.t", "ag.rmAll.m", "ag.rmAll.ok"]) {
        const w = word(f, k);
        expect([f, k, typeof w]).toEqual([f, k, "string"]);
        if (k !== "ag.rmAll.m")
          expect([f, k, w]).toEqual([f, k, expect.stringContaining("{n}")]);
      }
    expect(word("shell.js", "ag.rmAll")).toBe("Remove all stopped ({n})");
  });
});
