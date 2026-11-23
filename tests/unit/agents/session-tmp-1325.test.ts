/**
 * Issue 1325: a sandboxed session gets a private temp folder of its own
 * (makeSessionTmp: 0700, this user's, short enough for a unix socket).
 * TMPDIR, TMP and TEMP name it; it is writable, and its unix sockets
 * connect (a test's server, a dev server). Sockets other programs own
 * stay refused, and so does the session host's. The folder goes when the
 * session ends (noteEnded, agents stop, the next start).
 *
 * The real-wrap cases run where this process can start the OS sandbox
 * (macOS sandbox-exec outside a sandbox, Linux bwrap); inside an agent's
 * own sandbox sandbox-exec can't nest, and they skip.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import {
  agentSandboxPolicy,
  bwrapArgs,
  macProfile,
  makeSessionTmp,
  realPath,
  removeSessionTmp,
  sandboxFor,
  SESSION_TMP_RE,
} from "../../../src/shared/agents/sandbox.js";
import { noteEnded } from "../../../src/ui/cli/agent-ops.js";
import {
  REFUSAL_NOTE,
  refusalNote,
} from "../../../src/shared/agents/guardrails/sandbox-refusal.js";
import { leftoverSessionTmps } from "../../../src/ui/cli/agents-command.js";
import type { AgentRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, settle } from "./helpers/rig.js";

// Short: a unix socket's path is at most 103 bytes (macOS).
const base = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "dst-")));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
afterAll(cleanupRigs);

function layout(name: string) {
  const root = path.join(base, name);
  const stateDir = path.join(root, "state");
  const distRoot = path.join(root, "root");
  const gateDir = path.join(root, "gate-slots");
  for (const d of [
    path.join(stateDir, "agents"),
    path.join(stateDir, "agent-files", "a1"),
    path.join(distRoot, "config", "local"),
    gateDir,
  ])
    fs.mkdirSync(d, { recursive: true });
  return { root, stateDir, distRoot, gateDir, agentId: "a1" };
}

describe("issue 1325: the session's own temp folder", () => {
  it("makeSessionTmp: den-XXXXXX under its base, 0700, this user's, short", () => {
    const dir = makeSessionTmp(base);
    expect(path.dirname(dir)).toBe(base);
    expect(path.basename(dir)).toMatch(SESSION_TMP_RE);
    const st = fs.statSync(dir);
    expect(st.mode & 0o777).toBe(0o700);
    if (process.getuid) expect(st.uid).toBe(process.getuid());
    expect(
      Buffer.byteLength(path.join(dir, "a-socket-name.sock")),
    ).toBeLessThan(104);
    removeSessionTmp(dir, base);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("makeSessionTmp refuses a base too long for a socket, and leaves nothing", () => {
    const deep = path.join(base, "d".repeat(90));
    fs.mkdirSync(deep);
    expect(() => makeSessionTmp(deep)).toThrow(/too long for a unix socket/);
    expect(fs.readdirSync(deep)).toEqual([]);
  });

  it("removeSessionTmp removes only a real den-XXXXXX folder: never a link, never another name", () => {
    const target = path.join(base, "keep-me");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "f"), "x");
    const link = path.join(base, "den-abcdef");
    fs.symlinkSync(target, link);
    removeSessionTmp(link);
    expect(fs.existsSync(path.join(target, "f"))).toBe(true);
    const other = path.join(base, "not-a-session");
    fs.mkdirSync(other);
    removeSessionTmp(other);
    expect(fs.existsSync(other)).toBe(true);
    // Only right inside its base (/tmp by default).
    const nested = path.join(base, "deeper");
    fs.mkdirSync(nested);
    const elsewhere = makeSessionTmp(nested);
    removeSessionTmp(elsewhere);
    expect(fs.existsSync(elsewhere)).toBe(true);
    removeSessionTmp(elsewhere, nested);
    expect(fs.existsSync(elsewhere)).toBe(false);
    removeSessionTmp(undefined);
    removeSessionTmp(path.join(base, "den-zzzzzz")); // gone: no throw
  });

  it("the policy: writable, and its sockets connectable; none without it", () => {
    const l = layout("policy");
    const dir = makeSessionTmp(base);
    const p = agentSandboxPolicy({ ...l, sessionTmp: dir });
    expect(p.writable).toContain(realPath(dir));
    expect(p.socketsAllowed).toContain(realPath(dir));
    expect(p.sessionTmp).toBe(realPath(dir));
    // The session host's socket stays refused, after the allow.
    expect(p.sockets).toContain(
      path.join(realPath(l.stateDir), "sessions.sock"),
    );
    const none = agentSandboxPolicy(l);
    expect(none.sessionTmp).toBeUndefined();
    expect(none.socketsAllowed).not.toContain(realPath(dir));
    const prof = macProfile(p);
    const allow = prof
      .split("\n")
      .find((x) => x.startsWith("(allow network-outbound"))!;
    expect(allow).toContain(realPath(dir).replace(/[.]/g, "\\\\."));
    const deny = prof
      .split("\n")
      .filter((x) => x.startsWith("(deny network-outbound"));
    expect(deny[deny.length - 1]).toContain("sessions.sock");
    // No hard link to a socket; no write to another session's folder,
    // its own allowed back after.
    const lines = prof.split("\n");
    expect(lines).toContain("(deny file-link (vnode-type SOCKET))");
    // No counted repeat ({6}, {1,64}) in any of the profile's regexes:
    // Seatbelt compiles one but doesn't match it (the macOS run found a
    // write let through).
    const regexes = prof.match(/#"[^"]*"/g) ?? [];
    expect(regexes.length).toBeGreaterThan(0);
    expect(regexes.filter((r) => /\{\d+(,\d*)?\}/.test(r))).toEqual([]);
    const denyOthers = lines.findIndex((x) =>
      x.includes(`/den-${"[A-Za-z0-9]".repeat(6)}(/|$)`),
    );
    const allowOwn = lines.findIndex((x) => x.startsWith("(allow file-write*"));
    expect(lines[denyOthers]).toMatch(
      /^\(deny file-write\* \(regex #"\^\/private\/tmp\/den-/,
    );
    expect(denyOthers).toBeLessThan(allowOwn);
    expect(lines[allowOwn]).toContain(realPath(dir));
    const a = bwrapArgs(p).join(" ");
    expect(a).toContain(`--bind ${realPath(dir)} ${realPath(dir)}`);
    removeSessionTmp(dir, base);
  });

  it("sandboxFor gives the session TMPDIR, TMP and TEMP: only when it applies", () => {
    const l = layout("env");
    const dir = makeSessionTmp(base);
    const on = sandboxFor(
      ["claude"],
      { ...l, sessionTmp: dir },
      {
        platform: "darwin",
        on: true,
        which: () => "/usr/bin/sandbox-exec",
      },
    );
    if (on.applied) {
      expect(on.env).toMatchObject({
        TMPDIR: realPath(dir) + "/",
        TMP: realPath(dir),
        TEMP: realPath(dir),
      });
    }
    const off = sandboxFor(
      ["claude"],
      { ...l, sessionTmp: dir },
      {
        platform: "darwin",
        on: false,
      },
    );
    expect(off.env.TMPDIR).toBeUndefined();
    const linux = sandboxFor(
      ["claude"],
      { ...l, sessionTmp: dir },
      {
        platform: "linux",
        on: true,
        which: () => "/usr/bin/bwrap",
        bwrapWorks: () => null,
      },
    );
    expect(linux.env).toMatchObject({ TMPDIR: realPath(dir) + "/" });
    removeSessionTmp(dir, base);
  });

  it("the refusal note: a refused socket says to use $TMPDIR; Den's own host socket keeps the state note", () => {
    const env = { DEN_AGENT_SANDBOX: "1", TMPDIR: "/tmp/den-abc123/" };
    const note = (text: string) =>
      refusalNote(
        { hook_event_name: "PostToolUse", tool_response: { stdout: text } },
        env,
      )?.hookSpecificOutput.additionalContext;
    const own = note("Error: connect EPERM /tmp/other/x.sock");
    expect(own).toMatch(/unix socket outside your own temp folder/);
    expect(own).toContain("/tmp/den-abc123/");
    expect(own).not.toMatch(/state is read-only/);
    expect(note("connect EPERM /x/state/sessions.sock")).toBe(REFUSAL_NOTE);
    expect(note("rm: x: Operation not permitted")).toBe(REFUSAL_NOTE);
  });

  it("noteEnded removes an exited session's folder; a running or unlisted one keeps it", () => {
    const l = layout("ended");
    const ended = makeSessionTmp(base);
    const running = makeSessionTmp(base);
    const away = makeSessionTmp(base);
    const rec = (id: string, sid: string, dir: string) =>
      ({
        id,
        session: { backend: "den-pty", id: sid },
        sessionTmp: dir,
      }) as unknown as AgentRecord;
    const recs = [
      rec("a1", "s1", ended),
      rec("a2", "s2", running),
      rec("a3", "s3", away),
    ];
    noteEnded(
      l.stateDir,
      [
        { ref: { backend: "den-pty", id: "s1" }, exited: true, exitCode: 0 },
        { ref: { backend: "den-pty", id: "s2" }, exited: false },
      ] as never,
      recs,
      base,
    );
    expect(fs.existsSync(ended)).toBe(false);
    expect(recs[0].sessionTmp).toBeUndefined();
    expect(fs.existsSync(running)).toBe(true);
    // The host doesn't list it (it may just be away): kept.
    expect(fs.existsSync(away)).toBe(true);
    for (const d of [running, away]) removeSessionTmp(d, base);
  });

  it("doctor names a den-XXXXXX folder no record names", () => {
    const named = makeSessionTmp(base);
    const left = makeSessionTmp(base);
    expect(leftoverSessionTmps([named], base)).toEqual([realPath(left)]);
    for (const d of [named, left]) removeSessionTmp(d, base);
  });
});

describe("issue 1325: agents start and stop", () => {
  const record = (stateDir: string, id: string) =>
    JSON.parse(
      fs.readFileSync(path.join(stateDir, "agents", `${id}.json`), "utf-8"),
    ) as AgentRecord;

  it("a sandboxed start makes the folder, gives it to the sandbox and records it; stop removes it", async () => {
    const seen: (string | undefined)[] = [];
    const r = await rig({
      sessionTmp: () => makeSessionTmp(base),
      sessionTmpBase: base,
      agentSandbox: (argv, _id, tmp) => {
        seen.push(tmp);
        return {
          applied: true,
          argv,
          env: (tmp ? { TMPDIR: `${tmp}/` } : {}) as Record<string, string>,
        };
      },
    });
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    await settle();
    const dir = record(r.stateDir, "planner").sessionTmp!;
    expect(dir).toMatch(/\/den-[A-Za-z0-9]{6}$/);
    expect(seen).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(true);
    expect(r.made[0].opts.env.TMPDIR).toBe(`${dir}/`);
    expect(await cmdAgents(["stop", "planner"], r.deps)).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
    expect(record(r.stateDir, "planner").sessionTmp).toBeUndefined();
  }, 30_000);

  it("a start the sandbox doesn't apply to keeps no folder", async () => {
    let made = "";
    const r = await rig({
      sessionTmp: () => (made = makeSessionTmp(base)),
      sessionTmpBase: base,
      agentSandbox: (argv) => ({
        applied: false,
        argv,
        env: {},
        reason: "no sandbox here",
      }),
    });
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    expect(made).not.toBe("");
    expect(fs.existsSync(made)).toBe(false);
    expect(record(r.stateDir, "planner").sessionTmp).toBeUndefined();
  }, 30_000);
});

/** The real OS sandbox, when this process can start it. */
function realTool(): "darwin" | "linux" | null {
  if (process.platform === "darwin") {
    const r = spawnSync("/usr/bin/sandbox-exec", [
      "-p",
      "(version 1)(allow default)",
      "/usr/bin/true",
    ]);
    return r.status === 0 ? "darwin" : null;
  }
  if (process.platform === "linux") {
    const r = spawnSync("bwrap", ["--dev-bind", "/", "/", "true"]);
    if (r.status === 0) return "linux";
  }
  return null;
}
const real = realTool();
const itReal = real ? it : it.skip;
const itMac = real === "darwin" ? it : it.skip;

/** A node probe in the sandbox: what connecting to `sock` did. */
const probe = (sock: string) =>
  `require("net").connect(${JSON.stringify(sock)}).on("connect",()=>{console.log("connected");process.exit(0)}).on("error",(e)=>{console.log("refused "+e.code);process.exit(0)})`;

function run(
  l: ReturnType<typeof layout>,
  dir: string | undefined,
  script: string,
): string {
  const w = sandboxFor(
    [process.execPath, "-e", script],
    { ...l, ...(dir ? { sessionTmp: dir } : {}) },
    {
      platform: process.platform,
      on: true,
    },
  );
  expect(w.applied).toBe(true);
  const r = spawnSync(w.argv[0]!, w.argv.slice(1), {
    encoding: "utf-8",
    env: { ...process.env, ...w.env },
  });
  return `${r.stdout}${r.stderr}`.trim();
}

/** A short folder of this test's under /tmp, named like a session's. */
const ownTmp = () => fs.realpathSync(fs.mkdtempSync("/tmp/den-"));

/** In the wrap: listen on `name` under $TMPDIR, then connect to it. */
const listenAndConnect = (name: string) =>
  `const net=require("net"),p=require("path").join(process.env.TMPDIR,${JSON.stringify(name)});` +
  `const s=net.createServer(c=>c.end("hi")).listen(p,()=>{net.connect(p).on("connect",()=>{console.log("connected");s.close();process.exit(0)}).on("error",e=>{console.log("refused "+e.code);s.close();process.exit(0)})}).on("error",e=>{console.log("listen "+e.code);process.exit(0)})`;

/**
 * In the wrap: make a link (`kind`) at $TMPDIR/l.sock to `target`, then
 * connect through it. "link-refused <code>" when the link itself is.
 */
const linkAndConnect = (kind: "symlink" | "hard", target: string) =>
  `const net=require("net"),fs=require("fs"),p=require("path").join(process.env.TMPDIR,"l.sock");` +
  `try{fs.${kind === "hard" ? "linkSync" : "symlinkSync"}(${JSON.stringify(target)},p)}catch(e){console.log("link-refused "+e.code);process.exit(0)}` +
  `net.connect(p).on("connect",()=>{console.log("connected");process.exit(0)}).on("error",e=>{console.log("refused "+e.code);process.exit(0)})`;

/** A server listening at `p` (its folder made first, 0700). */
function listenAt(p: string): Promise<net.Server> {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  return new Promise((r) => {
    const sv = net.createServer((c) => c.end("hi\n"));
    sv.listen(p, () => r(sv));
  });
}

describe("issue 1325, in the real sandbox", () => {
  // Red on code without the fix: its folder is given as TMPDIR by hand, so
  // the case needs nothing new; only the sandbox's allow makes it connect.
  itReal(
    "a server on a socket in the session's own temp folder takes a connection from the same session",
    () => {
      const l = layout("real-own");
      const dir = ownTmp();
      try {
        const w = sandboxFor(
          [process.execPath, "-e", listenAndConnect("own.sock")],
          { ...l, sessionTmp: dir },
          { platform: process.platform, on: true },
        );
        expect(w.applied).toBe(true);
        const r = spawnSync(w.argv[0]!, w.argv.slice(1), {
          encoding: "utf-8",
          env: { ...process.env, TMPDIR: `${dir}/`, ...w.env },
        });
        expect(`${r.stdout}${r.stderr}`.trim()).toBe("connected");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  itReal(
    "the same, with the folder agents start makes (makeSessionTmp)",
    () => {
      const l = layout("real-made");
      const dir = makeSessionTmp();
      try {
        expect(run(l, dir, listenAndConnect("own.sock"))).toBe("connected");
      } finally {
        removeSessionTmp(dir);
      }
    },
  );

  itMac(
    "a socket outside its folder stays refused, and so does the session host's",
    async () => {
      const l = layout("real-out");
      const dir = makeSessionTmp();
      const outside = path.join(base, "out-0700", "o.sock");
      const host = path.join(realPath(l.stateDir), "sessions.sock");
      const live = await Promise.all([listenAt(outside), listenAt(host)]);
      try {
        expect(run(l, dir, probe(outside))).toMatch(/^refused/);
        expect(run(l, dir, probe(host))).toMatch(/^refused/);
      } finally {
        for (const sv of live) sv.close();
        removeSessionTmp(dir);
      }
    },
  );

  itMac(
    "a link in its folder to a refused socket gets nowhere: symlink or hard link, the host's or another program's",
    async () => {
      const l = layout("real-link");
      const outside = path.join(base, "link-0700", "o.sock");
      const host = path.join(realPath(l.stateDir), "sessions.sock");
      const live = await Promise.all([listenAt(outside), listenAt(host)]);
      try {
        for (const kind of ["symlink", "hard"] as const)
          for (const target of [outside, host]) {
            const dir = makeSessionTmp();
            try {
              const out = run(l, dir, linkAndConnect(kind, target));
              expect({ kind, target, out }).toEqual({
                kind,
                target,
                out: expect.stringMatching(/^(refused|link-refused) /),
              });
            } finally {
              removeSessionTmp(dir);
            }
          }
      } finally {
        for (const sv of live) sv.close();
      }
    },
  );

  itMac("it can't write another session's temp folder", () => {
    const l = layout("real-other");
    const mine = makeSessionTmp();
    const theirs = makeSessionTmp();
    try {
      const out = run(
        l,
        mine,
        `try{require("fs").writeFileSync(${JSON.stringify(path.join(theirs, "planted"))},"x");console.log("wrote")}catch(e){console.log("refused "+e.code)}`,
      );
      expect(out).toMatch(/^refused/);
      expect(fs.existsSync(path.join(theirs, "planted"))).toBe(false);
    } finally {
      removeSessionTmp(mine);
      removeSessionTmp(theirs);
    }
  });
});
