/**
 * Issue 163 (dev.2 gate): what `agents token status` and `clear` say.
 *
 * - env: Den's record of the set (the meta file it writes on set and
 *   removes on clear) is the one truth, for a new CLI process as for the
 *   page, marked process-local; clear says what it did.
 * - Not in mode always, no store: the per-mode words, pointing to
 *   secrets.provider first, nothing about signing in after logout.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { SecretRef } from "../../../src/shared/secrets/types.js";
import {
  agentTokenStatus,
  clearAgentToken,
  tokenStatusLine,
} from "../../../src/shared/agents/signin-token.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const REF: SecretRef = {
  vault: "",
  item: "",
  field: "",
  key: "ACME_AGENT_SIGNIN_TOKEN",
};
const st = (backend: "env" | "none" | "doppler") => () => ({
  backend,
  label: backend === "env" ? "environment" : backend,
  implicit: backend === "none",
  detect: { available: true },
});
/** The env backend's status never reads a store. */
const noRead = () => {
  throw new Error("the env backend's status reads no store");
};
const meta = (stateDir: string) =>
  fs.writeFileSync(
    path.join(stateDir, "agent-signin-token.json"),
    JSON.stringify({ setAt: "2026-11-16T10:00:00Z", store: "environment" }),
  );

describe("env: Den's record is the one truth", () => {
  it("a new CLI process, after a set: status says set, process-local (the value isn't in this process)", async () => {
    const r = await rig();
    meta(r.stateDir);
    expect(
      await cmdAgents(["token", "status"], {
        ...r.deps,
        env: { ...r.deps.env },
        tokenDeps: { ref: () => REF, status: st("env"), provider: noRead },
      }),
    ).toBe(0);
    expect(r.out.join("\n")).toMatch(
      /^✓ agents sign in with the token set .*\(process-local: kept only until Den restarts\)$/m,
    );
  });

  it("no record: no token, even with a ref and the value in this process", async () => {
    const r = await rig();
    const s = await agentTokenStatus({
      env: { ACME_AGENT_SIGNIN_TOKEN: "fake-in-process-0123456789" },
      stateDir: r.stateDir,
      ref: () => REF,
      status: st("env"),
      provider: noRead,
      probe: true,
    });
    expect(s.configured && s.stored !== false).toBe(false);
    expect(tokenStatusLine(s, "acme").text).toMatch(/^no sign-in token set/);
  });

  it("clear with only the record (a new CLI process): says what it removed, rc 0", async () => {
    const r = await rig();
    meta(r.stateDir);
    const res = await clearAgentToken({
      ref: () => REF,
      env: {},
      status: st("env"),
      stateDir: r.stateDir,
    });
    expect(res).toMatchObject({
      cleared: true,
      how: "process",
      inProcess: false,
    });
    expect(
      fs.existsSync(path.join(r.stateDir, "agent-signin-token.json")),
    ).toBe(false);
    expect(
      await cmdAgents(["token", "clear", "--yes"], {
        ...r.deps,
        tokenClear: async () => res,
      }),
    ).toBe(0);
    expect(r.out.join("\n")).not.toMatch(/nothing to remove/);
    expect(r.out.join("\n")).toMatch(/until Den restarts/);
  });
});

describe("no store, not in mode always: the per-mode words", () => {
  it("points to secrets.provider first and says nothing about signing in after logout", async () => {
    const r = await rig();
    const s = await agentTokenStatus({
      env: {},
      stateDir: r.stateDir,
      ref: () => null,
      status: st("none"),
      probe: true,
    });
    const l = tokenStatusLine(s, "acme");
    expect(l.status).toBe("ok");
    expect(l.text).toMatch(/^no sign-in token set/);
    expect(l.text).toMatch(/secrets\.provider/);
    expect(l.text).not.toMatch(/will not be able to sign in/);
  });
});
