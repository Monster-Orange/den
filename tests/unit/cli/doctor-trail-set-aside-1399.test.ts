import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sharedUserLines } from "../../../src/ui/cli/doctor-command.js";
import {
  AUDIT_SET_ASIDE_DIR,
  AUDIT_SET_ASIDE_MARK,
} from "../../../src/shared/audit-file.js";

let root = "";
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1399-")));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const stateDir = () => {
  const d = path.join(root, "state");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const setAside = (d: string) => {
  fs.mkdirSync(path.join(d, AUDIT_SET_ASIDE_DIR), { recursive: true });
  fs.writeFileSync(
    path.join(d, AUDIT_SET_ASIDE_DIR, AUDIT_SET_ASIDE_MARK),
    JSON.stringify({ at: "2026-11-24T00:00:00.000Z" }),
  );
};
const doctor = (
  d: string,
  installMode: "personal" | "strict",
  running = true,
) =>
  sharedUserLines("Den", {
    stateDir: d,
    registry: path.join(root, "installs"),
    home: root,
    serverRunning: () => running,
    installMode,
    unsandboxed: () => [],
    reposOf: () => [],
  });
const trailCheck = (r: ReturnType<typeof doctor>) =>
  r.checks.find((c) => c.id === "trail_set_aside");
const trailLine = (r: ReturnType<typeof doctor>) =>
  r.lines.find((l) => l.startsWith("  activity trail "));

describe("issue 1399: doctor says whether agents can read the activity trail", () => {
  it("personal, older trail set aside: ok, with nothing to add", () => {
    const d = stateDir();
    setAside(d);
    const r = doctor(d, "personal");
    expect(trailCheck(r)).toEqual({
      id: "trail_set_aside",
      status: "ok",
      detail: "agents can read the activity trail",
    });
    expect(trailLine(r)).toBe(
      "  activity trail  ✓  agents can read the activity trail",
    );
  });

  it("personal, not set aside: a warning that says why and what to do", () => {
    const d = stateDir();
    const r = doctor(d, "personal");
    const c = trailCheck(r);
    expect(c?.status).toBe("warn");
    expect(c?.detail).toBe(
      "agents can't read the activity trail, because the older trail isn't set aside yet. Restart Den; if it fails again, Den's log says why",
    );
    expect(trailLine(r)).toBe(`  activity trail  ⚠  ${c?.detail}`);
  });

  it("personal, not set aside and Den not started yet: ok, as its first start sets it aside", () => {
    const r = doctor(stateDir(), "personal", false);
    expect(trailCheck(r)).toEqual({
      id: "trail_set_aside",
      status: "ok",
      detail:
        "agents read the activity trail once Den sets the older trail aside, at its next start",
    });
    expect(trailLine(r)).toBe(
      "  activity trail  ✓  agents read the activity trail once Den sets the older trail aside, at its next start",
    );
  });

  it("personal, a set-aside folder with no marker still warns", () => {
    const d = stateDir();
    fs.mkdirSync(path.join(d, AUDIT_SET_ASIDE_DIR));
    expect(trailCheck(doctor(d, "personal"))?.status).toBe("warn");
  });

  it("strict: no row, set aside or not", () => {
    const d = stateDir();
    expect(trailCheck(doctor(d, "strict"))).toBeUndefined();
    expect(trailLine(doctor(d, "strict"))).toBeUndefined();
    setAside(d);
    expect(trailCheck(doctor(d, "strict"))).toBeUndefined();
    expect(trailLine(doctor(d, "strict"))).toBeUndefined();
  });
});
