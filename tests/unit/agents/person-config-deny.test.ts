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
  it("Edit and Write on everything under config/local, as an absolute path", () => {
    const rules = personConfigDenyRules("/home/someone/acme/config/local");
    expect(rules).toEqual(
      expect.arrayContaining([
        "Edit(//home/someone/acme/config/local/**)",
        "Write(//home/someone/acme/config/local/**)",
      ]),
    );
    expect(rules.some((r) => /den\.yml|acme\.yml/.test(r))).toBe(false);
  });
});
