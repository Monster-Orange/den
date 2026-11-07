/**
 * den#6: the audit ring persists. With an audit file (the web server's
 * <state dir>/audit.jsonl, 0600), each action is appended as one JSON line
 * and read back when the server starts again, so a restart keeps the trail.
 * It is compacted to the ring's size once it holds twice as many.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AUDIT_FILE,
  recentActions,
  recordAction,
  setAuditFile,
} from "../../../src/ui/server/audit.js";

const tmps: string[] = [];
afterEach(() => {
  setAuditFile(null);
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-audit-"));
  tmps.push(dir);
  return path.join(dir, AUDIT_FILE);
}

describe("the persisted audit ring", () => {
  it("survives a restart: what was recorded is read back, oldest first", () => {
    const f = file();
    setAuditFile(f);
    recordAction(null, { verb: "agents", detail: "stop planner in north" });
    recordAction(null, { verb: "agents", detail: "resume planner in north" });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    // A restart: the ring starts empty and reads the file.
    setAuditFile(null);
    expect(recentActions()).toEqual([]);
    setAuditFile(f);
    expect(recentActions().map((e) => e.detail)).toEqual([
      "stop planner in north",
      "resume planner in north",
    ]);
  });

  it("keeps at most the ring's 200 entries, and compacts the file", () => {
    const f = file();
    setAuditFile(f);
    for (let i = 0; i < 450; i++)
      recordAction(null, { verb: "exec", detail: `n${i}` });
    const lines = fs.readFileSync(f, "utf-8").trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(400);
    setAuditFile(f);
    const back = recentActions();
    expect(back).toHaveLength(200);
    expect(back[back.length - 1].detail).toBe("n449");
  });

  it("skips a torn line instead of failing", () => {
    const f = file();
    fs.writeFileSync(
      f,
      '{"ts":"2026-11-07T00:00:00.000Z","actor":"user","verb":"exec","detail":"a"}\n{"ts":\n',
    );
    setAuditFile(f);
    expect(recentActions().map((e) => e.detail)).toEqual(["a"]);
  });
});
