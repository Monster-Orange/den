/**
 * Issue 773 (mock v3): the rail's Agents count is an amber pill, the
 * kit's warn tone; a plain badge stays grey and a bad one red.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { navItemHtml } from "../../../packages/den-ui/src/shell-html.js";

const item = (badge: Record<string, unknown>) =>
  navItemHtml(
    { id: "agents", label: "Agents", href: "/agents", group: "develop", badge },
    "item",
    "en",
  );

describe("issue 773: a warn badge", () => {
  it("a badge with warn is .den-bdg.warn; plain and bad keep theirs", () => {
    expect(item({ n: 2, what: "waiting", warn: true })).toContain(
      'class="den-bdg warn"',
    );
    expect(item({ n: 2 })).toContain('class="den-bdg"');
    expect(item({ n: 2, bad: true })).toContain('class="den-bdg bad"');
  });

  it("the kit's CSS fills it with the warn tone", () => {
    const css = fs.readFileSync(
      path.join(__dirname, "../../../packages/den-ui/src/shell.css"),
      "utf-8",
    );
    expect(css).toMatch(/\.den-bdg\.warn\s*\{[^}]*background:\s*var\(--warn\)/);
  });
});
