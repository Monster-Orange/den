/**
 * SEC-1c (SEC-1 spec §5): an agent's actor token. `agents start` mints a
 * random `den_at_…`, stores only its hash (actor-tokens.json, 0600) with
 * {actor, workspace, grants, session}, and hands it to the session as
 * DEN_ACTOR_TOKEN (the §5a-env allowlist's Den markers). Stop and the
 * session's end revoke it; resume mints a fresh one and the old one stops
 * working. A real host on a temp socket, a scripted PTY, a `claude` shim
 * that never runs.
 *
 * No token is printed: a failure shows only booleans or `<token>`.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  ACTOR_TOKEN_ENV,
  ACTOR_TOKEN_FILE_ENV,
  actorTokenOf,
  actorTokensPath,
  isPersonCredentialEnv,
  mintActorToken,
  verifyActorToken,
  writeActorTokenFile,
} from "../../../src/shared/actor-token.js";
import { buildSessionEnv } from "../../../src/shared/sessions/env.js";
import { agentSessionEnv } from "../../../src/shared/agents/runtimes.js";
import {
  cliAuthHeaders,
  ensureWebSecret,
  personToken,
} from "../../../src/shared/web-secret.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
/** The token the i-th session was started with, from its file (never printed). */
const tokenOf = (r: Rig, i: number): string =>
  actorTokenOf(r.made[i].opts.env) ?? "";
/** A token as a failure may show it. */
const mask = (t: string | null | undefined) =>
  typeof t === "string" && /^den_at_[A-Za-z0-9_-]{43}$/.test(t)
    ? "<token>"
    : t === undefined || t === null || t === ""
      ? "<none>"
      : "<malformed>";
const verified = (r: Rig, t: string) => verifyActorToken(r.stateDir, t);

describe("agents start mints an actor token", () => {
  it("into the session as DEN_ACTOR_TOKEN; only its hash is stored, 0600, with actor, workspace, grants and session", async () => {
    const r = await rig();
    r.config.agents = { planner: { grants: ["south"] } };
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    const token = tokenOf(r, 0);
    expect(mask(token)).toBe("<token>");
    const file = actorTokensPath(r.stateDir);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw.includes(token)).toBe(false);
    expect(raw.includes(token.slice("den_at_".length))).toBe(false);
    const stored = Object.values(
      (JSON.parse(raw) as { tokens: Record<string, unknown> }).tokens,
    );
    expect(stored).toEqual([
      expect.objectContaining({
        actor: "agent:planner",
        workspace: "north",
        grants: ["south"],
        session: {
          name: "acme-north:planner",
          id: expect.any(String),
        },
      }),
    ]);
    expect(verified(r, token)).toMatchObject({ actor: "agent:planner" });
    // Nothing the CLI printed carries it.
    expect([...r.out, ...r.err].join("\n").includes(token)).toBe(false);
  });

  it("#70: never in the session's environment: a file (0600, in a 0700 folder of the agent's own) the environment names", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const env = r.made[0].opts.env;
    expect(ACTOR_TOKEN_ENV in env).toBe(false);
    // No value in it is a token (what ps would show).
    expect(Object.values(env).some((v) => /den_at_/.test(String(v)))).toBe(
      false,
    );
    const file = env[ACTOR_TOKEN_FILE_ENV]!;
    expect(file.startsWith(r.stateDir)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(mask(tokenOf(r, 0))).toBe("<token>");
  });

  it("stop revokes it, and removes its file", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const token = tokenOf(r, 0);
    const file = r.made[0].opts.env[ACTOR_TOKEN_FILE_ENV]!;
    expect(verified(r, token)).not.toBeNull();
    expect(await agents(r, "stop", "planner")).toBe(0);
    expect(verified(r, token)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("its session's end revokes it (an exit, a crash: not only stop)", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const token = tokenOf(r, 0);
    r.made[0].exit(1);
    await settle();
    expect(verified(r, token)).toBeNull();
    // Removed from the store when it was presented.
    expect(fs.readFileSync(actorTokensPath(r.stateDir), "utf-8")).not.toMatch(
      /agent:planner/,
    );
  });

  it("resume mints a fresh one; the old one stops working", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const first = tokenOf(r, 0);
    r.made[0].exit(0);
    await settle();
    expect(await agents(r, "resume", "planner")).toBe(0);
    const second = tokenOf(r, 1);
    expect(mask(second)).toBe("<token>");
    expect(second === first).toBe(false);
    expect(verified(r, first)).toBeNull();
    expect(verified(r, second)).toMatchObject({ actor: "agent:planner" });
  });

  it("a start the host refuses (the cap) leaves no token behind", async () => {
    const r = await rig();
    r.config.maxConcurrent = 1;
    await agents(r, "start", "-w", "north", "--persona", "planner");
    expect(
      await agents(r, "start", "-w", "south", "--persona", "planner"),
    ).toBe(1);
    const tokens = (
      JSON.parse(fs.readFileSync(actorTokensPath(r.stateDir), "utf-8")) as {
        tokens: Record<string, { actor: string }>;
      }
    ).tokens;
    expect(Object.values(tokens).map((t) => t.actor)).toEqual([
      "agent:planner",
    ]);
  });
});

describe("the §5a-env allowlist and the scrub", () => {
  it("the token's file reaches a session only from Den: a caller's, a runtime's or a kept one is dropped (and a token, ever)", () => {
    const env = buildSessionEnv({
      caller: {
        PATH: "/bin",
        [ACTOR_TOKEN_ENV]: "den_at_caller",
        [ACTOR_TOKEN_FILE_ENV]: "/elsewhere/token",
      },
      keep: [ACTOR_TOKEN_ENV, ACTOR_TOKEN_FILE_ENV],
      launch: {
        [ACTOR_TOKEN_ENV]: "den_at_runtime",
        [ACTOR_TOKEN_FILE_ENV]: "/runtime/token",
      },
    });
    expect(ACTOR_TOKEN_ENV in env).toBe(false);
    expect(ACTOR_TOKEN_FILE_ENV in env).toBe(false);
    const agent = agentSessionEnv(
      { PATH: "/bin" },
      {},
      {},
      "planner",
      "/state/actor-token/planner/token",
    );
    expect(agent[ACTOR_TOKEN_FILE_ENV]).toBe(
      "/state/actor-token/planner/token",
    );
    expect(ACTOR_TOKEN_ENV in agent).toBe(false);
  });

  it("strips a person's credential always: DEN_PERSON_TOKEN, a person token's value, a path to web.secret, whatever put it there", () => {
    const env = buildSessionEnv({
      caller: {
        PATH: "/bin",
        DEN_PERSON_TOKEN: "x",
        LANG: "den_pt_value",
        TMPDIR: "/home/u/.den/web.secret",
      },
      keep: ["DEN_PERSON_TOKEN"],
      launch: { SECRET_AT: "/home/u/.den/web.secret" },
      extra: { CRED: "Bearer den_pt_value" },
      den: { DEN_PERSON_TOKEN: "y" },
    });
    expect(Object.keys(env).sort()).toEqual(["PATH", "TERM"]);
    expect(isPersonCredentialEnv("HOME", "/home/u")).toBe(false);
    expect(isPersonCredentialEnv("X", "/a/web.secret.bak")).toBe(false);
    expect(isPersonCredentialEnv("X", "a:/b/web.secret")).toBe(true);
  });

  it("den#3: past the scrub only the names a runtime declares, and only from its launch env", () => {
    const env = buildSessionEnv({
      caller: {
        PATH: "/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "parent",
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      },
      passthrough: [
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
      ],
      launch: {
        CLAUDE_CODE_SUBAGENT_MODEL: "sonnet",
        CLAUDE_CODE_ENTRYPOINT: "z",
      },
      extra: { CLAUDE_CODE_Y: "c" },
      scrub: ["CLAUDECODE", "CLAUDE_CODE_*"],
      ownLaunch: [
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
      ],
    });
    expect(Object.keys(env).sort()).toEqual([
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "PATH",
      "TERM",
    ]);
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("sonnet");
  });
});

describe("the CLI's credential inside an agent (cliAuthHeaders)", () => {
  it("is the agent's DEN_ACTOR_TOKEN, never the person token; an agent without one sends none", async () => {
    const r = await rig();
    const secret = ensureWebSecret(r.stateDir);
    const person = `Bearer ${personToken(secret)}`;
    expect(cliAuthHeaders(r.stateDir, {}).Authorization === person).toBe(true);
    const { token } = mintActorToken(r.stateDir, {
      agentId: "planner",
      workspace: "north",
      sessionName: "acme-north:planner",
    });
    const asAgent = cliAuthHeaders(r.stateDir, { [ACTOR_TOKEN_ENV]: token });
    expect(asAgent.Authorization === `Bearer ${token}`).toBe(true);
    // #70: from the file its session names (0.4.43 sessions).
    const file = writeActorTokenFile(r.stateDir, "planner", token);
    expect(
      cliAuthHeaders(r.stateDir, { [ACTOR_TOKEN_FILE_ENV]: file })
        .Authorization === `Bearer ${token}`,
    ).toBe(true);
    // A file it can't read: no credential, never the person's.
    expect(
      cliAuthHeaders(r.stateDir, { [ACTOR_TOKEN_FILE_ENV]: file + ".gone" }),
    ).toEqual({});
    expect(cliAuthHeaders(r.stateDir, { DEN_AGENT: "agent:planner" })).toEqual(
      {},
    );
    expect(
      cliAuthHeaders(r.stateDir, { [ACTOR_TOKEN_ENV]: "not-a-token" }),
    ).toEqual({});
    expect(fs.existsSync(path.join(r.stateDir, "web.secret"))).toBe(true);
  });
});
