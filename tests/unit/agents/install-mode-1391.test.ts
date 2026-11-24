/**
 * Issue 1391: an install has a mode, `install_mode` in user.yml (PR 1394's
 * readInstallMode): personal (one person's own machine; the default) or
 * strict (team and enterprise).
 *
 * On a personal install an agent may read the install's own activity
 * trail (redacted, never editable), once the older trail is set aside;
 * on a strict one the trail stays as 0.4.88 left it: denied by the rules
 * and unreadable in the sandbox. A mode that can't be read counts as
 * strict. Other installs' trails are denied in every mode. Read when an
 * agent's rules and sandbox are built: a change applies at its next start.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readAgentsConfig,
  type DenConfig,
  type UserConfig,
} from "../../../src/shared/den-config.js";
import { stateDirDenyRules } from "../../../src/shared/agents/den-claude.js";
import { agentSandboxPolicy } from "../../../src/shared/agents/sandbox.js";
import {
  agentSandboxInput,
  agentsMayReadTrail,
} from "../../../src/ui/cli/agent-ops.js";
import { AUDIT_SET_ASIDE_DIR } from "../../../src/shared/audit-file.js";
import {
  checkSettingChange,
  settingKind,
  type SettingChangeDeps,
} from "../../../src/ui/cli/setting-change.js";
import { denied, readDenied } from "./helpers/claude-rules.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-mode-")),
  );
  tmps.push(d);
  return d;
}
const user = (mode?: unknown) =>
  (mode === undefined ? {} : { install_mode: mode }) as unknown as UserConfig;

describe("issue 1391: the install's mode", () => {
  it("readAgentsConfig carries it: unset is personal, strict is strict", () => {
    expect(readAgentsConfig({} as DenConfig, user()).mode).toBe("personal");
    expect(readAgentsConfig({} as DenConfig, user("strict")).mode).toBe(
      "strict",
    );
  });

  it("setting_change on install_mode widens: only the person's own Allow runs it", () => {
    expect(settingKind("install_mode").widens).toBe(true);
    const dir = tmp();
    const deps: SettingChangeDeps = {
      userFile: path.join(dir, "config", "local", "user.yml"),
      backupDir: path.join(dir, "backups"),
      denConfig: () => ({}) as DenConfig,
      audit: () => undefined,
      now: () => "2026-11-23T20:00:00.000Z",
    };
    fs.mkdirSync(path.dirname(deps.userFile), { recursive: true });
    fs.writeFileSync(deps.userFile, "install_mode: strict\n");
    const c = checkSettingChange(
      deps,
      { key: "install_mode", value: "personal", reason: "r" },
      { agent: "planner" },
    );
    if (!c.ok) throw new Error(c.error);
    expect(c.personOnly).toBe(true);
  });
});

describe("issue 1391: the trail by mode, in the deny rules", () => {
  const state = "/srv/den-state";
  const trail = path.join(state, "audit.jsonl");

  it("personal: the install's own trail is readable, by Read and by a command; never editable", () => {
    const deny = stateDirDenyRules(state, undefined, { trailReadable: true });
    expect(readDenied(deny, trail)).toBe(false);
    expect(denied(deny, `tail ${trail}`)).toBe(false);
    expect(deny).toContain(`Edit(/${trail})`);
  });

  it("strict, or not said (another install's trail): denied as 0.4.88 left it", () => {
    for (const deny of [
      stateDirDenyRules(state, undefined, { trailReadable: false }),
      stateDirDenyRules(state),
    ]) {
      expect(readDenied(deny, trail)).toBe(true);
      expect(denied(deny, `tail ${trail}`)).toBe(true);
      expect(deny).toContain(`Edit(/${trail})`);
    }
  });
});

describe("issue 1391: the trail by mode, in the sandbox", () => {
  function input(trailReadable?: boolean) {
    const base = tmp();
    const stateDir = path.join(base, "state");
    const distRoot = path.join(base, "root");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(distRoot, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "audit.jsonl"), "");
    return {
      stateDir,
      i: agentSandboxInput({
        stateDir,
        distRoot,
        env: { HOME: base, DEN_GATE_DIR: path.join(base, "gate") },
        agentId: "a1",
        home: base,
        ...(trailReadable === undefined ? {} : { trailReadable }),
      }),
    };
  }

  it("personal: audit.jsonl is read back, and never writable", () => {
    const { stateDir, i } = input(true);
    const p = agentSandboxPolicy(i);
    const trail = path.join(stateDir, "audit.jsonl");
    expect(p.readableFiles).toContain(trail);
    expect(
      p.writable.some((w) => trail === w || trail.startsWith(w + path.sep)),
    ).toBe(false);
  });

  it("strict, or not said: audit.jsonl is not read back (built at the start: a later change waits for the next)", () => {
    for (const mode of [false, undefined]) {
      const { stateDir, i } = input(mode);
      expect(agentSandboxPolicy(i).readableFiles).not.toContain(
        path.join(stateDir, "audit.jsonl"),
      );
    }
  });

  describe("issue 1391: only once the older trail is set aside", () => {
    it("personal and set aside: readable; not set aside (the step failed), or strict: not", () => {
      const s = tmp();
      const personal = { mode: "personal" as const };
      expect(agentsMayReadTrail(personal, s)).toBe(false);
      fs.mkdirSync(path.join(s, AUDIT_SET_ASIDE_DIR));
      fs.writeFileSync(
        path.join(s, AUDIT_SET_ASIDE_DIR, "set-aside.json"),
        "{}\n",
      );
      expect(agentsMayReadTrail(personal, s)).toBe(true);
      expect(agentsMayReadTrail({ mode: "strict" }, s)).toBe(false);
      expect(agentsMayReadTrail({}, s)).toBe(false);
    });
  });
});
