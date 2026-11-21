/**
 * Review M4 (0.4.46): a Claude Code agent is denied editing the person's
 * own config (config/local/: user.yml, where self_update and the person's
 * settings live). It binds a cooperating agent only, as the state-dir
 * rules do: the server's token rules are the boundary. The team file
 * stays editable (the server agent's job may include it).
 */
import { describe, expect, it } from "@jest/globals";
import { personConfigDenyRules } from "../../../src/shared/agents/den-claude.js";

describe("the person's config folder is denied to agents' edits", () => {
  it("Edit on everything under config/local, as an absolute path (Edit covers writes, issue 660)", () => {
    const rules = personConfigDenyRules("/home/someone/acme/config/local");
    expect(rules).toEqual(["Edit(//home/someone/acme/config/local/**)"]);
    expect(rules.some((r) => /den\.yml|acme\.yml/.test(r))).toBe(false);
  });
});

describe("issue 810: the distribution config (the test-install mark) is denied too", () => {
  it("Edit on the distribution config file when it is named", () => {
    const rules = personConfigDenyRules(
      "/home/someone/acme/config/local",
      "/home/someone/acme/config/den.yml",
    );
    expect(rules.filter((r) => r.startsWith("Edit("))).toEqual([
      "Edit(//home/someone/acme/config/local/**)",
      "Edit(//home/someone/acme/config/den.yml)",
    ]);
  });
});

describe("issue 810 hardening: a shell command naming the distribution config is denied too", () => {
  it("Bash(*<path>*) in every spelling, as the state-dir rules", () => {
    const rules = personConfigDenyRules(
      "/home/someone/acme/config/local",
      "/home/someone/acme/config/den.yml",
      "/home/someone",
    );
    for (const spelling of [
      "/home/someone/acme/config/den.yml",
      "~/acme/config/den.yml",
      "$HOME/acme/config/den.yml",
      "${HOME}/acme/config/den.yml",
    ])
      expect(rules).toContain(`Bash(*${spelling}*)`);
    // Never the person's own folder by Bash (its writes are Edit-denied).
    expect(
      rules.some((r) => r.startsWith("Bash(") && /config\/local/.test(r)),
    ).toBe(false);
  });
});
