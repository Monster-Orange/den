import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LAUNCH_FILE,
  launchFileProblems,
  readAgentLaunch,
  writeAgentLaunch,
  type AgentLaunchSpec,
} from "../../../src/shared/agents/os-user-launch-files.js";

let agents: string;
const me = process.getuid!();
beforeEach(() => {
  agents = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d988lf-")));
  fs.chownSync(agents, me, process.getgid!());
  fs.chmodSync(agents, 0o2750);
});
afterEach(() => fs.rmSync(agents, { recursive: true, force: true }));

const spec: AgentLaunchSpec = {
  agentId: "scout",
  argv: ["/usr/local/bin/claude", "--resume", "abc"],
  cwd: "/work/north",
  env: { DEN_AGENT: "agent:scout", LANG: "C.UTF-8" },
};
const mode = (p: string) => fs.lstatSync(p).mode & 0o777;

describe("issue 988: Den writes an agent's launch files", () => {
  it("the folder 2750, launch.json 0640, own/ 2770; read back as written", () => {
    writeAgentLaunch(agents, spec);
    const dir = path.join(agents, "scout");
    expect(mode(dir)).toBe(0o750);
    expect(mode(path.join(dir, LAUNCH_FILE))).toBe(0o640);
    expect(mode(path.join(dir, "own"))).toBe(0o770);
    expect(launchFileProblems(agents, "scout", me)).toEqual([]);
    expect(readAgentLaunch(agents, "scout", me)).toEqual(spec);
  });

  it("a second write replaces the file whole and keeps the modes; own/ is kept", () => {
    writeAgentLaunch(agents, spec);
    fs.writeFileSync(
      path.join(agents, "scout", "own", "handoff.md"),
      "notes\n",
    );
    writeAgentLaunch(agents, { ...spec, argv: ["/usr/local/bin/claude"] });
    expect(readAgentLaunch(agents, "scout", me).argv).toEqual([
      "/usr/local/bin/claude",
    ]);
    expect(mode(path.join(agents, "scout", LAUNCH_FILE))).toBe(0o640);
    expect(
      fs.readFileSync(path.join(agents, "scout", "own", "handoff.md"), "utf8"),
    ).toBe("notes\n");
    expect(fs.readdirSync(path.join(agents, "scout")).sort()).toEqual([
      LAUNCH_FILE,
      "own",
    ]);
  });

  it("never a secret: an env name like a token's, or a bad spec, is refused before anything is written", () => {
    for (const bad of [
      { ...spec, env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } },
      { ...spec, env: { DEN_ACTOR_TOKEN: "x" } },
      { ...spec, env: { SOME_SECRET: "x" } },
      { ...spec, env: { "A=B": "x" } },
      { ...spec, agentId: "../x" },
      { ...spec, argv: [] },
      { ...spec, cwd: "work" },
    ] as AgentLaunchSpec[])
      expect(() => writeAgentLaunch(agents, bad)).toThrow();
    expect(fs.readdirSync(agents)).toEqual([]);
  });

  it("a link where the agent's folder or launch.json should be: refused, nothing written through it", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "d988x-"));
    try {
      fs.symlinkSync(elsewhere, path.join(agents, "scout"));
      expect(() => writeAgentLaunch(agents, spec)).toThrow(/link/);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("issue 988: doctor and agents session check them", () => {
  it("names a group-writable folder or file, one not the person's, or a link; reading refuses then", () => {
    writeAgentLaunch(agents, spec);
    const dir = path.join(agents, "scout");
    fs.chmodSync(path.join(dir, LAUNCH_FILE), 0o660);
    expect(launchFileProblems(agents, "scout", me)).toEqual([
      expect.stringMatching(/launch\.json.*0660.*0640/),
    ]);
    expect(() => readAgentLaunch(agents, "scout", me)).toThrow(/0660/);
    fs.chmodSync(path.join(dir, LAUNCH_FILE), 0o640);
    fs.chmodSync(dir, 0o2770);
    expect(launchFileProblems(agents, "scout", me)).toEqual([
      expect.stringMatching(/scout is 0770; it must be 0750/),
    ]);
    fs.chmodSync(dir, 0o2750);
    expect(launchFileProblems(agents, "scout", me + 1).join("\n")).toMatch(
      /not the person's/,
    );
  });

  it("an extra file in the agent's folder is named (nothing but launch.json and own/)", () => {
    writeAgentLaunch(agents, spec);
    fs.chmodSync(path.join(agents, "scout"), 0o2770);
    fs.writeFileSync(path.join(agents, "scout", "planted.json"), "{}");
    fs.chmodSync(path.join(agents, "scout"), 0o2750);
    expect(launchFileProblems(agents, "scout", me).join("\n")).toMatch(
      /planted\.json/,
    );
  });

  it("missing: says so", () => {
    expect(launchFileProblems(agents, "scout", me)).toEqual([
      expect.stringMatching(/no launch files/),
    ]);
  });
});
