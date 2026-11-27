import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "@jest/globals";
import { policyFor } from "../../../src/shared/approval-policy.js";
import { CRITICAL_HELD_ACTIONS } from "../../../src/ui/server/held-actions.js";
import {
  envAllowKeepOp,
  heldUnion,
  wouldHold,
} from "../../../src/shared/agents/env-hold-rollout.js";
import { checkEnvHoldConfig } from "../../../src/shared/agents/env-hold.js";

describe("Keep these and Remove wait for the person", () => {
  it.each(["den_env_hold_on", "den_env_allow_keep"])(
    "%s: under the default policy and under auto, it asks",
    (action) => {
      expect(CRITICAL_HELD_ACTIONS.has(action)).toBe(true);
      expect(policyFor(action, {}).kind).toBe("ask");
      const loose = { policy: "auto", writes: { [action]: "auto" } } as const;
      expect(policyFor(action, { install: loose, project: loose }).kind).toBe(
        "ask",
      );
    },
  );
});

describe("the Keep list never offers a person's credential", () => {
  const present = ["DEN_PERSON_TOKEN", "DEN_TEST_PERSON", "GH_TOKEN"];
  const rows = wouldHold([{ id: "old" }], checkEnvHoldConfig({}), present);

  it("rows and the bell's names leave them out", () => {
    expect(heldUnion(rows)).toEqual(["GH_TOKEN"]);
  });

  it("den_env_allow_keep refuses them", () => {
    const op = envAllowKeepOp({
      rows: () => [{ id: "old", names: ["GH_TOKEN", "DEN_PERSON_TOKEN"] }],
      turnOn: () => undefined,
      keep: () => undefined,
    });
    for (const n of ["DEN_PERSON_TOKEN", "DEN_TEST_PERSON"]) {
      const c = op.check({ names: [n] });
      expect(c.ok).toBe(false);
      expect(!c.ok && c.error).toMatch(/a person's credential/);
    }
  });
});

describe("the server starts the env-hold ask", () => {
  it("index.ts calls startEnvHoldAsk() beside the held-writes bell", () => {
    const src = fs.readFileSync(path.resolve("src/ui/server/index.ts"), "utf8");
    const calls = src
      .split("\n")
      .filter((l) => /^\s*startEnvHoldAsk\(\);\s*$/.test(l));
    expect(calls).toHaveLength(1);
    expect(src).toMatch(/startHeldWritesBell\(\);\s*\n\s*startEnvHoldAsk\(\);/);
  });
});
