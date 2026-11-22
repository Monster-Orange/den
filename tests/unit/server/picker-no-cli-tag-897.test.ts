/**
 * Issue 897: the project drop-down shows no "CLI default" tag. Picking a
 * project already makes it the CLI default, so the tag only followed the
 * checkmark. The CLI keeps its default silently. The tag's string is gone
 * from en, es and ja; the error line for a failed change stays.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

describe("issue 897: no CLI default tag in the project drop-down", () => {
  it("the drop-down's rows carry no ws.focus tag", () => {
    expect(read("shell.js")).not.toMatch(/t\("ws\.focus"\)/);
  });

  it.each(["shell.js", "i18n/es.js", "i18n/ja.js"])(
    "%s has no ws.focus string (ws.focusFailed stays)",
    (f) => {
      const src = read(f);
      expect(src).not.toMatch(/"ws\.focus":/);
      expect(src).toMatch(/"ws\.focusFailed":/);
    },
  );
});
