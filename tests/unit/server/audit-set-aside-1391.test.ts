/**
 * Issue 1391: agents may now read the activity trail, and rows written
 * before this version were never redacted (a setting's raw value, an
 * older CLI's command line as its principal). At the server's start,
 * before the trail is read or anything is added to it, the old trail and
 * every copy beside it move into <state>/audit-before-redaction/, a
 * folder agents are denied in every mode. Once: a marker in the folder,
 * written whole; a start that stopped part-way finishes the move and
 * never overwrites what was moved. The fresh trail says the older one
 * was set aside.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AUDIT_FILE,
  AUDIT_SET_ASIDE_DIR,
  recentActions,
  recordQueuedAuditRow,
  setAsideOldTrail,
  setAuditFile,
} from "../../../src/ui/server/audit.js";
import {
  queueAuditRow,
  takeQueuedAuditRows,
} from "../../../src/shared/audit-queue.js";
import { stateDirDenyRules } from "../../../src/shared/agents/den-claude.js";
import { sharedUserLines } from "../../../src/ui/cli/doctor-command.js";
import { registerInstall } from "../../../src/shared/install-registry.js";
import { readDenied } from "../agents/helpers/claude-rules.js";

const GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const OLD_ROW = JSON.stringify({
  ts: "2026-11-01T00:00:00.000Z",
  actor: "user",
  verb: "setting_change",
  detail: "setting_change terminal: not set → term s3cr3t-typed-in",
  reported: { principal: `person:x (den config token=${GH}, pid 1)` },
});

const tmps: string[] = [];
afterEach(() => {
  setAuditFile(null);
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function state(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-aside-")),
  );
  tmps.push(d);
  return d;
}
const aside = (s: string) => path.join(s, AUDIT_SET_ASIDE_DIR);
const names = (d: string) => fs.readdirSync(d).sort();

describe("issue 1391: the trail written before redaction is set aside, once", () => {
  it("moves the trail and every copy beside it, intact, into a 0700 folder", () => {
    const s = state();
    fs.writeFileSync(path.join(s, AUDIT_FILE), OLD_ROW + "\n", { mode: 0o600 });
    fs.writeFileSync(
      path.join(s, `${AUDIT_FILE}.123.abcd.tmp`),
      OLD_ROW + "\n",
    );
    expect(setAsideOldTrail(s)).toEqual({ moved: 2 });
    expect(fs.existsSync(path.join(s, AUDIT_FILE))).toBe(false);
    expect(fs.readdirSync(s).filter((n) => n.startsWith(AUDIT_FILE))).toEqual(
      [],
    );
    expect(fs.statSync(aside(s)).mode & 0o777).toBe(0o700);
    expect(names(aside(s))).toEqual([
      AUDIT_FILE,
      `${AUDIT_FILE}.123.abcd.tmp`,
      "set-aside.json",
    ]);
    expect(fs.readFileSync(path.join(aside(s), AUDIT_FILE), "utf-8")).toBe(
      OLD_ROW + "\n",
    );
  });

  it("runs once: a later start leaves the fresh trail where it is", () => {
    const s = state();
    fs.writeFileSync(path.join(s, AUDIT_FILE), OLD_ROW + "\n");
    setAsideOldTrail(s);
    fs.writeFileSync(path.join(s, AUDIT_FILE), "{}\n");
    expect(setAsideOldTrail(s)).toEqual({ moved: 0 });
    expect(fs.readFileSync(path.join(s, AUDIT_FILE), "utf-8")).toBe("{}\n");
  });

  it("a fresh install: nothing to move, and it is marked done", () => {
    const s = state();
    expect(setAsideOldTrail(s)).toEqual({ moved: 0 });
    expect(names(aside(s))).toEqual(["set-aside.json"]);
  });

  it("a start that stopped part-way: the move finishes, and nothing moved before is overwritten", () => {
    const s = state();
    fs.mkdirSync(aside(s), { mode: 0o700 });
    fs.writeFileSync(path.join(aside(s), AUDIT_FILE), "first\n");
    fs.writeFileSync(path.join(s, AUDIT_FILE), "second\n");
    expect(setAsideOldTrail(s)).toEqual({ moved: 1 });
    const kept = names(aside(s)).filter((n) => n !== "set-aside.json");
    expect(kept).toHaveLength(2);
    expect(
      kept.map((n) => fs.readFileSync(path.join(aside(s), n), "utf-8")).sort(),
    ).toEqual(["first\n", "second\n"]);
  });

  it("then a queued row taken in lands in the fresh trail, redacted", () => {
    const s = state();
    fs.writeFileSync(path.join(s, AUDIT_FILE), OLD_ROW + "\n");
    queueAuditRow(s, {
      verb: "agents",
      detail: `restart planner ${GH}`,
      principal: `person:x (den agents ${GH}, pid 2)`,
    });
    setAsideOldTrail(s);
    setAuditFile(path.join(s, AUDIT_FILE));
    takeQueuedAuditRows(s, (row) => void recordQueuedAuditRow(row), undefined, {
      settleMs: 0,
    });
    const text = fs.readFileSync(path.join(s, AUDIT_FILE), "utf-8");
    expect(text).toContain("restart planner ");
    expect(text).not.toContain("ghp_A1b2");
    expect(text).not.toContain("s3cr3t-typed-in");
    expect(recentActions().map((e) => e.verb)).toEqual(["agents"]);
  });

  it("the folder is denied to agents in every mode, and doctor doesn't list what's in it", () => {
    const s = state();
    fs.writeFileSync(path.join(s, AUDIT_FILE), OLD_ROW + "\n", { mode: 0o600 });
    setAsideOldTrail(s);
    const f = path.join(aside(s), AUDIT_FILE);
    for (const trailReadable of [true, false])
      expect(
        readDenied(stateDirDenyRules(s, undefined, { trailReadable }), f),
      ).toBe(true);
    const reg = path.join(s, "..", path.basename(s) + "-installs");
    tmps.push(reg);
    registerInstall(reg, { stateDir: s, edgeKeyDirs: [] });
    for (const trailReadable of [true, false]) {
      const c = sharedUserLines("Den", {
        stateDir: s,
        registry: reg,
        home: os.tmpdir(),
        serverRunning: () => false,
        trailReadable,
      }).checks.find((x) => x.id === "uncovered_files")!;
      expect([trailReadable, c.status]).toEqual([trailReadable, "ok"]);
    }
  });
});
