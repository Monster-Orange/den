import { describe, it, expect } from "@jest/globals";

import { envFromTitle } from "../../../src/ui/server/release-service.js";

/**
 * This decides whether a Deploy button is blocked, so a wrong answer is either
 * a lost deploy (false positive) or two runs racing into one environment (false
 * negative). GitHub exposes no environment on a run, so the display title —
 * produced by the workflow's `run-name:` — is the only signal available.
 */
describe("envFromTitle — best-effort environment from a run's display title", () => {
  const ENVS = ["dev", "sandbox", "staging", "prod"];

  it("reads the environment repos that set a run-name emit", () => {
    expect(envFromTitle("[wf-dispatch] main → sandbox", ENVS)).toBe("sandbox");
    expect(envFromTitle("[main-merge] main → staging", ENVS)).toBe("staging");
    expect(envFromTitle("[wf-dispatch] feat/some-branch → prod", ENVS)).toBe(
      "prod",
    );
  });

  it("returns null for repos with no run-name", () => {
    // billing-api and tokens show the bare workflow name…
    expect(envFromTitle("CD", ENVS)).toBeNull();
    // …and push-triggered runs show the commit subject.
    expect(
      envFromTitle("feat(admin): relocate artifacts across the fleet", ENVS),
    ).toBeNull();
  });

  it("rejects an arrow suffix that is not a configured environment", () => {
    // Guards against a branch or commit subject that happens to contain an
    // arrow being read as an environment and silently un-blocking a deploy.
    expect(envFromTitle("[wf-dispatch] main → notanenv", ENVS)).toBeNull();
    expect(envFromTitle("fix: map a → b in the parser", ENVS)).toBeNull();
    expect(envFromTitle("chore: bump x → y", ENVS)).toBeNull();
  });

  it("matches case-insensitively and normalises to lower case", () => {
    expect(envFromTitle("[wf-dispatch] main → PROD", ENVS)).toBe("prod");
    expect(envFromTitle("[wf-dispatch] main → Sandbox", ENVS)).toBe("sandbox");
  });

  it("tolerates trailing whitespace and missing/empty titles", () => {
    expect(envFromTitle("[wf-dispatch] main → dev   ", ENVS)).toBe("dev");
    expect(envFromTitle("", ENVS)).toBeNull();
    expect(envFromTitle(null, ENVS)).toBeNull();
    expect(envFromTitle(undefined, ENVS)).toBeNull();
  });

  it("returns null when no environments are configured", () => {
    // Nothing to validate against — must not guess.
    expect(envFromTitle("[wf-dispatch] main → sandbox", [])).toBeNull();
  });

  it("only reads the LAST arrow, so a multi-arrow title can't be spoofed", () => {
    expect(envFromTitle("prod → main → dev", ENVS)).toBe("dev");
  });
});
