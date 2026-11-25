/**
 * Issue 1509: the first start that redacts the audit (issue 1391) moves
 * the trail into audit-before-redaction/. A refusal written just before
 * that move must still count in doctor's last-hour row, so for the hour
 * after the move doctor also reads the set-aside trail: its refused agent
 * tokens only, nothing else from that folder.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readRefusalTrail,
  tokenRefusalLines,
} from "../../../src/ui/cli/doctor-token-refusals.js";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const ago = (min: number) =>
  new Date(NOW.getTime() - min * 60_000).toISOString();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const row = (agent: string, min: number, extra: object = {}) =>
  JSON.stringify({
    ts: ago(min),
    verb: "agent-token",
    outcome: "refused",
    principal: `agent:${agent}`,
    reason: "token_elsewhere",
    detail: `agent:${agent}'s token from x: POST /api/agents/self/attention`,
    ...extra,
  });

/** A state dir whose trail was set aside `movedMin` minutes ago. */
function state(movedMin: number, aside: string[], live: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t1509-"));
  dirs.push(dir);
  const sa = path.join(dir, "audit-before-redaction");
  fs.mkdirSync(sa);
  fs.writeFileSync(path.join(sa, "audit.jsonl"), aside.join("\n") + "\n");
  fs.writeFileSync(
    path.join(sa, "set-aside.json"),
    JSON.stringify({ at: ago(movedMin), moved: 1 }) + "\n",
  );
  fs.writeFileSync(path.join(dir, "audit.jsonl"), live.join("\n") + "\n");
  return dir;
}

describe("issue 1509: a refusal set aside at the update still counts", () => {
  it("moved 5 minutes ago: the set-aside refusal is in the row", () => {
    const dir = state(5, [row("lane-22", 6)], [row("lane-3", 2)]);
    const r = tokenRefusalLines("Den", readRefusalTrail(dir, NOW), NOW);
    expect(r.check.status).toBe("warn");
    expect(r.check.detail).toContain("lane-22: 1");
    expect(r.check.detail).toContain("lane-3: 1");
  });

  it("moved over an hour ago: the folder isn't read", () => {
    const dir = state(61, [row("lane-22", 6)]);
    expect(readRefusalTrail(dir, NOW)).toEqual([]);
  });

  it("only refused agent tokens come out of the folder", () => {
    const dir = state(5, [
      row("lane-22", 6),
      JSON.stringify({ ts: ago(6), verb: "setting", detail: "a value" }),
      row("lane-22", 6, { outcome: undefined }),
      "not json",
    ]);
    const got = readRefusalTrail(dir, NOW);
    expect(got).toHaveLength(1);
    expect(got[0]!.principal).toBe("agent:lane-22");
  });

  it("a copy moved beside it (audit.jsonl.1) is read; a link is not", () => {
    const dir = state(5, []);
    const sa = path.join(dir, "audit-before-redaction");
    fs.writeFileSync(path.join(sa, "audit.jsonl.1"), row("lane-9", 7) + "\n");
    const other = path.join(dir, "elsewhere.jsonl");
    fs.writeFileSync(other, row("lane-8", 7) + "\n");
    fs.symlinkSync(other, path.join(sa, "audit.jsonl.2"));
    const who = readRefusalTrail(dir, NOW).map((e) => e.principal);
    expect(who).toEqual(["agent:lane-9"]);
  });

  it("a set-aside row is redacted: a secret in its detail, principal or reason", () => {
    const GH = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    const dir = state(5, [
      row("lane-22", 6, {
        detail: `token from x ${GH}: POST /api/agents/self/attention`,
        reason: `token_elsewhere ${GH}`,
        principal: `agent:lane-22 ${GH}`,
      }),
    ]);
    const got = readRefusalTrail(dir, NOW);
    expect(got).toHaveLength(1);
    expect(JSON.stringify(got)).not.toContain(GH);
    expect(got[0]!.detail).toContain("POST /api/agents/self/attention");
  });

  it("a marker ahead of now (a clock set back) leaves the folder unread", () => {
    const dir = state(-60, [row("lane-22", 6)]);
    expect(readRefusalTrail(dir, NOW)).toEqual([]);
  });

  it("no set-aside, or no marker: only the live trail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t1509-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "audit.jsonl"), row("lane-3", 2) + "\n");
    expect(readRefusalTrail(dir, NOW).map((e) => e.principal)).toEqual([
      "agent:lane-3",
    ]);
    const sa = path.join(dir, "audit-before-redaction");
    fs.mkdirSync(sa);
    fs.writeFileSync(path.join(sa, "audit.jsonl"), row("lane-22", 6) + "\n");
    expect(readRefusalTrail(dir, NOW)).toHaveLength(1);
  });
});
