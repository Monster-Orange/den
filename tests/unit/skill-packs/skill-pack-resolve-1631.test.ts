import { afterEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPacks } from "../../../src/shared/skill-packs/pin";
import {
  parseAgentSkillPacks,
  parseSkillPacks,
  resolveAgentPacks,
} from "../../../src/shared/skill-packs/config";
import { buildPluginDir } from "../../../src/shared/skill-packs/build";

const PACKS_DIR = path.resolve(__dirname, "../../../skill-packs");
const packs = readPacks(PACKS_DIR);
const all = () => parseSkillPacks(undefined, "skill_packs", packs);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.chmodSync(d, 0o700);
    for (const f of fs.readdirSync(d, { recursive: true }) as string[])
      fs.chmodSync(path.join(d, f), 0o700);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("issue 1631: the skills an agent gets", () => {
  it("by default: every vendored pstack skill but the ones off by default", () => {
    const got = resolveAgentPacks(all(), undefined, undefined, packs);
    expect(got.map((p) => p.name)).toEqual(["pstack"]);
    const skills = got[0]!.skills;
    expect(skills).toContain("tdd");
    expect(skills).toContain("arena");
    expect(skills).toContain("swarm");
    expect(skills).not.toContain("statechart");
    expect(skills).not.toContain("setup-pstack");
    expect(skills).not.toContain("poteto-mode");
    expect(skills.length).toBe(53);
  });

  it("exclude takes skills out, and a list picks exactly those", () => {
    const ex = parseSkillPacks(
      { pstack: { exclude: ["arena", "swarm"] } },
      "skill_packs",
      packs,
    );
    expect(
      resolveAgentPacks(ex, undefined, undefined, packs)[0]!.skills,
    ).not.toEqual(expect.arrayContaining(["arena"]));
    const list = parseSkillPacks(
      { pstack: { skills: ["tdd", "why", "statechart"] } },
      "skill_packs",
      packs,
    );
    expect(
      resolveAgentPacks(list, undefined, undefined, packs)[0]!.skills,
    ).toEqual(["statechart", "tdd", "why"]);
  });

  it("the agent's setting wins over its persona's, and the persona's over the install's", () => {
    const off = parseAgentSkillPacks("off", "x", packs);
    const on = parseAgentSkillPacks("on", "x", packs);
    expect(resolveAgentPacks(all(), off, undefined, packs)).toEqual([]);
    expect(resolveAgentPacks(all(), undefined, off, packs)).toEqual([]);
    expect(resolveAgentPacks(all(), off, on, packs).map((p) => p.name)).toEqual(
      ["pstack"],
    );
    expect(resolveAgentPacks(all(), on, off, packs)).toEqual([]);
  });

  it("skill_packs.on: false, or the pack's own off, turns it off whatever an agent says", () => {
    const on = parseAgentSkillPacks("on", "x", packs);
    const allOff = parseSkillPacks({ on: false }, "skill_packs", packs);
    expect(resolveAgentPacks(allOff, on, on, packs)).toEqual([]);
    const packOff = parseSkillPacks(
      { pstack: { on: false } },
      "skill_packs",
      packs,
    );
    expect(resolveAgentPacks(packOff, on, on, packs)).toEqual([]);
  });

  it("a skill the pin doesn't have is refused, naming the key, never echoing it", () => {
    const bad = "rm -rf ~ && secret-token-123";
    let msg = "";
    try {
      parseSkillPacks({ pstack: { exclude: [bad] } }, "skill_packs", packs);
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain("skill_packs.pstack.exclude[0]");
    expect(msg).toContain(`${bad.length} characters`);
    expect(msg).not.toContain("secret-token");
    expect(() =>
      parseSkillPacks({ nope: { on: true } }, "skill_packs", packs),
    ).toThrow(/skill_packs\.nope: not a pack Den ships \(pstack\)/);
    expect(() =>
      parseAgentSkillPacks(["pstack", "nope"], "agents.a.skill_packs", packs),
    ).toThrow(/agents\.a\.skill_packs\[1\]/);
    expect(() =>
      parseSkillPacks(
        { pstack: { exclude: Array(201).fill("tdd") } },
        "skill_packs",
        packs,
      ),
    ).toThrow(/at most 200/);
    expect(() => parseSkillPacks({ on: "yes" }, "skill_packs", packs)).toThrow(
      /skill_packs\.on: true or false/,
    );
  });
});

describe("issue 1631: the plugin folder Den builds for a set", () => {
  it("holds exactly the chosen skills, with the licence and the notice, read-only", () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-build-"));
    dirs.push(cache);
    const pin = packs.pstack!;
    const dir = buildPluginDir(PACKS_DIR, cache, "pstack", pin, ["tdd", "why"]);
    expect(fs.readdirSync(path.join(dir, "skills")).sort()).toEqual([
      "tdd",
      "why",
    ]);
    for (const f of [
      "LICENSE",
      "DEN-NOTICE.md",
      ".claude-plugin/plugin.json",
      "docs/harness/claude-code.md",
      "agents/comment-sicko.md",
    ])
      expect([f, fs.existsSync(path.join(dir, f))]).toEqual([f, true]);
    expect(
      fs.statSync(path.join(dir, "skills/tdd/SKILL.md")).mode & 0o222,
    ).toBe(0);
    expect(
      dir.startsWith(path.join(cache, `pstack@${pin.commit.slice(0, 12)}`)),
    ).toBe(true);
  });

  it("the same set reuses the same folder; another set gets its own", () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-build-"));
    dirs.push(cache);
    const pin = packs.pstack!;
    const a = buildPluginDir(PACKS_DIR, cache, "pstack", pin, ["why", "tdd"]);
    const mtime = fs.statSync(path.join(a, "skills/tdd/SKILL.md")).mtimeMs;
    const b = buildPluginDir(PACKS_DIR, cache, "pstack", pin, ["tdd", "why"]);
    expect(b).toBe(a);
    expect(fs.statSync(path.join(b, "skills/tdd/SKILL.md")).mtimeMs).toBe(
      mtime,
    );
    const c = buildPluginDir(PACKS_DIR, cache, "pstack", pin, ["tdd"]);
    expect(c).not.toBe(a);
  });

  it("refuses to build from a copy that doesn't match its pin", () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-build-"));
    dirs.push(cache);
    const pin = { ...packs.pstack!, files: { ...packs.pstack!.files } };
    pin.files["skills/tdd/SKILL.md"] = "sha256-00";
    expect(() =>
      buildPluginDir(PACKS_DIR, cache, "pstack", pin, ["tdd"]),
    ).toThrow(/skills\/tdd\/SKILL\.md: its hash isn't the pin's/);
  });
});
