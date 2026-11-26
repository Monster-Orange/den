import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.join(process.cwd(), "src/ui/server/public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");
const PAGE = read("agents-page.js");

function fn(src: string, start: string): string {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThan(-1);
  const rest = src.slice(i + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return src.slice(i, end < 0 ? undefined : i + 1 + end);
}

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
    expect(g).toMatch(/agents\s*\?/);
  });

  it("one confirm names the count; its own Remove sends and holds (no Working pop-up), agents only", () => {
    const f = fn(PAGE, "async function removeAllStopped(");
    expect(f).toMatch(/askConfirm\(/);
    expect(f).toMatch(/danger:\s*true/);
    expect(f).toMatch(/onAnswer:/);
    expect(f).toMatch(/"\/api\/agents\/clear-stopped"/);
    expect(f).toMatch(/\{\s*workspaces,\s*agents\s*\}/);
    expect(f).toMatch(/\.filter\(isStopped\)/);
    expect(f).not.toMatch(/\/api\/sessions\//);
    expect(f).not.toMatch(/busyAction\(/);
    expect(f).toMatch(/removedToast\(/);
  });

  it("the button is never inside the summary; the summary says only Stopped (N) and is the group's first child", () => {
    const g = fn(PAGE, "function stoppedGroupHtml(");
    const sum = g.match(/<summary[^`]*?<\/summary>/)?.[0] ?? "";
    expect(sum).not.toBe("");
    expect(sum).not.toMatch(/rmAll|<button/);
    expect(g).toMatch(/data-stopped[^`]*`\s*\+\s*`<summary/);
    expect(g).toMatch(
      /<div class="agstw" data-stopped-row>`\s*\+\s*rmAll\s*\+/,
    );
  });

  it("the button is never clipped (the kit's 44px touch target stays whole)", () => {
    const css = read("agents.html");
    const r = css.match(/\.agl \.agstw > \.den-btn\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(r).not.toBe("");
    expect(r).not.toMatch(/overflow\s*:\s*(hidden|clip)/);
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
