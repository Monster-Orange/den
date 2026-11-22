/**
 * Issue 814 (option B): the test operator. On an install created as a
 * test install (an empty state folder at its first start, the mark and
 * the launch flag), on loopback only, a fixture session may make a short,
 * closed list of person-only requests, audited as the test operator. The
 * pure parts: the creation record (sealed with the install's secret, for
 * that folder), the act list, and the per-request rule.
 * No secret is printed: failures show booleans and reasons.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  OPERATOR_PRINCIPAL,
  OPERATOR_STUB_SCRIPT,
  claimAtBirth,
  forgetOperatorShell,
  isOperatorShell,
  operatorStubArgv,
  operatorStubEnv,
  rememberOperatorShell,
  creationRecordPath,
  hasForwardingHeaders,
  operatorAct,
  operatorRefusal,
  stateDirIsEmpty,
  verifiedCreationRecord,
  writeCreationRecord,
} from "../../../src/shared/test-operator.js";
import { FIXTURE_PRINCIPAL } from "../../../src/shared/fixture-person.js";
import { ensureWebSecret } from "../../../src/shared/web-secret.js";
import { spawn } from "child_process";

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-op-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the test operator's name", () => {
  it("is its own principal, never the fixture person's or a person's", () => {
    expect(OPERATOR_PRINCIPAL).toBe("test:operator");
    expect(OPERATOR_PRINCIPAL).not.toBe(FIXTURE_PRINCIPAL);
    expect(OPERATOR_PRINCIPAL.startsWith("person:")).toBe(false);
  });
});

describe("a state folder is new only when it is missing or empty", () => {
  it("missing", () => {
    expect(stateDirIsEmpty(path.join(tmp, "nope"))).toBe(true);
  });
  it("empty", () => {
    expect(stateDirIsEmpty(tmp)).toBe(true);
  });
  it("any file in it, a hidden one too, makes it not new", () => {
    fs.writeFileSync(path.join(tmp, ".x"), "");
    expect(stateDirIsEmpty(tmp)).toBe(false);
  });
  it("a file in its place is not a new folder", () => {
    const f = path.join(tmp, "file");
    fs.writeFileSync(f, "");
    expect(stateDirIsEmpty(f)).toBe(false);
  });
});

describe("the creation record", () => {
  it("is 0600, and verifies with the secret it was sealed with", () => {
    const secret = ensureWebSecret(tmp);
    writeCreationRecord(tmp, secret);
    expect(fs.statSync(creationRecordPath(tmp)).mode & 0o777).toBe(0o600);
    expect(verifiedCreationRecord(tmp, secret)).toBe(true);
  });

  it("is refused with no secret, or another secret (a rotated one)", () => {
    const secret = ensureWebSecret(tmp);
    writeCreationRecord(tmp, secret);
    expect(verifiedCreationRecord(tmp, null)).toBe(false);
    expect(verifiedCreationRecord(tmp, Buffer.alloc(32, 7))).toBe(false);
  });

  it("a record written by hand is refused", () => {
    const secret = ensureWebSecret(tmp);
    fs.writeFileSync(
      creationRecordPath(tmp),
      `v1.${Date.now()}.${"A".repeat(43)}\n`,
      {
        mode: 0o600,
      },
    );
    expect(verifiedCreationRecord(tmp, secret)).toBe(false);
  });

  it("a record copied from another folder is refused, even with the same secret", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    const secret = ensureWebSecret(a);
    fs.mkdirSync(b, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(a, "web.secret"), path.join(b, "web.secret"));
    writeCreationRecord(a, secret);
    fs.copyFileSync(creationRecordPath(a), creationRecordPath(b));
    fs.chmodSync(creationRecordPath(b), 0o600);
    expect(verifiedCreationRecord(b, secret)).toBe(false);
  });

  it("is refused when others can read it", () => {
    const secret = ensureWebSecret(tmp);
    writeCreationRecord(tmp, secret);
    fs.chmodSync(creationRecordPath(tmp), 0o644);
    expect(verifiedCreationRecord(tmp, secret)).toBe(false);
  });

  it("missing: refused", () => {
    expect(verifiedCreationRecord(tmp, ensureWebSecret(tmp))).toBe(false);
  });
});

describe("the test operator's acts: a closed list", () => {
  it.each([
    ["POST", "/api/workspaces/notes/sessions", "terminal-start"],
    ["GET", "/api/sessions/s1/io", "terminal-attach"],
    ["POST", "/api/sessions/s1/close", "terminal-close"],
    ["POST", "/api/workspaces/notes/agents/a1/say", "agent-say"],
    ["POST", "/api/workspaces/notes/agents/a1/relaunch", "agent-relaunch"],
  ])("%s %s is %s", (m, p, act) => {
    expect(operatorAct(m, p)).toBe(act);
  });

  it.each([
    // Approvals, sign-in, devices, the fixture person's setup.
    ["POST", "/api/approvals/a1/decide"],
    ["POST", "/api/web/fixture-person"],
    ["GET", "/api/web/waiting"],
    ["POST", "/api/web/approve"],
    ["POST", "/api/web/logins"],
    // Person-only settings, restarts, Hub writes.
    ["POST", "/api/settings"],
    ["POST", "/api/restart"],
    ["POST", "/api/hub/connect"],
    ["POST", "/api/hub/link-suggestions"],
    ["PUT", "/api/workspaces/notes/hub-project"],
    ["POST", "/api/workspaces/notes/hub-project"],
    // Not granted after the review: a runtime's path writes the
    // distribution's shared config and runs the binary; the Hub reads use
    // the distribution's Hub token.
    ["POST", "/api/agents/runtimes/claude/path"],
    ["GET", "/api/workspaces/notes/hub-project"],
    ["GET", "/api/hub/link-suggestions"],
    // Other agent verbs a person owns.
    ["POST", "/api/workspaces/notes/agents/a1/restart"],
    ["POST", "/api/workspaces/notes/agents/a1/move"],
    ["POST", "/api/workspaces/notes/agents/a1/mode"],
    // A session's other routes, and lookalikes.
    ["POST", "/api/sessions/s1/uploads"],
    ["GET", "/api/sessions/s1/io/x"],
    ["POST", "/api/workspaces/notes/sessions/x"],
    ["POST", "/api/workspaces/a/b/agents/a1/say"],
    ["GET", "/api/workspaces/notes/agents/a1/say"],
    ["POST", "/api/agents/runtimes/claude/path/x"],
  ])("%s %s is not an act", (m, p) => {
    expect(operatorAct(m, p)).toBeNull();
  });
});

describe("the per-request rule", () => {
  const ok = {
    operatorInstall: true,
    via: "loopback" as const,
    beyond: false,
    method: "POST",
    pathname: "/api/workspaces/notes/agents/a1/say",
  };

  it("an act, on an operator install, on loopback: allowed", () => {
    expect(operatorRefusal(ok)).toBeNull();
  });

  it("refused on an install that isn't an operator install", () => {
    expect(operatorRefusal({ ...ok, operatorInstall: false })).toBe(
      "not_operator_install",
    );
  });

  it.each([
    ["the edge", { via: "edge" as const, beyond: true }],
    ["a LAN name", { via: "lan" as const, beyond: true }],
    ["a non-loopback peer", { via: "loopback" as const, beyond: true }],
  ])("refused through %s", (_n, o) => {
    expect(operatorRefusal({ ...ok, ...o })).toBe("not_loopback");
  });

  it("refused when a proxy forwarded it", () => {
    expect(operatorRefusal({ ...ok, forwarded: true })).toBe("forwarded");
    expect(hasForwardingHeaders({ "x-forwarded-for": "10.0.0.2" })).toBe(true);
    expect(hasForwardingHeaders({ forwarded: "for=10.0.0.2" })).toBe(true);
    expect(hasForwardingHeaders({ via: "1.1 proxy" })).toBe(true);
    expect(hasForwardingHeaders({ host: "localhost:1" })).toBe(false);
  });

  it("attach and close: only the operator's own shells", () => {
    const own = (k: string) => k === "s-own";
    for (const p of ["/api/sessions/s-own/io", "/api/sessions/s-own/close"]) {
      const m = p.endsWith("/io") ? "GET" : "POST";
      expect(
        operatorRefusal({ ...ok, method: m, pathname: p, ownShell: own }),
      ).toBeNull();
      expect(
        operatorRefusal({
          ...ok,
          method: m,
          pathname: p.replace("s-own", "agent-a1"),
          ownShell: own,
        }),
      ).toBe("not_own_shell");
    }
  });

  it("refused for a route off the list", () => {
    expect(
      operatorRefusal({ ...ok, pathname: "/api/approvals/a1/decide" }),
    ).toBe("not_an_act");
  });
});

describe("claiming a state folder at the first start", () => {
  const def = () => path.join(tmp, "home", ".den");
  it("a missing folder, with the launch flag: claimed, the pending record its only file", () => {
    const dir = path.join(tmp, "new", "state");
    expect(
      claimAtBirth({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["test-install.created"]);
    expect(fs.statSync(creationRecordPath(dir)).mode & 0o777).toBe(0o600);
    // The pending record verifies as nothing.
    expect(verifiedCreationRecord(dir, ensureWebSecret(dir))).toBe(false);
  });
  it("an empty folder: claimed", () => {
    const dir = path.join(tmp, "empty");
    fs.mkdirSync(dir);
    expect(
      claimAtBirth({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(true);
  });
  it("never without the launch flag", () => {
    const dir = path.join(tmp, "noflag");
    expect(
      claimAtBirth({
        stateDir: dir,
        defaultStateDir: def(),
        launchFlag: false,
      }),
    ).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });
  it("never on the product's default folder", () => {
    expect(
      claimAtBirth({
        stateDir: def(),
        defaultStateDir: def(),
        launchFlag: true,
      }),
    ).toBe(false);
  });
  it("never on a folder that already holds an install", () => {
    const dir = path.join(tmp, "used");
    ensureWebSecret(dir);
    expect(
      claimAtBirth({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(false);
    expect(fs.existsSync(creationRecordPath(dir))).toBe(false);
  });
  it("never twice: a second start finds the record and claims nothing", () => {
    const dir = path.join(tmp, "twice");
    expect(
      claimAtBirth({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(true);
    expect(
      claimAtBirth({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(false);
  });
});

describe("the test operator's terminal is a fixed stub, never a shell (the Builder's decision a)", () => {
  it("runs Den's own node on one fixed script: no shell, nothing from the request", () => {
    const argv = operatorStubArgv();
    expect(argv).toEqual([process.execPath, "-e", OPERATOR_STUB_SCRIPT]);
    expect(argv.join(" ")).not.toMatch(/(^|\/)(ba|z|da|fi)?sh( |$)|-l\b/);
    // The script can't reach a process, a file or the module loader.
    expect(OPERATOR_STUB_SCRIPT).not.toMatch(
      /require|import|child_process|spawn|exec|fs\.|readFile|eval|Function|process\.env|process\.binding|dlopen/,
    );
  });

  it("its env is TERM only: no home, root, path, node options or credential", () => {
    expect(Object.keys(operatorStubEnv())).toEqual(["TERM"]);
  });

  it("what is typed into it is echoed, never run: no den call, no file read, no process started", async () => {
    const marker = path.join(tmp, "ran");
    const secret = path.join(tmp, "web.secret");
    fs.writeFileSync(secret, "s3cr3t-value\n");
    const [file, ...args] = operatorStubArgv();
    const child = spawn(file, args, {
      cwd: tmp,
      env: operatorStubEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    const typed = [
      "den --test-person approvals approve a1",
      `touch ${marker}`,
      `cat ${secret}`,
      "",
    ].join("\n");
    child.stdin.write(typed);
    await new Promise((r) => setTimeout(r, 400));
    child.stdin.end();
    const code = await new Promise<number | null>((r) =>
      child.on("exit", (c) => r(c)),
    );
    expect(code).toBe(0);
    expect(out).toBe(typed);
    expect(out).not.toContain("s3cr3t-value");
    expect(fs.existsSync(marker)).toBe(false);
  }, 15_000);
});

describe("the operator's own shells: by host id only, forgotten when closed", () => {
  it("a name is never remembered, so a reused name is never its own", () => {
    rememberOperatorShell("host-id-1");
    expect(isOperatorShell("host-id-1")).toBe(true);
    expect(isOperatorShell("acme-north:shell")).toBe(false);
    forgetOperatorShell("host-id-1");
    expect(isOperatorShell("host-id-1")).toBe(false);
  });
});

describe("say and relaunch reach project agents only", () => {
  const ok = {
    operatorInstall: true,
    via: "loopback" as const,
    beyond: false,
    forwarded: false,
  };
  it.each([
    ["POST", "/api/workspaces/den-server/agents/helper/say"],
    ["POST", "/api/workspaces/den-server/agents/helper/relaunch"],
    ["POST", "/api/workspaces/den%2Dserver/agents/helper/say"],
  ])("%s %s: the server agent's, refused", (m, p) => {
    expect(operatorRefusal({ ...ok, method: m, pathname: p })).toBe(
      "server_agent",
    );
  });
  it("a project agent's: allowed", () => {
    expect(
      operatorRefusal({
        ...ok,
        method: "POST",
        pathname: "/api/workspaces/north/agents/planner/say",
      }),
    ).toBeNull();
  });
});
