/**
 * Issue 1391: agents may read the activity trail, so setting_change never
 * puts a free-text value there. A command (editor, terminal,
 * editor_overrides) or any other text, list or map is said as changed,
 * with its length, in the audit line and in the summary every approval
 * row copies (ask, auto-allow, decide, withdraw, lapse). A number, a
 * switch, "not set" and Den's default stay as values. The card's own
 * Now and New lines still show the whole value (issue 1371, review C):
 * the person sees exactly what they allow.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkSettingChange,
  runSettingChange,
  type SettingChangeDeps,
} from "../../../src/ui/cli/setting-change.js";
import type { DenConfig } from "../../../src/shared/den-config.js";

// Not token-shaped: redactSecrets alone would keep it.
const TYPED = "s3cr3t-typed-in";
let dir = "";
let audits: { detail: string; reason?: string }[] = [];

function deps(): SettingChangeDeps {
  return {
    userFile: path.join(dir, "config", "local", "user.yml"),
    backupDir: path.join(dir, "state", "settings-backups"),
    denConfig: () => ({}) as DenConfig,
    audit: (detail, reason) => audits.push({ detail, reason }),
    now: () => "2026-11-23T20:00:00.000Z",
  };
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1391-")));
  audits = [];
  const f = deps().userFile;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "editor: code\nsessions:\n  close_grace_seconds: 30\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const trailText = () => audits.map((a) => a.detail).join("\n");

describe("issue 1391: setting_change keeps free text out of the trail", () => {
  it("a command: the audit line and the summary say changed, with lengths; the card shows it whole", () => {
    const ask = {
      key: "editor",
      value: `mytool --pass ${TYPED}`,
      reason: "a new editor",
    };
    const c = checkSettingChange(deps(), ask, { agent: "den-builder" });
    if (!c.ok) throw new Error(c.error);
    expect(c.summary).toBe(
      "editor: changed (was 4 characters, now 29 characters)",
    );
    expect(c.summary).not.toContain(TYPED);
    // The card: the whole value, as the person allows it.
    expect(c.details.join("\n")).toContain(`New: mytool --pass ${TYPED}`);
    expect(c.details.join("\n")).toContain("Now: code");
    const r = runSettingChange(deps(), ask, { agent: "den-builder" });
    expect(r.ok).toBe(true);
    expect(trailText()).toBe(
      "setting_change editor: changed (was 4 characters, now 29 characters) (asked by den-builder)",
    );
  });

  it("a command set where none was, and one taken back to Den's default", () => {
    const set = { key: "terminal", value: `term ${TYPED}`, reason: "r" };
    const c = checkSettingChange(deps(), set);
    if (!c.ok) throw new Error(c.error);
    expect(c.summary).toBe(
      "terminal: changed (was not set, now 20 characters)",
    );
    runSettingChange(deps(), set);
    const back = checkSettingChange(deps(), {
      key: "terminal",
      value: null,
      reason: "r",
    });
    if (!back.ok) throw new Error(back.error);
    expect(back.summary).toBe(
      "terminal: changed (was 20 characters, now Den's default)",
    );
    runSettingChange(deps(), { key: "terminal", value: null, reason: "r" });
    expect(trailText()).not.toContain(TYPED);
    expect(trailText()).toMatch(
      /terminal: changed \(was 20 characters, now default\)/,
    );
  });

  it("a mapping of commands (editor_overrides): never its text", () => {
    const ask = {
      key: "editor_overrides",
      value: { "*.md": `mdtool ${TYPED}` },
      reason: "r",
    };
    const c = checkSettingChange(deps(), ask);
    if (!c.ok) throw new Error(c.error);
    expect(c.summary).not.toContain(TYPED);
    expect(c.summary).toMatch(
      /^editor_overrides: changed \(was not set, now \d+ characters\)$/,
    );
    runSettingChange(deps(), ask);
    expect(trailText()).not.toContain(TYPED);
    expect(trailText()).not.toContain("mdtool");
  });

  it("a number stays a value", () => {
    const ask = { key: "sessions.close_grace_seconds", value: 45, reason: "r" };
    const c = checkSettingChange(deps(), ask);
    if (!c.ok) throw new Error(c.error);
    expect(c.summary).toBe("sessions.close_grace_seconds: 30 → 45");
    runSettingChange(deps(), ask);
    expect(trailText()).toBe(
      "setting_change sessions.close_grace_seconds: 30 → 45",
    );
  });

  it("a refused value it quotes (a refused ask's reason, in the trail): said by its length", () => {
    const c = checkSettingChange(deps(), {
      key: "web.edge_unattested",
      value: `local ${TYPED}`,
      reason: "r",
    });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error).not.toContain(TYPED);
    expect(c.error).toMatch(/must be local or signin, got <\d+ characters>/);
  });

  it("the same command again: nothing to change, never its text", () => {
    const c = checkSettingChange(deps(), {
      key: "editor",
      value: "code",
      reason: "r",
    });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error).toBe("editor is already 4 characters: nothing to change");
  });
});
