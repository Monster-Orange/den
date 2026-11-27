import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

type ConfigCmd = typeof import("../../../src/ui/cli/config-command.js");

let root = "";
const savedRoot = process.env.DEN_ROOT;
let cli: ConfigCmd;
const userFile = () => path.join(root, "config", "local", "user.yml");
const user = () =>
  (yaml.parse(fs.readFileSync(userFile(), "utf8")) ?? {}) as Record<
    string,
    unknown
  >;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1631c-")));
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nskill_packs:\n  pstack:\n    exclude: [why]\n",
  );
  fs.writeFileSync(userFile(), "{}\n");
  process.env.DEN_ROOT = root;
  cli = await import("../../../src/ui/cli/config-command.js");
});
afterAll(() => {
  if (savedRoot === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function run(
  ...args: string[]
): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    await cli.cmdConfig(args);
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out, err };
}

describe("issue 1631: den config and the skill_packs keys", () => {
  it("reads a key's value in force: the last line on stdout, where it came from on stderr", async () => {
    const on = await run("skill_packs.pstack.on");
    expect(on.out.at(-1)).toBe("true");
    expect(on.err.join("\n")).toContain("Den's default");
    const ex = await run("skill_packs.pstack.exclude");
    expect(ex.out.at(-1)).toBe("why");
    expect(ex.err.join("\n")).toContain("from den.yml");
  });

  it("writes and removes each key in user.yml, checked as Den reads it", async () => {
    await run("skill_packs.pstack.on=false");
    expect(user()).toEqual({ skill_packs: { pstack: { on: false } } });
    expect((await run("skill_packs.pstack.on")).out.at(-1)).toBe("false");
    expect((await run("skill_packs.pstack.on")).err.join("\n")).toContain(
      "from user.yml",
    );
    await run("skill_packs.pstack.exclude=[tdd, why]");
    await run("agents.lane-1.skill_packs=off");
    expect(user()).toEqual({
      skill_packs: { pstack: { on: false, exclude: ["tdd", "why"] } },
      agents: { "lane-1": { skill_packs: "off" } },
    });
    await run("rm", "skill_packs.pstack.on");
    await run("rm", "skill_packs.pstack.exclude");
    expect(user()).toEqual({ agents: { "lane-1": { skill_packs: "off" } } });
  });

  it("refuses an unknown skill without echoing it, and leaves user.yml as it was", async () => {
    const was = fs.readFileSync(userFile(), "utf8");
    await expect(
      run("skill_packs.pstack.skills=[no-such-skill-xyz]"),
    ).rejects.toThrow(/skills in pstack's pin/);
    await expect(
      run("skill_packs.pstack.skills=[no-such-skill-xyz]"),
    ).rejects.not.toThrow(/no-such-skill-xyz/);
    expect(fs.readFileSync(userFile(), "utf8")).toBe(was);
  });

  it("`config skill_packs` prints the packs, their pins, the skills on, and the agents with packs off", async () => {
    const r = await run("skill_packs");
    const text = r.out.join("\n");
    expect(text).toContain("pstack");
    expect(text).toContain("41e4009");
    expect(text).toContain("MIT");
    expect(text).toMatch(/skills on: \d+ of \d+/);
    expect(text).toMatch(/lane-1.*the agent/);
  });
});
