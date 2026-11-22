/**
 * Issue 819, item 5: first run never comes back on a guess. With the
 * marker (web-first-run.json) missing, first run counts as over when the
 * state dir shows a sign-in happened (a used setup link) or can't be read
 * to tell (a sessions file that won't parse or read). A fresh state dir is
 * still first run. Invented names; a temporary state dir.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FIRST_RUN_FILE, FirstRun } from "../../../src/ui/server/first-run.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-819-fr-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
// As index.ts wires it, with no live person session and no owner.
const firstRun = () =>
  new FirstRun({
    stateDir: () => dir,
    sessionVias: () => [],
    ownerLinked: () => false,
  });

describe("item 5: with the marker missing", () => {
  it("a fresh state dir is first run", () => {
    expect(firstRun().done()).toBe(false);
    expect(fs.existsSync(path.join(dir, FIRST_RUN_FILE))).toBe(false);
  });

  it("a sessions file that won't parse: first run is over, and the marker is written back", () => {
    fs.writeFileSync(path.join(dir, "web-sessions.json"), "{ not json");
    expect(firstRun().done()).toBe(true);
    expect(fs.existsSync(path.join(dir, FIRST_RUN_FILE))).toBe(true);
  });

  it("a sessions file that can't be read: first run is over", () => {
    fs.mkdirSync(path.join(dir, "web-sessions.json"));
    expect(firstRun().done()).toBe(true);
  });

  it("a used setup link on record: first run is over", () => {
    fs.writeFileSync(
      path.join(dir, "claim-nonces.json"),
      JSON.stringify({ abc: Date.now() + 60_000 }),
    );
    expect(firstRun().done()).toBe(true);
  });
});
