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
  dropStaleEnvTokenRecord,
  saveAgentToken,
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

describe("env: the CLI can't set it, and a restart drops the record", () => {
  const TOKEN = "fake-oat-token-cli-0123456789abcdef";
  const recordAt = (d: string) => path.join(d, "agent-signin-token.json");

  it("agents token set refuses with provider env: rc 1, no record, never saved", async () => {
    const r = await rig();
    let saves = 0;
    const rc = await cmdAgents(["token", "set"], {
      ...r.deps,
      tokenInput: async () => TOKEN,
      tokenSave: async () => {
        saves++;
        meta(r.stateDir);
        return { ref: "configured", store: "environment" };
      },
      tokenDeps: { ref: () => REF, status: st("env"), provider: noRead },
    });
    expect(rc).toBe(1);
    expect(saves).toBe(0);
    expect(r.err.join("\n")).toContain(
      "with secrets.provider env the token lives only in Den's running process; set it in Settings, or use 1password or doppler",
    );
    expect(r.err.join("\n") + r.out.join("\n")).not.toContain(TOKEN);
    expect(fs.existsSync(recordAt(r.stateDir))).toBe(false);
  });

  it("saveAgentToken with env: refused outside Den's process, allowed inside it", async () => {
    const r = await rig();
    const kept: Record<string, string> = {};
    const provider = () =>
      ({
        name: "env",
        set: async (ref: SecretRef, v: string) => {
          kept[ref.key!] = v;
        },
      }) as never;
    await expect(
      saveAgentToken(TOKEN, {
        provider,
        ref: () => REF,
        status: st("env") as never,
        stateDir: r.stateDir,
      }),
    ).rejects.toThrow(/lives only in Den's running process/);
    expect(fs.existsSync(recordAt(r.stateDir))).toBe(false);
    expect(kept).toEqual({});
    await saveAgentToken(TOKEN, {
      provider,
      ref: () => REF,
      status: st("env") as never,
      stateDir: r.stateDir,
      inDen: true,
    });
    expect(fs.existsSync(recordAt(r.stateDir))).toBe(true);
  });

  it("at Den's start: a record whose value isn't in the process is dropped; one whose value is, kept", async () => {
    const r = await rig();
    meta(r.stateDir);
    expect(
      dropStaleEnvTokenRecord({
        stateDir: r.stateDir,
        env: { ACME_AGENT_SIGNIN_TOKEN: TOKEN },
        ref: () => REF,
        status: st("env") as never,
      }),
    ).toBe(false);
    expect(fs.existsSync(recordAt(r.stateDir))).toBe(true);
    expect(
      dropStaleEnvTokenRecord({
        stateDir: r.stateDir,
        env: {},
        ref: () => REF,
        status: st("env") as never,
      }),
    ).toBe(true);
    expect(fs.existsSync(recordAt(r.stateDir))).toBe(false);
    // Another backend's record is never touched.
    meta(r.stateDir);
    expect(
      dropStaleEnvTokenRecord({
        stateDir: r.stateDir,
        env: {},
        ref: () => REF,
        status: st("doppler") as never,
      }),
    ).toBe(false);
    expect(fs.existsSync(recordAt(r.stateDir))).toBe(true);
  });
});
