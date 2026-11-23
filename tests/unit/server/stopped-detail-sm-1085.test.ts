/**
 * Issue 1085: a stopped agent's detail panel (den-svp-acts: Resume, Start
 * fresh, Remove, its output) draws every action at the kit's small
 * row-action size (den-btn sm), the size of the stopped rows' own
 * actions, so Remove is never the one large button. No new size.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const SRC = fs.readFileSync(
  path.join(process.cwd(), "src/ui/server/public/agents-page.js"),
  "utf-8",
);

/** detailsHtml's text: from its declaration to the next top-level one. */
function detailsHtml(): string {
  const i = SRC.indexOf("function detailsHtml(");
  expect(i).toBeGreaterThan(-1);
  const rest = SRC.slice(i + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return SRC.slice(i, end < 0 ? undefined : i + 1 + end);
}

/** Each data-agd action button's class list (not Close, an icon button). */
function actions(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(
    /<button type="button" class="([^"]+)" data-agd="(\w+)"/g,
  ))
    if (m[2] !== "close") out[m[2]!] = m[1]!;
  return out;
}

describe("issue 1085: a stopped agent's detail actions are the kit's small size", () => {
  it("finds a full-size action (the check can fail)", () => {
    expect(
      actions('<button type="button" class="den-btn" data-agd="remove">'),
    ).toEqual({ remove: "den-btn" });
  });

  it("Resume, Start fresh, Remove and its output are all den-btn sm", () => {
    const acts = actions(detailsHtml());
    expect(Object.keys(acts).sort()).toEqual([
      "fresh",
      "open",
      "remove",
      "resume",
    ]);
    for (const [act, cls] of Object.entries(acts))
      expect([act, cls.split(/\s+/).includes("sm")]).toEqual([act, true]);
    // The kit's sizes only: no size of the page's own.
    for (const cls of Object.values(acts))
      expect(cls).toMatch(/^den-btn sm( primary)?$/);
  });
});
