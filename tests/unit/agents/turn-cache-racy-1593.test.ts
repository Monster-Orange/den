/**
 * A due agent must be relaunched after its turn ends. Whether
 * a turn is going is kept per transcript while its size and mtime stay the
 * same. A file's mtime ticks coarsely (a few ms on Linux, 2 s on some
 * shares), so a rewrite inside one tick, of the same size, looked unchanged
 * and the old "busy" stood. A verdict read while the file was that fresh is
 * never kept: the file is read again.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  resetTurnCache,
  transcriptBusy,
} from "../../../src/shared/agents/conversations.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const record = (stop: "tool_use" | "end_turn") =>
  JSON.stringify({
    type: "assistant",
    message: { stop_reason: stop, content: [{ type: "text", text: "ok" }] },
  }) + "\n";

function file(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "t1593-"));
  dirs.push(d);
  return path.join(d, "c1593.jsonl");
}

/** The file's mtime, set to this ms (a whole one, as utimes keeps it). */
function tick(f: string): Date {
  const t = new Date(Date.now());
  fs.utimesSync(f, t, t);
  return t;
}

describe("issue 1593: a turn that ends inside one mtime tick", () => {
  it("same size, same mtime, now idle: reads idle", () => {
    resetTurnCache();
    const f = file();
    fs.writeFileSync(f, record("tool_use"));
    const mtime = tick(f);
    expect(transcriptBusy(f)).toBe(true);
    // The turn ends: same length, and the clock hadn't ticked.
    fs.writeFileSync(f, record("end_turn"));
    fs.utimesSync(f, mtime, mtime);
    expect(fs.statSync(f).size).toBe(record("tool_use").length);
    expect(transcriptBusy(f)).toBe(false);
  });

  it("and the other way: an idle turn that starts again reads busy", () => {
    resetTurnCache();
    const f = file();
    fs.writeFileSync(f, record("end_turn"));
    const mtime = tick(f);
    expect(transcriptBusy(f)).toBe(false);
    fs.writeFileSync(f, record("tool_use"));
    fs.utimesSync(f, mtime, mtime);
    expect(transcriptBusy(f)).toBe(true);
  });
});
