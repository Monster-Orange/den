/**
 * Issue 1369: doctor counts the audit entries that came in as reports
 * (queued by a process, unverified), and says when the intake dropped
 * some. Counts only: never an entry's words.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { auditReportLines } from "../../../src/ui/cli/doctor-command.js";
import {
  setAuditSender,
  auditConfig,
} from "../../../src/shared/config-audit.js";

let state = "";
beforeEach(() => {
  state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-dar-")));
  setAuditSender(null);
});
afterEach(() => fs.rmSync(state, { recursive: true, force: true }));

const now = new Date("2026-11-23T12:00:00.000Z");
const line = (e: Record<string, unknown>) =>
  fs.appendFileSync(path.join(state, "audit.jsonl"), JSON.stringify(e) + "\n");
const check = () => auditReportLines("Den", { stateDir: state, now }).check;

describe("issue 1369: doctor's audit reports row", () => {
  it("none: ok", () => {
    expect(check()).toMatchObject({ id: "audit_reports", status: "ok" });
  });

  it("reports in the last day, taken in or still queued: counted, ok, never their words", () => {
    line({
      ts: "2026-11-23T10:00:00.000Z",
      actor: "user",
      queued: true,
      unverified: true,
      verb: "agents",
      detail: "SECRET_WORDS",
    });
    line({
      ts: "2026-11-20T10:00:00.000Z",
      actor: "user",
      queued: true,
      unverified: true,
      verb: "agents",
      detail: "old",
    });
    line({
      ts: "2026-11-23T10:00:00.000Z",
      actor: "user",
      principal: "person:p",
      verb: "agents",
      detail: "sent",
    });
    auditConfig({ verb: "agents", detail: "SECRET_WORDS" }, state);
    const r = auditReportLines("Den", { stateDir: state, now: new Date() });
    expect(r.check.status).toBe("ok");
    expect(r.check.detail).toMatch(
      /^2 audit entries in the last day came in as reports/,
    );
    expect(r.lines.join("\n")).not.toContain("SECRET_WORDS");
  });

  it("the intake dropped some: a warning", () => {
    line({
      ts: "2026-11-23T11:00:00.000Z",
      actor: "user",
      verb: "audit-queue-dropped",
      detail: "queued audit entries dropped: 5 over the intake's cap",
    });
    const c = check();
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/dropped queued entries 1 time/);
  });
});
