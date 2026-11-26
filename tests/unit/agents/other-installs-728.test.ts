/**
 * Issue 728: an agent's start denies it the other installs on its OS user
 * (from the install registry): their state folders' credential files and
 * their edge keys, and the registry itself. This install registers itself
 * on the way; its own workspace stays readable.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { registerInstall } from "../../../src/shared/install-registry.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { denied, readDenied } from "./helpers/claude-rules.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

let tmp: string;
let reg: string;
let saved: string | undefined;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "other-inst-")));
  reg = path.join(tmp, "installs");
  saved = process.env.DEN_INSTALLS_DIR;
  process.env.DEN_INSTALLS_DIR = reg;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.DEN_INSTALLS_DIR;
  else process.env.DEN_INSTALLS_DIR = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
  await cleanupRigs();
});

const deny = (r: Rig): string[] =>
  (
    JSON.parse(
      fs.readFileSync(
        path.join(r.stateDir, "agent-files", "planner", "settings.json"),
        "utf-8",
      ),
    ) as { permissions: { deny: string[] } }
  ).permissions.deny;

describe("issue 728: other installs on this OS user", () => {
  it("an agent's start denies another install's credential files and edge keys, and the registry", async () => {
    const other = path.join(tmp, "other-state");
    fs.mkdirSync(other, { mode: 0o700 });
    fs.chmodSync(other, 0o700);
    fs.writeFileSync(path.join(other, "web.secret"), "x", { mode: 0o600 });
    const otherCa = path.join(tmp, "other-edge", "ca");
    fs.mkdirSync(otherCa, { recursive: true });
    registerInstall(reg, { stateDir: other, edgeKeyDirs: [otherCa] });

    const r = await rig();
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    const d = deny(r);
    for (const f of [
      path.join(other, "web.secret"),
      path.join(other, "actor-tokens.json"),
      path.join(other, "hub", "token"),
      path.join(otherCa, "rootCA-key.pem"),
      path.join(reg, "0123456789abcdef.json"),
    ])
      expect([f, readDenied(d, f)]).toEqual([f, true]);
    expect(denied(d, `cat ${path.join(other, "web.secret")}`)).toBe(true);
    // Its own workspace stays readable.
    expect(readDenied(d, path.join(r.dir, "README.md"))).toBe(false);
    // And this install is in the registry now, for the others' agents.
    const entries = fs.readdirSync(reg).map(
      (n) =>
        (
          JSON.parse(fs.readFileSync(path.join(reg, n), "utf-8")) as {
            stateDir: string;
          }
        ).stateDir,
    );
    expect(entries).toContain(fs.realpathSync(r.stateDir));
  });
});
