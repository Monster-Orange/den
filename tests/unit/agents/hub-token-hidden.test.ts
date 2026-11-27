import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentSandboxPolicy,
  bwrapArgs,
  macProfile,
  type SandboxPolicy,
} from "../../../src/shared/agents/sandbox.js";
import { agentSandboxInput } from "../../../src/ui/cli/agent-ops.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hth-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const stateDir = path.join(tmp, "state");
const distRoot = path.join(tmp, "dist");
const hub = path.join(stateDir, "hub");
const SECRET = "hub-secret-value";
const files = {
  old: path.join(hub, "token"),
  slot: path.join(hub, "token-0a1b2c3d4e"),
  agent: path.join(hub, "agents", "a2.json"),
  unrevoked: path.join(hub, "unrevoked", "x1.token"),
};
for (const d of [
  path.join(stateDir, "agent-files", "a1"),
  path.join(hub, "agents"),
  path.join(hub, "unrevoked"),
  distRoot,
])
  fs.mkdirSync(d, { recursive: true });
for (const f of Object.values(files)) fs.writeFileSync(f, `${SECRET}\n`);
fs.writeFileSync(path.join(hub, "bound.json"), "{}\n");

const policyReadingHubFolder = (): SandboxPolicy => {
  const p = agentSandboxPolicy(
    agentSandboxInput({
      stateDir,
      distRoot,
      env: { HOME: tmp, PATH: "/usr/bin:/bin" },
      agentId: "a1",
      home: tmp,
    }),
  );
  return { ...p, readable: [...p.readable, hub] };
};

describe("the session's hidden-file list covers each Hub token file", () => {
  it("Linux: each Hub token file is masked even when its folder is read back", () => {
    const a = bwrapArgs(policyReadingHubFolder(), fs.existsSync, (f) => f).join(
      " ",
    );
    expect(a).toContain(`--ro-bind /dev/null ${files.old}`);
    expect(a).toContain(`--ro-bind /dev/null ${files.slot}`);
    expect(a).toContain(`--tmpfs ${path.join(hub, "agents")}`);
    expect(a).toContain(`--tmpfs ${path.join(hub, "unrevoked")}`);
    const last = (s: string) => a.lastIndexOf(s);
    expect(last(`--ro-bind /dev/null ${files.slot}`)).toBeGreaterThan(
      last(`--ro-bind ${hub} ${hub}`),
    );
  });

  it("Linux: a hidden file under a folder the session reads (agents/) is masked after its read-back", () => {
    const agents = path.join(stateDir, "agents");
    const planted = path.join(agents, "planted.secret");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(planted, `${SECRET}\n`);
    const base = policyReadingHubFolder();
    expect(base.readable).toContain(agents);
    const a = bwrapArgs(
      { ...base, hidden: [...base.hidden, planted] },
      fs.existsSync,
      (f) => f,
    ).join(" ");
    expect(a.lastIndexOf(`--ro-bind /dev/null ${planted}`)).toBeGreaterThan(
      a.lastIndexOf(`--ro-bind ${agents} ${agents}`),
    );
  });

  const onMac =
    process.platform === "darwin" &&
    spawnSync("sandbox-exec", [
      "-p",
      "(version 1)(allow default)",
      "/usr/bin/true",
    ]).status === 0
      ? it
      : it.skip;

  onMac(
    "macOS: a sandboxed read of any Hub token file is refused, a slot made after start too",
    () => {
      const prof = macProfile(policyReadingHubFolder());
      const later = path.join(hub, "token-ffffffffff");
      fs.writeFileSync(later, `${SECRET}\n`);
      const cat = (f: string) =>
        spawnSync("sandbox-exec", ["-p", prof, "/bin/cat", f], {
          encoding: "utf8",
        });
      for (const f of [...Object.values(files), later]) {
        const r = cat(f);
        expect([f, r.stdout]).toEqual([f, expect.not.stringContaining(SECRET)]);
      }
      expect(cat(path.join(hub, "bound.json")).stdout).toContain("{}");
    },
  );
});
