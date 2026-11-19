/**
 * Issue 503: the words a terminal that got no PTY shows (public/
 * pty-refusal.js), in en, es and ja, without a browser: Terminal's toast
 * and the start dialog's error line carry the terminal host's reason.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  startFailText,
  terminalFailText,
} from "../../../src/ui/server/public/pty-refusal.js";

const PUBLIC = path.resolve(__dirname, "../../../src/ui/server/public");

/** A language's string for `key`, read from its catalog's source. */
function catalogString(file: string, key: string): string {
  const src = fs.readFileSync(path.join(PUBLIC, file), "utf-8");
  const m = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]+)"`).exec(
    src,
  );
  if (!m) throw new Error(`${key} missing from ${file}`);
  return m[1];
}

const tOf =
  (file: string) =>
  (key: string, vars: Record<string, string> = {}) =>
    catalogString(file, key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

const noPty = Object.assign(
  new Error("could not open a PTY for /bin/sh: posix_openpt failed"),
  {
    code: "pty_open",
  },
);

describe("issue 503: a terminal with no PTY says so", () => {
  it.each([
    ["en", "shell.js", /no PTY/],
    ["es", "i18n/es.js", /PTY/],
    ["ja", "i18n/ja.js", /PTY/],
  ])("%s: the toast and the dialog name the reason", (_lang, file, word) => {
    const t = tOf(file);
    const toast = terminalFailText(noPty, t);
    expect(toast).toMatch(word);
    expect(toast).toContain("posix_openpt failed");
    expect(toast).toBe(t("ag.term.ptyFailed", { e: noPty.message }));
    expect(startFailText(noPty, t)).toBe(toast);
  });

  it("any other failure keeps its own words", () => {
    const t = tOf("shell.js");
    const other = Object.assign(new Error("project north is gone"), {
      code: "not_found",
    });
    expect(terminalFailText(other, t)).toBe(
      t("ag.term.failed", { e: "project north is gone" }),
    );
    expect(startFailText(other, t)).toBe("project north is gone");
  });
});
