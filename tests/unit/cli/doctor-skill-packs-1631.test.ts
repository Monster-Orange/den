import { afterEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  packsOffWhy,
  skillPackLines,
} from "../../../src/ui/cli/doctor-skill-packs";
import { readSkillPacksConfig } from "../../../src/shared/skill-packs/launch";
import { readPacks } from "../../../src/shared/skill-packs/pin";

const PACKS_DIR = path.resolve(__dirname, "../../../skill-packs");
const packs = readPacks(PACKS_DIR);
const install = (den?: unknown) => readSkillPacksConfig(den, undefined, packs);

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-doctor-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function copyPacks(): string {
  const d = tmp();
  fs.cpSync(PACKS_DIR, d, { recursive: true });
  return d;
}

const run = (over: Parameters<typeof skillPackLines>[1] = {}) =>
  skillPackLines("Den", {
    packsDir: PACKS_DIR,
    install: () => install(),
    agents: () => [],
    claudeConfigDir: tmp(),
    ...over,
  });

const check = (r: ReturnType<typeof run>, id: string) =>
  r.checks.find((c) => c.id === id);

describe("issue 1631: Doctor's skill-pack lines", () => {
  it("the installed pack passes its tamper check: hashes, no unlisted file, the MIT licence", () => {
    const r = run();
    const c = check(r, "skill-packs:pack:pstack");
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("41e4009");
    expect(c?.detail).toContain("MIT");
    expect(r.lines.join("\n")).toContain("doctor: Skill packs");
  });

  it("a changed byte, an unlisted file or a missing LICENSE fails the pack's row", () => {
    const changed = copyPacks();
    fs.appendFileSync(path.join(changed, "pstack/skills/tdd/SKILL.md"), "x");
    expect(
      check(run({ packsDir: changed }), "skill-packs:pack:pstack"),
    ).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("skills/tdd/SKILL.md"),
    });
    const extra = copyPacks();
    fs.writeFileSync(path.join(extra, "pstack/skills/tdd/extra.md"), "x");
    expect(
      check(run({ packsDir: extra }), "skill-packs:pack:pstack")?.detail,
    ).toContain("not in the pin");
    const noLicence = copyPacks();
    fs.rmSync(path.join(noLicence, "pstack/LICENSE"));
    expect(
      check(run({ packsDir: noLicence }), "skill-packs:pack:pstack")?.detail,
    ).toContain("LICENSE");
  });

  it("says Den's own copy is in use, or the person's own plugin when they installed one", () => {
    expect(check(run(), "skill-packs:copy:pstack")?.detail).toContain(
      "Den's own copy",
    );
    const cfg = tmp();
    fs.mkdirSync(path.join(cfg, "plugins"));
    fs.writeFileSync(
      path.join(cfg, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "pstack@somewhere": [{}] } }),
    );
    const r = run({ claudeConfigDir: cfg });
    expect(check(r, "skill-packs:copy:pstack")?.detail).toContain(
      "your own pstack plugin",
    );
    expect(check(r, "skill-packs:copy:pstack")?.status).toBe("ok");
  });

  it("lists each agent with packs off and why: the agent, its persona or the install", () => {
    const r = run({
      agents: () => [
        { id: "a1", workspace: "w", persona: undefined, agent: "off" },
        { id: "a2", workspace: "w", persona: "off", agent: undefined },
        { id: "a3", workspace: "w", persona: undefined, agent: undefined },
        { id: "a4", workspace: "w", persona: "off", agent: "on" },
      ],
    });
    const text = r.lines.join("\n");
    expect(text).toMatch(/w\/a1.*off.*the agent/);
    expect(text).toMatch(/w\/a2.*off.*its persona/);
    expect(text).not.toContain("w/a3");
    expect(text).not.toContain("w/a4");
    expect(check(r, "skill-packs:off:w/a1")?.detail).toContain("the agent");
    expect(check(r, "skill-packs:off:w/a2")?.detail).toContain("its persona");
    const all = run({
      install: () => install({ on: false }),
      agents: () => [
        { id: "a3", workspace: "w", persona: undefined, agent: undefined },
      ],
    });
    expect(check(all, "skill-packs:off:w/a3")?.detail).toContain("the install");
  });

  it("packsOffWhy follows the same precedence as the launch", () => {
    expect(packsOffWhy(install(), undefined, undefined, packs)).toBeNull();
    expect(packsOffWhy(install(), undefined, "off", packs)).toBe("agent");
    expect(packsOffWhy(install(), "off", undefined, packs)).toBe("persona");
    expect(packsOffWhy(install(), "off", "on", packs)).toBeNull();
    expect(packsOffWhy(install({ on: false }), undefined, "on", packs)).toBe(
      "install",
    );
    expect(
      packsOffWhy(
        install({ pstack: { on: false } }),
        undefined,
        undefined,
        packs,
      ),
    ).toBe("install");
  });

  it("an unreadable pin is a failed row, never a crash", () => {
    const r = run({ packsDir: tmp() });
    expect(r.checks[0]).toMatchObject({ id: "skill-packs", status: "fail" });
  });
});
