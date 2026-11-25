/**
 * Issue 1391: agents may read the activity trail (audit.jsonl), so no
 * entry may carry a secret. recordAction redacts every entry's free text
 * (its detail, its reason, a queued report's principal) before the row is
 * kept, written or logged: every caller, the CLI's sent rows and the
 * queue's alike.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AUDIT_FILE,
  recentActions,
  recordAction,
  recordQueuedAuditRow,
  recordSentAuditRow,
  setAuditFile,
  setAuditSink,
} from "../../../src/ui/server/audit.js";

// Token-shaped values redactSecrets catches; never real ones.
const GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const BEARER = "Bearer " + "abcDEF0123456789xyz";

const tmps: string[] = [];
afterEach(() => {
  setAuditFile(null);
  setAuditSink(null);
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function trail(): { file: string; logged: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-audit-redact-"));
  tmps.push(dir);
  const file = path.join(dir, AUDIT_FILE);
  setAuditFile(file);
  const logged: string[] = [];
  setAuditSink((line) => logged.push(line));
  return { file, logged };
}

const leaks = (t: { file: string; logged: string[] }) =>
  [
    fs.readFileSync(t.file, "utf-8"),
    ...t.logged,
    JSON.stringify(recentActions()),
  ]
    .join("\n")
    .match(/ghp_A1b2|abcDEF0123456789xyz/g);

describe("issue 1391: the activity trail never keeps a secret", () => {
  it("a setting change whose value carries a token: redacted in the file, the ring and the log", () => {
    const t = trail();
    recordAction(null, {
      verb: "setting_change",
      detail: `ui.terminal_command: code → mytool --token ${GH}`,
    });
    expect(leaks(t)).toBeNull();
    expect(recentActions()[0].detail).toContain(
      "ui.terminal_command: code → mytool --token",
    );
  });

  it("a refusal's reason: redacted too", () => {
    const t = trail();
    recordAction(null, {
      verb: "setting_change",
      detail: "ui.editor_command",
      outcome: "refused",
      reason: `rejected: ${BEARER}`,
    });
    expect(leaks(t)).toBeNull();
    expect(recentActions()[0].reason).toMatch(/^rejected: /);
  });

  it("a row a den command sent over /api/audit/cli: redacted", () => {
    const t = trail();
    recordSentAuditRow(
      null,
      { verb: "config-write", detail: `hub url https://x:${GH}@example.test/` },
      "person:someone",
    );
    expect(leaks(t)).toBeNull();
  });

  it("a queued row: its detail and its reported principal (a command line) redacted", () => {
    const t = trail();
    recordQueuedAuditRow({
      verb: "agents",
      detail: `restart planner ${GH}`,
      reported: {
        principal: `person:someone (den agents ${GH}, pid 1)`,
        at: new Date().toISOString(),
        uid: 501,
        written: new Date().toISOString(),
      },
    });
    expect(leaks(t)).toBeNull();
    expect(recentActions()[0].detail).toMatch(/^restart planner /);
  });

  it("every string in an entry, however deep: addresses, the agents block, a claim's fields", () => {
    const t = trail();
    recordAction(
      {
        kind: "agent",
        agent: "planner",
        client: "den-mcp",
        clientVersion: "0",
        mcpPid: 1,
        session: `acme:${GH}`,
        unverified: true,
      },
      {
        verb: "host-restart",
        detail: "restart the host",
        addresses: [`https://x:${GH}@example.test/a`],
        agents: { failed: [{ id: "planner", why: `refused: ${BEARER}` }] },
      },
    );
    expect(leaks(t)).toBeNull();
    const e = recentActions()[0];
    expect(e.addresses?.[0]).toMatch(/^https:\/\/x:/);
    expect(JSON.stringify(e.agents)).toContain("refused: ");
  });
});
