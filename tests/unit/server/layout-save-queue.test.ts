/**
 * Issue 786 part 3b: a page's own quick layout changes (a pin, then a
 * drag) never refuse each other. shell.js sends layout saves one at a
 * time: what comes while one is on its way merges and goes once it
 * answers, carrying the revision that answer gave. Runs shell.js's
 * shellSaveQueue (between its markers) in plain JS.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const SRC = fs.readFileSync(
  path.join(__dirname, "../../../src/ui/server/public/shell.js"),
  "utf8",
);
const START = SRC.indexOf("  // ── shellSaveQueue");
const END = SRC.indexOf("  // ── end shellSaveQueue ──");

type Post = (patch: Record<string, unknown>) => Promise<boolean | "stale">;
const queueOf = (post: Post) =>
  (
    new Function(`${SRC.slice(START, END)}; return shellSaveQueue;`)() as (
      p: Post,
    ) => (patch: Record<string, unknown>) => Promise<boolean>
  )(post);

describe("layout saves from one page", () => {
  it("shell.js has the queue", () => {
    expect(START).toBeGreaterThan(0);
    expect(END).toBeGreaterThan(START);
  });

  it("two saves in a row: the second goes after the first answers, with its revision", async () => {
    // The server's stored revision, and a save refused when it's stale.
    let stored = "r0";
    let pageRev = "r0";
    const sent: Array<{ patch: Record<string, unknown>; rev: string }> = [];
    const post: Post = async (patch) => {
      sent.push({ patch, rev: pageRev });
      await new Promise((r) => setTimeout(r, 5));
      if (pageRev !== stored) return false;
      stored = `r${sent.length}`;
      pageRev = stored;
      return true;
    };
    const save = queueOf(post);
    const a = save({ pins: [{ item: "a" }] });
    const b = save({ collapsed: true });
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(sent.map((s) => s.rev)).toEqual(["r0", "r1"]);
    expect(sent[1].patch).toEqual({ collapsed: true });
  });

  it("what comes while one is on its way merges: the last value of a key wins", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const save = queueOf(async (patch) => {
      sent.push(patch);
      await new Promise((r) => setTimeout(r, 5));
      return true;
    });
    const all = [
      save({ hidden: ["logs"] }),
      save({ collapsed: true }),
      save({ hidden: ["logs", "tests"] }),
    ];
    expect(await Promise.all(all)).toEqual([true, true, true]);
    expect(sent).toEqual([
      { hidden: ["logs"] },
      { collapsed: true, hidden: ["logs", "tests"] },
    ]);
  });

  it("a refused save (the layout changed elsewhere) drops what waits behind it", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const save = queueOf(async (patch) => {
      sent.push(patch);
      await new Promise((r) => setTimeout(r, 5));
      return sent.length === 1 ? "stale" : true;
    });
    const a = save({ pins: [] });
    const b = save({ hidden: ["agents"] });
    expect(await Promise.all([a, b])).toEqual([false, false]);
    expect(sent).toEqual([{ pins: [] }]);
    // A change made after it goes as usual.
    expect(await save({ collapsed: true })).toBe(true);
    expect(sent).toEqual([{ pins: [] }, { collapsed: true }]);
  });

  it("a save that fails says so, and the next still goes", async () => {
    let n = 0;
    const save = queueOf(async () => {
      n++;
      if (n === 1) throw new Error("offline");
      return true;
    });
    expect(await save({ collapsed: true })).toBe(false);
    expect(await save({ collapsed: false })).toBe(true);
  });
});
