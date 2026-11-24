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
  birthClaim,
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
  testBedOnly,
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
    // Issue 1407: gate/1407 restarts the bed's own agents for its tools.
    ["POST", "/api/workspaces/notes/agents/a1/restart", "agent-restart"],
    ["POST", "/api/agents/restart-stale", "agents-restart-stale"],
    // Issue 1414: Allow and Undo of the bed's own agents' held writes.
    ["POST", "/api/approvals/AbCdEfGh_-123456/decide", "approval-allow"],
    ["POST", "/api/settings/undo", "setting-undo"],
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
    ["POST", "/api/workspaces/notes/agents/a1/move"],
    ["GET", "/api/workspaces/notes/agents/a1/restart"],
    ["POST", "/api/agents/restart-stale/x"],
    ["GET", "/api/agents/stale"],
    ["POST", "/api/workspaces/notes/agents/a1/mode"],
    // A session's other routes, and lookalikes.
    ["POST", "/api/sessions/s1/uploads"],
    ["GET", "/api/sessions/s1/io/x"],
    ["POST", "/api/workspaces/notes/sessions/x"],
    ["POST", "/api/workspaces/a/b/agents/a1/say"],
    ["GET", "/api/workspaces/notes/agents/a1/say"],
    ["POST", "/api/agents/runtimes/claude/path/x"],
    // Issue 1414's lookalikes: only a held write's own id, POST only.
    ["GET", "/api/approvals/AbCdEfGh_-123456/decide"],
    ["POST", "/api/approvals/AbCdEfGh_-123456/decide/x"],
    ["POST", "/api/approvals/AbCdEfGh_-1234567/decide"],
    ["POST", "/api/approvals"],
    ["POST", "/api/approvals/AbCdEfGh_-123456/withdraw"],
    ["GET", "/api/settings/undo"],
    ["POST", "/api/settings/undo/x"],
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

  // Issue 1414: Allow and Undo are loopback-only, unforwarded, on an
  // operator install (a copied creation record never makes one: see "the
  // creation record" above). Never through the edge, its own included.
  describe.each([
    ["approval-allow", "/api/approvals/AbCdEfGh_-123456/decide"],
    ["setting-undo", "/api/settings/undo"],
  ])("%s", (_act, pathname) => {
    const o = { ...ok, pathname };
    it("allowed on an operator install, on loopback", () => {
      expect(operatorRefusal(o)).toBeNull();
    });
    it("refused on an install that isn't an operator install", () => {
      expect(operatorRefusal({ ...o, operatorInstall: false })).toBe(
        "not_operator_install",
      );
    });
    it.each([
      ["the edge", { via: "edge" as const, beyond: true }],
      [
        "the install's own edge, from this machine",
        { via: "edge" as const, beyond: false, edgeLocal: true },
      ],
      ["a LAN name", { via: "lan" as const, beyond: true }],
      ["a non-loopback peer", { via: "loopback" as const, beyond: true }],
    ])("refused through %s", (_n, x) => {
      expect(operatorRefusal({ ...o, ...x })).toBe("not_loopback");
    });
    it("refused when a proxy forwarded it", () => {
      expect(operatorRefusal({ ...o, forwarded: true })).toBe("forwarded");
    });
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

  // Issue 1034: gate 653 proves the terminal path through the edge (0.4.75
  // broke it). The operator's own shell, through the install's own proved
  // edge, on an operator install: allowed. Nothing else widens.
  describe("its own shell through the install's own edge (issue 1034)", () => {
    const own = (k: string) => k === "s-own";
    const edge = {
      ...ok,
      via: "edge" as const,
      beyond: false,
      forwarded: true,
      edgeLocal: true,
      ownShell: own,
    };
    const acts: [string, string][] = [
      ["GET", "/api/sessions/s-own/io"],
      ["POST", "/api/sessions/s-own/close"],
    ];

    it.each(acts)("%s %s: allowed", (m, p) => {
      expect(operatorRefusal({ ...edge, method: m, pathname: p })).toBeNull();
    });

    it.each(acts)("%s %s on a real install: refused", (m, p) => {
      expect(
        operatorRefusal({
          ...edge,
          method: m,
          pathname: p,
          operatorInstall: false,
        }),
      ).toBe("not_operator_install");
    });

    it.each(acts)(
      "%s %s unless the edge proved it and attests this machine: refused",
      (m, p) => {
        expect(
          operatorRefusal({
            ...edge,
            method: m,
            pathname: p,
            edgeLocal: false,
          }),
        ).toBe("not_loopback");
        const { edgeLocal: _drop, ...noProof } = edge;
        expect(operatorRefusal({ ...noProof, method: m, pathname: p })).toBe(
          "not_loopback",
        );
      },
    );

    it.each(acts)(
      "%s %s from a client the edge doesn't attest (edgeLocal false, not beyond): refused",
      (m, p) => {
        expect(
          operatorRefusal({
            ...edge,
            method: m,
            pathname: p,
            beyond: false,
            edgeLocal: false,
          }),
        ).toBe("not_loopback");
      },
    );

    it.each(acts)(
      "%s %s from a client beyond this machine: refused",
      (m, p) => {
        expect(
          operatorRefusal({ ...edge, method: m, pathname: p, beyond: true }),
        ).toBe("not_loopback");
      },
    );

    it.each(acts)("%s %s on a LAN name: refused", (m, p) => {
      expect(
        operatorRefusal({ ...edge, method: m, pathname: p, via: "lan" }),
      ).toBe("not_loopback");
    });

    it("another terminal (an agent's) through the edge: refused", () => {
      expect(
        operatorRefusal({
          ...edge,
          method: "GET",
          pathname: "/api/sessions/agent-a1/io",
        }),
      ).toBe("not_own_shell");
    });

    it.each([
      ["POST", "/api/workspaces/notes/agents/a1/say"],
      ["POST", "/api/workspaces/notes/sessions"],
    ])("%s %s (not attach or close) through the edge: refused", (m, p) => {
      expect(operatorRefusal({ ...edge, method: m, pathname: p })).toBe(
        "not_loopback",
      );
    });
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
  it("never twice: once the first start made the secret, a second claims nothing", () => {
    const dir = path.join(tmp, "twice");
    expect(
      claimAtBirth({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(true);
    ensureWebSecret(dir);
    expect(
      claimAtBirth({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(false);
  });

  // Issue 1407 (Vision's ruling): the start that creates the install's
  // secret, with the launcher's flag, is its birth; the folder needn't be
  // empty. `web up` writes its log there before the server starts.
  it("a folder `web up` already wrote its log in, with no secret yet: claimed", () => {
    const dir = path.join(tmp, "webup");
    fs.mkdirSync(path.join(dir, "logs", "den"), { recursive: true });
    fs.writeFileSync(path.join(dir, "logs", "den", "web.log"), "start\n");
    expect(
      claimAtBirth({
        stateDir: dir,
        defaultStateDir: def(),
        launchFlag: true,
        cli: "den",
      }),
    ).toBe(true);
    expect(fs.readFileSync(creationRecordPath(dir), "utf-8").trim()).toBe(
      "pending",
    );
    expect(fs.statSync(creationRecordPath(dir)).mode & 0o777).toBe(0o600);
  });

  // A bed run (11-24) and a local probe of the real `web up`:
  // it writes its log, starts the server, then writes web.json (the server's
  // pid and port) at once, before the server's slow start reaches its first
  // look. So the folder may hold both.
  const webUpFolder = (dir: string) => {
    fs.mkdirSync(path.join(dir, "logs", "den"), { recursive: true });
    fs.writeFileSync(path.join(dir, "logs", "den", "web.log"), "start\n");
    fs.writeFileSync(
      path.join(dir, "web.json"),
      JSON.stringify({
        pid: 4242,
        port: 4317,
        root: "/x",
        logPath: "/x/web.log",
      }),
    );
  };
  it("the folder as `web up` leaves it (web.log, then web.json): claimed", () => {
    const dir = path.join(tmp, "webupjson");
    webUpFolder(dir);
    expect(
      claimAtBirth({
        stateDir: dir,
        defaultStateDir: def(),
        launchFlag: true,
        cli: "den",
      }),
    ).toBe(true);
    expect(fs.readFileSync(creationRecordPath(dir), "utf-8").trim()).toBe(
      "pending",
    );
  });

  it.each([
    ["web.json as a link", "link"],
    ["web.json as a folder", "folder"],
  ])("%s: no claim", (_n, kind) => {
    const dir = path.join(tmp, `wj-${kind}`);
    fs.mkdirSync(path.join(dir, "logs", "den"), { recursive: true });
    fs.writeFileSync(path.join(dir, "logs", "den", "web.log"), "start\n");
    if (kind === "link") {
      fs.writeFileSync(path.join(tmp, "elsewhere.json"), "{}\n");
      fs.symlinkSync(
        path.join(tmp, "elsewhere.json"),
        path.join(dir, "web.json"),
      );
    } else fs.mkdirSync(path.join(dir, "web.json"));
    expect(
      claimAtBirth({
        stateDir: dir,
        defaultStateDir: def(),
        launchFlag: true,
        cli: "den",
      }),
    ).toBe(false);
    expect(fs.existsSync(creationRecordPath(dir))).toBe(false);
  });

  it("a real install whose secret was deleted, with `web up`'s files too: no claim, nothing changes", () => {
    const dir = path.join(tmp, "nosecretjson");
    webUpFolder(dir);
    fs.writeFileSync(path.join(dir, "audit.jsonl"), "{}\n");
    const before = snapshot(dir);
    expect(
      birthClaim({
        stateDir: dir,
        defaultStateDir: def(),
        launchFlag: true,
        cli: "den",
      }),
    ).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });

  // Builder 2's review: a real install whose secret was deleted by hand
  // (to sign everyone out) has no secret either; its other files keep it
  // from being claimed. Only `web up`'s own log may be there.
  it("a real install whose secret was deleted by hand: no claim, nothing changes", () => {
    const dir = path.join(tmp, "nosecret");
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "planner.json"), "{}\n");
    fs.mkdirSync(path.join(dir, "logs", "den"), { recursive: true });
    fs.writeFileSync(path.join(dir, "logs", "den", "web.log"), "start\n");
    const before = snapshot(dir);
    expect(
      birthClaim({
        stateDir: dir,
        defaultStateDir: def(),
        launchFlag: true,
        cli: "den",
      }),
    ).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });

  it.each([
    ["another file beside the log", ["logs/den/web.log", "logs/den/other.log"]],
    ["another product's log", ["logs/acme/web.log"]],
    ["a file at the top", ["logs/den/web.log", "notes.txt"]],
  ])("%s: no claim", (_n, files) => {
    const dir = path.join(tmp, `x-${_n.replace(/\W+/g, "-")}`);
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "x\n");
    }
    expect(
      claimAtBirth({
        stateDir: dir,
        defaultStateDir: def(),
        launchFlag: true,
        cli: "den",
      }),
    ).toBe(false);
    expect(fs.existsSync(creationRecordPath(dir))).toBe(false);
  });

  it("web.log as a link: no claim", () => {
    const dir = path.join(tmp, "loglink");
    fs.mkdirSync(path.join(dir, "logs", "den"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "elsewhere.log"), "x\n");
    fs.symlinkSync(
      path.join(tmp, "elsewhere.log"),
      path.join(dir, "logs", "den", "web.log"),
    );
    expect(
      claimAtBirth({
        stateDir: dir,
        defaultStateDir: def(),
        launchFlag: true,
        cli: "den",
      }),
    ).toBe(false);
  });

  it("a first start that died before its secret: the next start is still the birth", () => {
    const dir = path.join(tmp, "died");
    expect(
      claimAtBirth({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(true);
    expect(
      claimAtBirth({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(true);
  });

  it("the flag on an existing real install's folder: no claim, and nothing in it changes", () => {
    const dir = path.join(tmp, "real");
    ensureWebSecret(dir);
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "planner.json"), "{}\n");
    fs.mkdirSync(path.join(dir, "logs", "den"), { recursive: true });
    fs.writeFileSync(path.join(dir, "logs", "den", "web.log"), "start\n");
    const before = snapshot(dir);
    expect(
      birthClaim({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });

  it("a pending record on a start without the flag is dropped", () => {
    const dir = path.join(tmp, "dropflag");
    expect(
      claimAtBirth({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(true);
    expect(
      birthClaim({ stateDir: dir, defaultStateDir: def(), launchFlag: false }),
    ).toBe(false);
    expect(fs.existsSync(creationRecordPath(dir))).toBe(false);
  });

  it("a pending record beside an existing secret is dropped, never sealed later", () => {
    const dir = path.join(tmp, "dropsecret");
    ensureWebSecret(dir);
    fs.writeFileSync(creationRecordPath(dir), "pending\n", { mode: 0o600 });
    expect(
      birthClaim({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(false);
    expect(fs.existsSync(creationRecordPath(dir))).toBe(false);
  });

  it("a sealed record beside an existing secret is left for verification to judge", () => {
    const dir = path.join(tmp, "keepsealed");
    const secret = ensureWebSecret(dir);
    writeCreationRecord(dir, secret);
    const before = snapshot(dir);
    expect(
      birthClaim({ stateDir: dir, defaultStateDir: def(), launchFlag: true }),
    ).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });
});

/** Every file under `dir`: its path, mode and content. */
function snapshot(dir: string): [string, number, string][] {
  const out: [string, number, string][] = [];
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n);
      const st = fs.lstatSync(f);
      if (st.isDirectory()) {
        out.push([path.relative(dir, f) + "/", st.mode, ""]);
        walk(f);
      } else
        out.push([
          path.relative(dir, f),
          st.mode,
          fs.readFileSync(f).toString("base64"),
        ]);
    }
  };
  walk(dir);
  return out;
}

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

describe("say, relaunch and restart reach project agents only", () => {
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
    ["POST", "/api/workspaces/den-server/agents/helper/restart"],
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

describe("issue 1407: the operator's restart-stale reaches only the bed's own agents", () => {
  const list = [
    { id: "bed-a", workspace: "north" },
    { id: "real", workspace: "north" },
    { id: "bed-b", workspace: "south" },
    { id: "helper", workspace: "den-server" },
  ];
  const marked = new Set(["bed-a", "bed-b", "helper"]);
  it("only agents Den marked testBed, never the server agent", () => {
    expect(testBedOnly(list, (a) => marked.has(a.id)).map((a) => a.id)).toEqual(
      ["bed-a", "bed-b"],
    );
  });
  it("none marked: nothing", () => {
    expect(testBedOnly(list, () => false)).toEqual([]);
  });
});
