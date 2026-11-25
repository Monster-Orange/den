import { afterEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hashFile,
  readPacks,
  verifyPack,
  type PackPin,
} from "../../../src/shared/skill-packs/pin";

const ROOT = path.resolve(__dirname, "../../..");
const PACKS = path.join(ROOT, "skill-packs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("issue 1631: the vendored pstack pack matches its pin", () => {
  const packs = readPacks(PACKS);
  const pin = packs.pstack as PackPin;

  it("pins one commit of the open-source pack, under MIT", () => {
    expect(pin.source).toBe("https://github.com/cursor/plugins");
    expect(pin.path).toBe("pstack");
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.license).toBe("MIT");
    expect(pin.copyright).toBe("Copyright (c) 2026 Lauren Tan");
  });

  it("every vendored file is listed with its hash, and nothing else", () => {
    expect(verifyPack(path.join(PACKS, "pstack"), pin)).toEqual([]);
    expect(Object.keys(pin.files).length).toBeGreaterThan(50);
  });

  it("keeps upstream's MIT licence beside the files", () => {
    const text = fs.readFileSync(path.join(PACKS, "pstack", "LICENSE"), "utf8");
    expect(text.startsWith("MIT License")).toBe(true);
    expect(text).toContain(pin.copyright);
  });

  it("leaves out the files that merge, force-push, poll, write outside, or download", () => {
    const gone = [
      "skills/setup-pstack",
      "skills/automate-me",
      "automations",
      "skills/statechart/scripts/test",
      "skills/statechart/references/render.md",
      "skills/poteto-mode/playbooks/shipping.md",
      "skills/poteto-mode/playbooks/babysit.md",
      "skills/poteto-mode/playbooks/autopilot-full.md",
      "skills/poteto-mode/scripts/watch-pr",
      "assets",
      "docs/guide/images",
      "docs/guide/01-setup.md",
      "skills/make-bot-ui",
      ".gitignore",
      ".cursor-plugin",
    ];
    for (const g of gone)
      expect([g, fs.existsSync(path.join(PACKS, "pstack", g))]).toEqual([
        g,
        false,
      ]);
    for (const g of gone)
      expect(
        Object.keys(pin.files).some((f) => f === g || f.startsWith(`${g}/`)),
      ).toBe(false);
    expect(pin.exclude.map((x) => x.path).sort()).toEqual([...gone].sort());
  });

  it("statechart's copy never downloads its tools", () => {
    const run = fs.readFileSync(
      path.join(PACKS, "pstack", "skills/statechart/scripts/run.ts"),
      "utf8",
    );
    expect(run).not.toMatch(/\bmise\b/);
    expect(run).not.toMatch(/releases\/download/);
  });

  it("is a Claude Code plugin named pstack, at the pinned commit", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(PACKS, "pstack", ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    );
    expect(manifest.name).toBe("pstack");
    expect(manifest.version).toMatch(
      new RegExp(`^\\d+\\.\\d+\\.\\d+\\+${pin.commit.slice(0, 12)}$`),
    );
  });

  it("is named in THIRD_PARTY_NOTICES at the same commit, and ships in the package", () => {
    const notices = fs.readFileSync(
      path.join(ROOT, "THIRD_PARTY_NOTICES"),
      "utf8",
    );
    expect(notices).toContain(
      "pstack\nhttps://github.com/cursor/plugins/tree/",
    );
    expect(notices).toContain(pin.copyright);
    expect(notices).toContain(`Taken from commit ${pin.commit}`);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    );
    expect(pkg.files).toContain("skill-packs/");
  });
});

describe("issue 1631: verifyPack refuses a tampered copy", () => {
  function fakePack(): { dir: string; pin: PackPin } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1631-pack-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "skills", "one"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "LICENSE"),
      "MIT License\n\nCopyright (c) 2026 Someone\n",
    );
    fs.writeFileSync(path.join(dir, "skills", "one", "SKILL.md"), "# one\n");
    const files: Record<string, string> = {};
    for (const f of ["LICENSE", "skills/one/SKILL.md"])
      files[f] = hashFile(path.join(dir, f));
    return {
      dir,
      pin: {
        source: "https://example.test/pack",
        path: "pack",
        commit: "a".repeat(40),
        license: "MIT",
        copyright: "Copyright (c) 2026 Someone",
        exclude: [],
        patches: {},
        default_off: [],
        files,
      },
    };
  }

  it("an untouched copy passes", () => {
    const { dir, pin } = fakePack();
    expect(verifyPack(dir, pin)).toEqual([]);
  });

  it("one changed byte names that file", () => {
    const { dir, pin } = fakePack();
    fs.writeFileSync(path.join(dir, "skills", "one", "SKILL.md"), "# One\n");
    expect(verifyPack(dir, pin)).toEqual([
      "skills/one/SKILL.md: its hash isn't the pin's",
    ]);
  });

  it("a file the pin doesn't list is refused", () => {
    const { dir, pin } = fakePack();
    fs.writeFileSync(path.join(dir, "skills", "one", "extra.md"), "x\n");
    expect(verifyPack(dir, pin)).toEqual([
      "skills/one/extra.md: not in the pin",
    ]);
  });

  it("a listed file that's missing is refused", () => {
    const { dir, pin } = fakePack();
    fs.rmSync(path.join(dir, "skills", "one", "SKILL.md"));
    expect(verifyPack(dir, pin)).toEqual(["skills/one/SKILL.md: missing"]);
  });

  it("a missing licence, or one that isn't MIT, is refused", () => {
    const a = fakePack();
    fs.rmSync(path.join(a.dir, "LICENSE"));
    expect(verifyPack(a.dir, a.pin)).toContain("LICENSE: missing");
    const b = fakePack();
    fs.writeFileSync(path.join(b.dir, "LICENSE"), "All rights reserved\n");
    b.pin.files.LICENSE = hashFile(path.join(b.dir, "LICENSE"));
    expect(verifyPack(b.dir, b.pin)).toEqual([
      "LICENSE: not the MIT licence with the pin's copyright",
    ]);
  });
});
