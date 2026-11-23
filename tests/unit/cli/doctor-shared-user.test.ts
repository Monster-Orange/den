/**
 * Issue 728 (part C): doctor says whether other installs share this OS
 * account, whether this install is in the install registry (so their agents
 * are denied its files), and which 0600 files in its state folder agents'
 * deny rules don't cover. Paths only: never a file's contents, and never
 * another install's path.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sharedUserLines } from "../../../src/ui/cli/doctor-command.js";
import { registerInstall } from "../../../src/shared/install-registry.js";

let root = "";
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-dsu-")));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const SECRET = "SECRET_VALUE_NEVER_SHOWN";
const put = (dir: string, rel: string, mode = 0o600) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, SECRET + "\n", { mode });
  fs.chmodSync(f, mode);
};
const install = (name: string) => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { mode: 0o700 });
  fs.chmodSync(d, 0o700);
  put(d, "web.secret");
  return d;
};
const reg = () => path.join(root, "installs");
const rows = (stateDir: string) =>
  sharedUserLines("Den", { stateDir, registry: reg(), home: root });
const check = (r: ReturnType<typeof rows>, id: string) =>
  r.checks.find((c) => c.id === id)!;

describe("issue 728: doctor's same-login rows", () => {
  it("alone and registered: every row ok", () => {
    const own = install("own");
    registerInstall(reg(), { stateDir: own, edgeKeyDirs: [] });
    const r = rows(own);
    expect(check(r, "shared_user").status).toBe("ok");
    expect(check(r, "install_registry").status).toBe("ok");
    expect(check(r, "uncovered_files").status).toBe("ok");
  });

  it("another install on this login: a warning with how many, never its path", () => {
    const own = install("own");
    const other = install("other-install");
    registerInstall(reg(), { stateDir: own, edgeKeyDirs: [] });
    registerInstall(reg(), { stateDir: other, edgeKeyDirs: [] });
    const r = rows(own);
    const s = check(r, "shared_user");
    expect(s.status).toBe("warn");
    expect(s.detail).toMatch(/1 other install runs as this login on this computer/);
    expect(r.lines.join("\n")).not.toContain("other-install");
  });

  it("this install not in the registry: a warning that it registers at its next start", () => {
    const own = install("own");
    const s = check(rows(own), "install_registry");
    expect(s.status).toBe("warn");
    expect(s.detail).toMatch(/next start/);
  });

  it("a 0600 file the deny rules don't cover: named by its path in the state folder, never read", () => {
    const own = install("own");
    registerInstall(reg(), { stateDir: own, edgeKeyDirs: [] });
    put(own, "actor-tokens.json");
    put(own, "hub/token");
    put(own, "sessions/abc");
    put(own, "plugins/thing/key.pem");
    put(own, "agent-files/planner/settings.json", 0o644);
    const r = rows(own);
    const s = check(r, "uncovered_files");
    expect(s.status).toBe("warn");
    expect(s.detail).toContain("plugins/thing/key.pem");
    expect(s.detail).not.toMatch(
      /actor-tokens|hub\/token|sessions|web\.secret/,
    );
    expect(s.detail).not.toContain("settings.json");
    expect(r.lines.join("\n")).not.toContain(SECRET);
  });

  it("a symlink in the state folder is never followed", () => {
    const own = install("own");
    registerInstall(reg(), { stateDir: own, edgeKeyDirs: [] });
    const outside = path.join(root, "outside");
    put(outside, "loose.key");
    fs.symlinkSync(outside, path.join(own, "linked"));
    expect(check(rows(own), "uncovered_files").status).toBe("ok");
  });

  it("many uncovered files: the first few, and how many more", () => {
    const own = install("own");
    registerInstall(reg(), { stateDir: own, edgeKeyDirs: [] });
    for (let i = 0; i < 15; i++)
      put(own, `loose/k${String(i).padStart(2, "0")}`);
    const s = check(rows(own), "uncovered_files");
    expect(s.detail).toContain("loose/k00");
    expect(s.detail).toMatch(/and 5 more/);
  });
});
