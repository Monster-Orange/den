/**
 * A spinner on a terminal that reports 0 columns (a pty nobody sized, as
 * agents and some CI runners give) must not animate: ora divides each
 * line's width by the column count to know how many lines to clear, gets
 * Infinity, and clears forever. Without a usable terminal the spinner
 * prints plain lines and finishes.
 *
 * Real ora (ESM-only, so Jest stubs it) in a child process, on a fake
 * terminal stream: see helpers/spinner-driver.mjs.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";
import { pathToFileURL } from "url";

const ENGINE = path.resolve(__dirname, "../../..");
const LOADER = pathToFileURL(
  path.join(ENGINE, "node_modules/tsx/dist/loader.mjs"),
).href;
const DRIVER = path.join(__dirname, "helpers", "spinner-driver.mjs");
const MODULE = pathToFileURL(path.join(ENGINE, "src/ui/cli/spinner.ts")).href;

function drive(columns: string, tty: "tty" | "pipe") {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
  // ora animates only on an interactive terminal: never under CI.
  delete env.CI;
  const r = spawnSync(
    process.execPath,
    ["--import", LOADER, DRIVER, columns, tty, MODULE],
    { encoding: "utf-8", env, timeout: 30_000 },
  );
  if (r.status !== 0)
    throw new Error(`driver exited ${r.status}: ${r.stderr.slice(0, 400)}`);
  return JSON.parse(r.stdout) as {
    bytes: number;
    escapes: boolean;
    spinning: boolean;
    out: string;
  };
}

describe("spinner on a terminal it cannot draw on", () => {
  it.each([
    ["0 columns", "0", "tty"],
    ["no column count", "none", "tty"],
    ["not a TTY", "80", "pipe"],
  ] as const)(
    "%s: finishes with plain lines and bounded output",
    (_label, cols, tty) => {
      const r = drive(cols, tty);
      expect(r.spinning).toBe(false);
      expect(r.bytes).toBeLessThan(1024);
      expect(r.out).toContain("Healthy");
      expect(r.escapes).toBe(false);
    },
    60_000,
  );

  it("a sized terminal still animates", () => {
    const r = drive("80", "tty");
    expect(r.escapes).toBe(true);
    expect(r.out).toContain("Healthy");
  }, 60_000);
});
