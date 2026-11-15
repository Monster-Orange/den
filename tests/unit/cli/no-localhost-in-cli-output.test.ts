/**
 * D80 (#173): every link the CLI prints to a person is the install's
 * address (web.url), never localhost. This scans the command files that
 * print the service lines for a `localhost` inside a string they log.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const CLI = path.join(__dirname, "../../../src/ui/cli");
const FILES = ["service-command.ts"];

/** Lines that print to a person (log/console calls and their continuation). */
function printedLines(src: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  const lines = src.split("\n");
  lines.forEach((text, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
    if (/localhost/i.test(text) && /(`|"|')/.test(text))
      out.push({ n: i + 1, text: text.trim() });
  });
  return out;
}

describe("CLI output never says localhost (D80)", () => {
  for (const f of FILES) {
    it(`${f} prints no localhost`, () => {
      const src = fs.readFileSync(path.join(CLI, f), "utf-8");
      expect(printedLines(src)).toEqual([]);
    });
  }
});
