/**
 * D18: `service install` modes and the session host's job.
 *
 *   login   LaunchAgents in gui/<uid> (the desktop session: stop at logout)
 *   always  LaunchDaemons that run as the person (UserName), kept across
 *           logout; written and loaded through sudo
 *
 * The host job runs a copy of node Den owns (DEN_SERVICE_HOST_EXE, 0700),
 * the path Full Disk Access is granted to. A node change replaces it and
 * says when the grant must be given again.
 *
 * launchctl, sudo, codesign and otool are shims on PATH: nothing reaches
 * this machine's launchd, root or keychain.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = path.resolve(__dirname, "../../..");
const script = path.join(root, "service", "install.sh");
const dist = path.join(root, "examples", "distribution");
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

interface Rig {
  t: string;
  home: string;
  daemons: string;
  exe: string;
  node: string;
  calls: string;
  env: Record<string, string>;
}

function rig(
  requirement = "identifier node and anchor apple generic and certificate leaf[subject.OU] = TEAM1",
): Rig {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "den-svc-mode-"));
  tmps.push(t);
  const bin = path.join(t, "shims");
  fs.mkdirSync(bin);
  const calls = path.join(t, "calls.log");
  const shim = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  // launchctl: logs; `print` says not loaded (so install's wait ends at once).
  shim(
    "launchctl",
    `echo "launchctl $*" >> "${calls}"\n[ "$1" = print ] && exit 113\nexit 0`,
  );
  // sudo: logs, then runs the command as this user (dropping install's owner flags).
  shim(
    "fakesudo",
    `echo "sudo $*" >> "${calls}"\nif [ "$1" = install ]; then shift; while [ "$1" = -o ] || [ "$1" = -g ]; do shift 2; done; exec install "$@"; fi\nexec "$@"`,
  );
  // The signer is per file: a copy of a node marked "other" is TEAM2's.
  shim(
    "codesign",
    `echo "Executable=$3"\nif grep -q other "$3"; then echo "designated => identifier node and certificate leaf[subject.OU] = TEAM2"; else echo "designated => $(cat "${t}/req")"; fi`,
  );
  shim("otool", `echo "$2:"\necho "	/usr/lib/libc++.1.dylib"`);
  fs.writeFileSync(path.join(t, "req"), requirement);
  const node = path.join(t, "node-a");
  fs.writeFileSync(node, "#!/bin/sh\necho 22\n", { mode: 0o755 });
  const home = path.join(t, "home");
  fs.mkdirSync(home);
  const daemons = path.join(t, "LaunchDaemons");
  fs.mkdirSync(daemons);
  const exe = path.join(t, "state", "bin", "acme-sessions-host");
  return {
    t,
    home,
    daemons,
    exe,
    node,
    calls,
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      DEN_ROOT: dist,
      DEN_SERVICE_LABEL: "local.acme-test.web",
      DEN_SERVICE_LOGS: path.join(t, "logs"),
      DEN_SERVICE_NODE: node,
      DEN_SERVICE_HOST_EXE: exe,
      DEN_SERVICE_DAEMON_DIR: daemons,
      DEN_SERVICE_SUDO: path.join(bin, "fakesudo"),
      DEN_SERVICE_READY_CHECK: "external",
    },
  };
}

const run = (r: Rig, args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [script, ...args], {
    encoding: "utf-8",
    env: { ...r.env, ...env },
  });

const plistKey = (xml: string, key: string) =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1];

const mac = process.platform === "darwin" ? it : it.skip;

describe("service plists by mode", () => {
  it("always: runs as the person (UserName); login: no UserName", () => {
    const r = rig();
    const always = run(r, ["print"], { DEN_SERVICE_MODE: "always" });
    expect(always.status).toBe(0);
    expect(plistKey(always.stdout, "UserName")).toBe(os.userInfo().username);
    const login = run(r, ["print"]);
    expect(login.status).toBe(0);
    expect(login.stdout).not.toContain("<key>UserName</key>");
  });

  it("the host job runs `<cli> sessions host` on Den's node copy, under its own label", () => {
    const r = rig();
    const out = run(r, ["print-host"], { DEN_SERVICE_MODE: "always" });
    expect(out.status).toBe(0);
    expect(plistKey(out.stdout, "Label")).toBe("local.acme-test.sessions");
    const argv =
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
        out.stdout,
      )![1];
    const args = [...argv.matchAll(/<string>([^<]*)<\/string>/g)].map(
      (m) => m[1],
    );
    expect(args[0]).toBe(r.exe);
    // --stand-by: it waits out a host started before it (D18).
    expect(args.slice(-3)).toEqual(["sessions", "host", "--stand-by"]);
    expect(out.stdout).toMatch(
      /<string>sessions<\/string>\s*<string>host<\/string>/,
    );
    expect(out.stdout).toContain("sessions-host.log");
    // print never copies node.
    expect(fs.existsSync(r.exe)).toBe(false);
  });

  it("refuses an unknown mode", () => {
    const r = rig();
    const out = run(r, ["print"], { DEN_SERVICE_MODE: "sometimes" });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/login or always/);
  });
});

describe("service install --mode always", () => {
  mac(
    "writes both LaunchDaemons through sudo, loads them in system, and removes the LaunchAgents",
    () => {
      const r = rig();
      const agents = path.join(r.home, "Library", "LaunchAgents");
      fs.mkdirSync(agents, { recursive: true });
      fs.writeFileSync(path.join(agents, "local.acme-test.web.plist"), "old");
      const out = run(r, ["install"], { DEN_SERVICE_MODE: "always" });
      expect(out.stderr).toBe("");
      expect(out.status).toBe(0);
      expect(
        fs.existsSync(path.join(r.daemons, "local.acme-test.web.plist")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(r.daemons, "local.acme-test.sessions.plist")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(agents, "local.acme-test.web.plist")),
      ).toBe(false);
      const calls = fs.readFileSync(r.calls, "utf-8");
      expect(calls).toContain(
        `sudo launchctl bootstrap system ${r.daemons}/local.acme-test.sessions.plist`,
      );
      expect(calls).toContain(
        `sudo launchctl bootstrap system ${r.daemons}/local.acme-test.web.plist`,
      );
      expect(calls).toContain(
        `launchctl bootout gui/${process.getuid!()}/local.acme-test.web`,
      );
      // Den's own node copy, owner-only.
      expect(fs.readFileSync(r.exe, "utf-8")).toBe(
        fs.readFileSync(r.node, "utf-8"),
      );
      expect(fs.statSync(r.exe).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(r.exe)).mode & 0o777).toBe(0o700);
    },
  );

  mac(
    "login: LaunchAgents in gui/<uid>, never sudo, and the daemons removed",
    () => {
      const r = rig();
      fs.writeFileSync(
        path.join(r.daemons, "local.acme-test.web.plist"),
        "old",
      );
      const out = run(r, ["install"]);
      expect(out.status).toBe(0);
      const agents = path.join(r.home, "Library", "LaunchAgents");
      expect(
        fs.existsSync(path.join(agents, "local.acme-test.web.plist")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(agents, "local.acme-test.sessions.plist")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(r.daemons, "local.acme-test.web.plist")),
      ).toBe(false);
      const calls = fs.readFileSync(r.calls, "utf-8");
      expect(calls).toContain(
        `launchctl bootstrap gui/${process.getuid!()} ${agents}/local.acme-test.web.plist`,
      );
      // sudo only to remove the old daemon, never to load.
      expect(calls).not.toMatch(/sudo launchctl bootstrap/);
    },
  );
});

describe("Den's node copy and Full Disk Access", () => {
  mac("the same node: the copy is left alone", () => {
    const r = rig();
    expect(run(r, ["install"]).status).toBe(0);
    const before = fs.statSync(r.exe).mtimeMs;
    const again = run(r, ["install"]);
    expect(again.status).toBe(0);
    expect(fs.statSync(r.exe).mtimeMs).toBe(before);
    expect(again.stderr).toBe("");
  });

  mac(
    "a new node with the same signer: replaced, the grant holds (nothing said)",
    () => {
      const r = rig();
      expect(run(r, ["install"]).status).toBe(0);
      fs.writeFileSync(r.node, "#!/bin/sh\necho 22 # newer\n");
      const out = run(r, ["install"]);
      expect(out.status).toBe(0);
      expect(fs.readFileSync(r.exe, "utf-8")).toContain("newer");
      expect(out.stderr).toBe("");
    },
  );

  mac("a new signer: says to grant Full Disk Access again", () => {
    const r = rig();
    expect(run(r, ["install"]).status).toBe(0);
    fs.writeFileSync(r.node, "#!/bin/sh\necho 22 # other\n");
    const out = run(r, ["install"]);
    expect(out.stderr).toContain(
      `${r.exe} changed signer: grant it Full Disk Access again`,
    );
  });

  mac("an ad-hoc signed node: says every change needs a new grant", () => {
    const r = rig('cdhash H"24408d31"');
    const out = run(r, ["install"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toMatch(
      /no stable code signature: Full Disk\s+Access must be granted to it again after every node change/,
    );
  });

  mac(
    "a node that is not self-contained (Homebrew's) is run directly, and says so",
    () => {
      const r = rig();
      fs.writeFileSync(
        path.join(r.t, "shims", "otool"),
        `#!/bin/sh\necho "$2:"\necho "	@rpath/libnode.147.dylib"\n`,
        { mode: 0o755 },
      );
      const out = run(r, ["install"]);
      expect(out.status).toBe(0);
      expect(fs.existsSync(r.exe)).toBe(false);
      expect(out.stderr).toMatch(/is not self-contained/);
      const plist = fs.readFileSync(
        path.join(
          r.home,
          "Library",
          "LaunchAgents",
          "local.acme-test.sessions.plist",
        ),
        "utf-8",
      );
      expect(plist).toContain(`<string>${r.node}</string>`);
    },
  );
});

describe("the node the host copy comes from", () => {
  mac(
    "Homebrew's node for the jobs, but the host's copy from the PATH's self-contained node",
    () => {
      const r = rig();
      const nvm = path.join(r.t, ".nvm", "versions", "node", "v22.1.0", "bin");
      fs.mkdirSync(nvm, { recursive: true });
      fs.writeFileSync(path.join(nvm, "node"), "#!/bin/sh\necho 22 # nvm\n", {
        mode: 0o755,
      });
      const brew = path.join(r.t, "brew", "node");
      fs.mkdirSync(path.dirname(brew));
      fs.writeFileSync(brew, "#!/bin/sh\necho 22 # brew\n", { mode: 0o755 });
      fs.writeFileSync(
        path.join(r.t, "shims", "otool"),
        `#!/bin/sh\necho "$2:"\ncase "$2" in */brew/*) echo "	@rpath/libnode.147.dylib";; *) echo "	/usr/lib/libc++.1.dylib";; esac\n`,
        { mode: 0o755 },
      );
      const { DEN_SERVICE_NODE: _n, ...env } = r.env;
      const out = spawnSync("bash", [script, "install"], {
        encoding: "utf-8",
        env: {
          ...env,
          PATH: `${path.join(r.t, "shims")}:${nvm}:/usr/bin:/bin:/usr/sbin:/sbin`,
          DEN_SERVICE_STABLE_NODES: brew,
        },
      });
      expect(out.status).toBe(0);
      expect(out.stderr).not.toMatch(/not self-contained/);
      expect(fs.readFileSync(r.exe, "utf-8")).toContain("# nvm");
      const web = fs.readFileSync(
        path.join(
          r.home,
          "Library",
          "LaunchAgents",
          "local.acme-test.web.plist",
        ),
        "utf-8",
      );
      expect(web).toContain(`<string>${brew}</string>`);
    },
  );
});

describe("service status", () => {
  mac("plist present, job not loaded: the bootstrap fix", () => {
    const r = rig();
    fs.writeFileSync(
      path.join(r.daemons, "local.acme-test.web.plist"),
      "<plist/>",
    );
    const out = run(r, ["status"]);
    expect(out.stdout).toContain(
      `plist present, job not loaded: sudo launchctl bootstrap system ${r.daemons}/local.acme-test.web.plist`,
    );
    expect(out.stdout).toContain("local.acme-test.sessions is not loaded");
  });
});
