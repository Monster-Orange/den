import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type OsUserPlatform = "darwin" | "linux";

const PERSON_RE = /^[a-z_][a-z0-9_-]{0,15}$/;
const SAFE_PATH_RE = /^\/[A-Za-z0-9._/@+-]*$/;

export const SUDO_GROUPS = ["sudo", "wheel", "admin", "root"] as const;
export const NO_LOGIN_SHELLS = [
  "/usr/sbin/nologin",
  "/sbin/nologin",
  "/usr/bin/false",
  "/bin/false",
] as const;
export const LAUNCH_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "TERM",
  "DEN_AGENT_ID",
] as const;
const LAUNCH_ID_MAX = 64;

export interface OsUserLayout {
  platform: OsUserPlatform;
  person: string;
  personHome: string;
  root: string;
  runtime: { bin: string; script: string; engineRoot?: string };
  noLogin: string;
  ids?: { uid: number; gid: number };
}

export function osUserNames(
  platform: OsUserPlatform,
  person: string,
): { user: string; group: string } {
  if (!PERSON_RE.test(person))
    throw new Error(
      `"${person}" is not a login name Den can use for the agents' own login (lower case letters, digits, _ and -, up to 16)`,
    );
  return platform === "darwin"
    ? { user: `_den_agents_${person}`, group: `_den_${person}` }
    : { user: `den-agents-${person}`, group: `den-${person}` };
}

export function osUserPaths(root: string, person: string) {
  const dir = path.posix.join(root, person);
  const bin = path.posix.join(dir, "bin");
  const agents = path.posix.join(dir, "agents");
  return {
    dir,
    bin,
    launcher: path.posix.join(bin, "den-agent-launch"),
    agents,
    home: path.posix.join(dir, "home"),
    sudoers: `/etc/sudoers.d/den-${person}`,
  };
}

export function sudoersLine(o: {
  person: string;
  user: string;
  launcher: string;
}): string {
  if (!SAFE_PATH_RE.test(o.launcher))
    throw new Error(
      `the launcher path "${o.launcher}" has characters sudo would read as a pattern`,
    );
  return `${o.person} ALL=(${o.user}) NOPASSWD: ${o.launcher}`;
}

export function sudoersRuleProblem(
  text: string,
  o: { person: string; user: string; launcher: string },
): string | null {
  const t = text.trim();
  if (t.includes("\n")) return "the rule file holds more than the one rule";
  const m = /^(\S+)\s+ALL=\(([^)]*)\)\s+NOPASSWD:\s+(.+)$/.exec(t);
  if (!m) return `not the launcher's rule: ${t}`;
  if (m[1] !== o.person) return `the rule is for "${m[1]}", not ${o.person}`;
  if (m[2] !== o.user)
    return `the rule runs as "${m[2]}": it may run only as ${o.user}`;
  if (m[3] !== o.launcher)
    return `the rule lets "${m[3]}" run: it may run only ${o.launcher}`;
  return null;
}

export function listedRulesProblem(
  rules: readonly string[],
  o: { user: string; launcher: string },
): string | null {
  const want = `(${o.user}) NOPASSWD: ${o.launcher}`;
  const mine = rules
    .map((r) => r.trim())
    .filter((r) =>
      (/^\(([^)]*)\)/.exec(r)?.[1] ?? "")
        .split(/[,:]/)
        .map((x) => x.trim())
        .includes(o.user),
    );
  if (mine.length === 0) return `no sudo rule lets you run ${o.launcher}`;
  const extra = mine.filter((r) => r !== want);
  if (extra.length)
    return `a sudo rule lets more than the launcher run as ${o.user}: ${extra.join("; ")}`;
  return null;
}

const shQuote = (s: string) => `'${s}'`;

export function launcherScript(o: {
  person: string;
  user: string;
  home: string;
  runtime: { bin: string; script: string };
}): string {
  for (const [what, p] of [
    ["runtime", o.runtime.bin],
    ["runtime script", o.runtime.script],
    ["home", o.home],
  ] as const)
    if (!SAFE_PATH_RE.test(p))
      throw new Error(
        `the ${what} path "${p}" must be absolute, with letters, digits and . _ / @ + - only`,
      );
  osUserNames("linux", o.person);
  return `#!/bin/sh
# Den's agent launcher (issue 988), for ${o.person}'s agents. Root's:
# \`agents os-login setup\` wrote it, and doctor checks it is unchanged.
set -eu
# Bracket ranges below mean ASCII, whatever locale sudo kept.
LC_ALL=C
export LC_ALL
if [ "$#" -ne 2 ]; then
  echo "den-agent-launch: give one agent id and Den's launch nonce" >&2
  exit 64
fi
id=$1
nonce=$2
case "$nonce" in
  *[!0-9a-f]*)
    echo "den-agent-launch: that is not Den's launch nonce" >&2
    exit 64 ;;
esac
if [ "\${#nonce}" -ne 32 ]; then
  echo "den-agent-launch: that is not Den's launch nonce" >&2
  exit 64
fi
case "$id" in
  "" | [!A-Za-z0-9]* | *[!A-Za-z0-9._-]*)
    echo "den-agent-launch: that is not an agent id" >&2
    exit 64 ;;
esac
if [ "\${#id}" -gt ${LAUNCH_ID_MAX} ]; then
  echo "den-agent-launch: that is not an agent id" >&2
  exit 64
fi
term=\${TERM:-dumb}
case "$term" in
  "" | *[!A-Za-z0-9._+-]*) term=dumb ;;
esac
# Start in the login's own home, never the folder sudo was run from: a
# node_modules or a .npmrc there is not the login's to have loaded.
cd ${shQuote(o.home)}
exec /usr/bin/env -i HOME=${shQuote(o.home)} USER=${shQuote(o.user)} LOGNAME=${shQuote(o.user)} \\
  PATH='/usr/bin:/bin:/usr/sbin:/sbin' LANG='C.UTF-8' TERM="$term" DEN_AGENT_ID="$id" \\
  ${shQuote(o.runtime.bin)} ${shQuote(o.runtime.script)} agents session "$id" "$nonce"
`;
}

export interface PlanStep {
  say: string;
  argv: string[];
  optional?: boolean;
  stdin?: string;
  expect?: string;
  cleanup?: string[][];
}

const rootGroup = (p: OsUserPlatform) => (p === "darwin" ? "wheel" : "root");

function rootWrite(
  what: string,
  dest: string,
  text: string,
  rg: string,
  mode: string,
  check?: { say: string; argv: string[] },
): PlanStep[] {
  const tmp = `${dest}.new`;
  const dropTmp = [["rm", "-f", tmp]];
  return [
    {
      say: `Write ${what} (as shown above, from Den, not from a file) to ${tmp}, a file only root can write`,
      argv: ["tee", tmp],
      stdin: text,
      cleanup: dropTmp,
    },
    {
      say: `Make ${tmp} root's`,
      argv: ["chown", `root:${rg}`, tmp],
      cleanup: dropTmp,
    },
    {
      say: `Make ${tmp} ${mode}`,
      argv: ["chmod", mode, tmp],
      cleanup: dropTmp,
    },
    {
      say: `Read ${tmp} back: it must be exactly what was shown`,
      argv: ["cat", tmp],
      expect: text,
      cleanup: dropTmp,
    },
    ...(check ? [{ ...check, cleanup: dropTmp }] : []),
    {
      say: `Put ${what} in place at ${dest}`,
      argv: ["mv", "-f", tmp, dest],
      cleanup: dropTmp,
    },
    {
      say: `Read ${dest} back: it must be exactly what was shown`,
      argv: ["cat", dest],
      expect: text,
      cleanup: [["rm", "-f", dest]],
    },
  ];
}

export function setupPaths(l: OsUserLayout): string[] {
  const p = osUserPaths(l.root, l.person);
  return [
    l.root,
    p.dir,
    p.bin,
    p.home,
    p.agents,
    p.launcher,
    `${p.launcher}.new`,
    p.sudoers,
    `${p.sudoers}.new`,
  ];
}

export function setupPlan(
  l: OsUserLayout,
  text: { launcher: string; sudoers: string },
  have: { user: boolean; group: boolean; homeMode?: number } = {
    user: false,
    group: false,
  },
): PlanStep[] {
  const n = osUserNames(l.platform, l.person);
  const p = osUserPaths(l.root, l.person);
  const rg = rootGroup(l.platform);
  const steps: PlanStep[] = [
    {
      say: "Check none of the paths setup writes is a link (a re-run would follow it)",
      argv: [
        "/bin/sh",
        "-c",
        'for p in "$@"; do if [ -h "$p" ]; then echo "$p is a link" >&2; exit 1; fi; done',
        "sh",
        ...setupPaths(l),
      ],
    },
  ];
  if (l.platform === "linux") {
    if (!have.group)
      steps.push({
        say: `Make the group ${n.group}, for you and your agents`,
        argv: ["groupadd", "--system", n.group],
      });
    if (!have.user)
      steps.push({
        say: `Make the agents' login ${n.user}: a system login with no shell, its home beside the launcher, root's folder`,
        argv: [
          "useradd",
          "--system",
          "--gid",
          n.group,
          "--home-dir",
          p.home,
          "--no-create-home",
          "--shell",
          l.noLogin,
          n.user,
        ],
      });
    steps.push({
      say: `Add you (${l.person}) to ${n.group}`,
      argv: ["usermod", "--append", "--groups", n.group, l.person],
    });
  } else {
    if (!l.ids && !(have.user && have.group))
      throw new Error("macOS: the setup needs a free system uid and gid");
    const ids = l.ids ?? { uid: 0, gid: 0 };
    const G = `/Groups/${n.group}`;
    const U = `/Users/${n.user}`;
    const dscl = (say: string, ...a: string[]): PlanStep => ({
      say,
      argv: ["dscl", ".", "-create", ...a],
    });
    if (!have.group)
      steps.push(
        dscl(`Make the group ${n.group}, for you and your agents`, G),
        dscl(
          `Give ${n.group} the system id ${ids.gid}`,
          G,
          "PrimaryGroupID",
          String(ids.gid),
        ),
        dscl(
          `Name the group, for the list of groups`,
          G,
          "RealName",
          `Den agents (${l.person})`,
        ),
      );
    if (!have.user)
      steps.push(
        dscl(`Make the agents' login ${n.user}`, U),
        dscl(
          `Give ${n.user} the system id ${ids.uid}`,
          U,
          "UniqueID",
          String(ids.uid),
        ),
        dscl(
          `Put ${n.user} in ${n.group}`,
          U,
          "PrimaryGroupID",
          String(ids.gid),
        ),
        dscl(`Give ${n.user} no login shell`, U, "UserShell", l.noLogin),
        dscl(
          `Set ${n.user}'s home, in Den's root folder`,
          U,
          "NFSHomeDirectory",
          p.home,
        ),
        dscl(
          `Name the login, for the list of logins`,
          U,
          "RealName",
          `Den agents (${l.person})`,
        ),
        dscl(`Hide ${n.user} from the login window`, U, "IsHidden", "1"),
        dscl(
          `Give ${n.user} no password (it can't log in)`,
          U,
          "Password",
          "*",
        ),
      );
    steps.push({
      say: `Add you (${l.person}) to ${n.group}`,
      argv: [
        "dseditgroup",
        "-o",
        "edit",
        "-a",
        l.person,
        "-t",
        "user",
        n.group,
      ],
    });
  }
  steps.push(
    {
      say: `Make ${p.bin}, ${p.dir} and ${l.root} root's, so only root can make or change anything in them`,
      argv: [
        "install",
        "-d",
        "-o",
        "root",
        "-g",
        rg,
        "-m",
        "0755",
        l.root,
        p.dir,
        p.bin,
      ],
    },
    {
      say: `Make ${n.user}'s home ${p.home}, its own, in root's folder`,
      argv: [
        "install",
        "-d",
        "-o",
        n.user,
        "-g",
        n.group,
        "-m",
        "0700",
        p.home,
      ],
    },
    {
      say: `Make the agent files folder ${p.agents}: yours; the group reads it, and only you add to it`,
      argv: [
        "install",
        "-d",
        "-o",
        l.person,
        "-g",
        n.group,
        "-m",
        "2750",
        p.agents,
      ],
    },
    ...(have.homeMode !== undefined && (have.homeMode & 0o077) !== 0
      ? [
          {
            say: `Close your home ${l.personHome} to everyone but you (0700), so the agents' login can't read your files`,
            argv: ["chmod", "0700", l.personHome],
          },
        ]
      : []),
    ...rootWrite("the launcher", p.launcher, text.launcher, rg, "0555"),
    ...rootWrite("the sudo rule", p.sudoers, text.sudoers, rg, "0440", {
      say: "Check the sudo rule with visudo before it is put in place",
      argv: ["visudo", "-c", "-f", `${p.sudoers}.new`],
    }),
  );
  return steps;
}

export type PlanRunner = (
  argv: string[],
  stdin?: string,
) => { ok: boolean; stdout?: string; error?: string };

export function runPlan(
  steps: PlanStep[],
  run: PlanRunner,
): { ok: true } | { ok: false; index: number; error: string } {
  for (const [index, s] of steps.entries()) {
    const r = run(s.argv, s.stdin);
    const differs = s.expect !== undefined && r.ok && r.stdout !== s.expect;
    if (r.ok && !differs) continue;
    if (!differs && s.optional) continue;
    for (const c of s.cleanup ?? []) run(c);
    return {
      ok: false,
      index,
      error: differs
        ? "what root wrote is not what was shown, so it was removed"
        : (r.error ?? "it failed"),
    };
  }
  return { ok: true };
}

export function removePlan(l: OsUserLayout): PlanStep[] {
  const n = osUserNames(l.platform, l.person);
  const p = osUserPaths(l.root, l.person);
  const steps: PlanStep[] = [
    {
      say: `Remove the sudo rule ${p.sudoers}`,
      argv: ["rm", "-f", p.sudoers],
      optional: true,
    },
  ];
  if (l.platform === "linux")
    steps.push(
      {
        say: `Remove the agents' login ${n.user}`,
        argv: ["userdel", n.user],
        optional: true,
      },
      {
        say: `Remove the group ${n.group}`,
        argv: ["groupdel", n.group],
        optional: true,
      },
    );
  else
    steps.push(
      {
        say: `Remove the agents' login ${n.user}`,
        argv: ["dscl", ".", "-delete", `/Users/${n.user}`],
        optional: true,
      },
      {
        say: `Remove the group ${n.group}`,
        argv: ["dscl", ".", "-delete", `/Groups/${n.group}`],
        optional: true,
      },
    );
  steps.push(
    {
      say: `Remove ${p.dir}: the launcher and the agent files`,
      argv: ["rm", "-rf", p.dir],
      optional: true,
    },
    {
      say: `Remove ${l.root} if nothing else is in it`,
      argv: ["rmdir", l.root],
      optional: true,
    },
  );
  return steps;
}

export interface StatFacts {
  uid: number;
  mode: number;
}

export interface OsUserFacts {
  user: {
    exists: boolean;
    uid?: number;
    shell?: string;
    home?: string;
    groups?: string[];
  };
  group: { exists: boolean; members?: string[] };
  personUid: number;
  personHome: (StatFacts & { acl: string[] }) | null;
  sudoers: StatFacts | null;
  personRules: string[] | null;
  launcher: (StatFacts & { text: string }) | null;
  launcherChain: (StatFacts & { path: string })[];
  agentsDir: StatFacts | null;
  homeDir: StatFacts | null;
  stateDir: StatFacts | null;
  dir: boolean;
  runtime?: string[];
}

export interface OsUserCheck {
  status: "ok" | "warn" | "fail";
  detail: string;
  problems: string[];
}

const octal = (m: number) => (m & 0o7777).toString(8).padStart(4, "0");

const inside = (dir: string, p: string) =>
  p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

export function homeProblems(l: OsUserLayout, f: OsUserFacts): string[] {
  const out: string[] = [];
  const h = f.personHome;
  if (!h) out.push(`your home ${l.personHome} couldn't be read`);
  else {
    if ((h.mode & 0o077) !== 0)
      out.push(
        `your home ${l.personHome} is ${octal(h.mode)}: the agents' login could read your files (it should be 0700; \`agents os-login setup\` closes it)`,
      );
    for (const e of h.acl)
      if (/\ballow\b/.test(e) && !e.startsWith(`user:${l.person} `))
        out.push(
          `your home ${l.personHome} has the ACL entry "${e}": it lets someone else in`,
        );
  }
  for (const r of [l.runtime.bin, l.runtime.script])
    if (inside(l.personHome, r))
      out.push(
        `Den's runtime ${r} is inside your home, which the agents' login must not read: install Den outside it`,
      );
  return out;
}

export function runtimeInHome(l: OsUserLayout): string[] {
  return [l.runtime.bin, l.runtime.script].filter((r) =>
    inside(l.personHome, r),
  );
}

export function osUserCheck(
  o: { on: boolean; layout: OsUserLayout; cli?: string },
  f: OsUserFacts,
): OsUserCheck {
  const l = o.layout;
  const cli = o.cli ?? "den";
  const n = osUserNames(l.platform, l.person);
  const p = osUserPaths(l.root, l.person);
  const problems: string[] = [];
  if (f.stateDir && (f.stateDir.mode & 0o077) !== 0)
    problems.push(
      `Den's state folder is ${octal(f.stateDir.mode)}: anyone but you could read it (it should be 0700)`,
    );

  if (o.on) problems.push(...homeProblems(l, f));
  if (o.on || f.user.exists)
    for (const r of f.runtime ?? [])
      problems.push(`Den's runtime: ${r}, and the agents' login runs it`);

  const present = [
    f.user.exists && `the login ${n.user}`,
    f.group.exists && `the group ${n.group}`,
    f.sudoers && `the sudo rule ${p.sudoers}`,
    f.dir && `the folder ${p.dir}`,
  ].filter((x): x is string => !!x);

  if (!o.on) {
    if (present.length === 0)
      return {
        status: problems.length ? "fail" : "ok",
        detail: problems.length
          ? problems.join("; ")
          : "agents run as you: their own login is not set up (agents.os_login is off)",
        problems,
      };
    problems.push(
      ...present.map(
        (x) =>
          `${x} is still here, but agents.os_login is off: \`${cli} agents os-login remove\` removes it`,
      ),
    );
    return { status: "fail", detail: problems.join("; "), problems };
  }

  if (present.length === 0) {
    problems.push(
      `agents.os_login is on, but the agents' login is not set up: run \`${cli} agents os-login setup\``,
    );
    return { status: "fail", detail: problems.join("; "), problems };
  }

  if (!f.user.exists) problems.push(`the agents' login ${n.user} is missing`);
  else {
    if (
      !f.user.shell ||
      !(NO_LOGIN_SHELLS as readonly string[]).includes(f.user.shell)
    )
      problems.push(
        `${n.user} has the login shell ${f.user.shell ?? "(unknown)"}: it should have none`,
      );
    if (f.user.home !== p.home)
      problems.push(
        `${n.user}'s home is ${f.user.home ?? "(unknown)"}: it should be ${p.home}`,
      );
    const sudo = (f.user.groups ?? []).filter((g) =>
      (SUDO_GROUPS as readonly string[]).includes(g),
    );
    if (sudo.length)
      problems.push(
        `${n.user} is in ${sudo.join(", ")}, so it could use sudo: take it out`,
      );
  }
  if (!f.group.exists) problems.push(`the group ${n.group} is missing`);
  else if (!(f.group.members ?? []).includes(l.person))
    problems.push(`you (${l.person}) are not in ${n.group}`);

  if (!f.sudoers) problems.push(`the sudo rule ${p.sudoers} is missing`);
  else if (f.sudoers.uid !== 0 || (f.sudoers.mode & 0o777) !== 0o440)
    problems.push(
      `the sudo rule ${p.sudoers} is ${octal(f.sudoers.mode)}, uid ${f.sudoers.uid}: it should be root's, 0440`,
    );
  let unknown = false;
  if (f.personRules === null) unknown = true;
  else {
    const bad = listedRulesProblem(f.personRules, {
      user: n.user,
      launcher: p.launcher,
    });
    if (bad) problems.push(bad);
  }

  if (!f.launcher) problems.push(`the launcher ${p.launcher} is missing`);
  else {
    if (f.launcher.uid !== 0)
      problems.push(
        `the launcher ${p.launcher} is not root's (uid ${f.launcher.uid})`,
      );
    if ((f.launcher.mode & 0o022) !== 0)
      problems.push(
        `the launcher ${p.launcher} is ${octal(f.launcher.mode)}: others can change it`,
      );
    const want = launcherScript({
      person: l.person,
      user: n.user,
      home: p.home,
      runtime: l.runtime,
    });
    if (f.launcher.text !== want)
      problems.push(
        `the launcher ${p.launcher} is not the one Den wrote: run \`${cli} agents os-login setup\` again`,
      );
  }
  for (const c of f.launcherChain)
    if (c.uid !== 0 || (c.mode & 0o022) !== 0)
      problems.push(
        `${c.path}, above the launcher, is ${octal(c.mode)}, uid ${c.uid}: only root may be able to change it`,
      );

  if (!f.agentsDir)
    problems.push(`the agent files folder ${p.agents} is missing`);
  else if (
    f.agentsDir.uid !== f.personUid ||
    (f.agentsDir.mode & 0o7777) !== 0o2750
  )
    problems.push(
      `${p.agents} is ${octal(f.agentsDir.mode)}, uid ${f.agentsDir.uid}: it should be yours, 2750`,
    );
  if (!f.homeDir) problems.push(`${n.user}'s home ${p.home} is missing`);
  else if (f.homeDir.uid !== f.user.uid || (f.homeDir.mode & 0o777) !== 0o700)
    problems.push(
      `${p.home} is ${octal(f.homeDir.mode)}, uid ${f.homeDir.uid}: it should be ${n.user}'s, 0700`,
    );

  if (problems.length)
    return { status: "fail", detail: problems.join("; "), problems };
  if (unknown)
    return {
      status: "warn",
      detail: `${n.user} is set up, but not in use yet: agents still run as you; your sudo rules couldn't be listed (sudo -n -l asked for a password), so the rule is checked by its file only`,
      problems,
    };
  return {
    status: "ok",
    detail: `${n.user} is set up, but not in use yet: agents still run as you. The launcher, its folders and the sudo rule are root's, and your home and Den's state are yours alone`,
    problems,
  };
}

export function writableChain(file: string): (StatFacts & { path: string })[] {
  const out: (StatFacts & { path: string })[] = [];
  let d = fs.realpathSync(path.dirname(file));
  for (;;) {
    const s = fs.statSync(d);
    out.push({ path: d, uid: s.uid, mode: s.mode });
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

export interface OsUserReadDeps {
  exec: (cmd: string, args: string[]) => { status: number; stdout: string };
  personUid: number;
  stat: (p: string) => StatFacts | null;
  read: (p: string) => string | null;
  chain: (p: string) => (StatFacts & { path: string })[];
  runtime?: (
    r: { bin: string; script: string; engineRoot: string },
    agents: { uid: number; gids: number[] },
  ) => string[];
}

export function readOsUserFacts(
  l: OsUserLayout,
  stateDir: string,
  d: OsUserReadDeps,
): OsUserFacts {
  const n = osUserNames(l.platform, l.person);
  const p = osUserPaths(l.root, l.person);
  const ok = (cmd: string, args: string[]) => {
    try {
      const r = d.exec(cmd, args);
      return r.status === 0 ? r.stdout : null;
    } catch {
      return null;
    }
  };
  const groupsOf = (u: string) =>
    (ok("id", ["-Gn", u]) ?? "").trim().split(/\s+/).filter(Boolean);

  let user: OsUserFacts["user"] = { exists: false };
  let group: OsUserFacts["group"] = { exists: false };
  if (l.platform === "linux") {
    const pw = ok("getent", ["passwd", n.user])?.trim().split(":");
    if (pw && pw.length >= 7)
      user = {
        exists: true,
        uid: idNumber(pw[2]),
        shell: pw[6],
        home: pw[5],
        groups: groupsOf(n.user),
      };
    const gr = ok("getent", ["group", n.group])?.trim().split(":");
    if (gr && gr.length >= 4)
      group = {
        exists: true,
        members: (gr[3] ?? "").split(",").filter(Boolean),
      };
  } else {
    const field = (text: string, key: string) =>
      new RegExp(`^${key}:\\s*(.*)$`, "m").exec(text)?.[1]?.trim();
    const u = ok("dscl", [
      ".",
      "-read",
      `/Users/${n.user}`,
      "UniqueID",
      "UserShell",
      "NFSHomeDirectory",
    ]);
    if (u !== null)
      user = {
        exists: true,
        uid: idNumber(field(u, "UniqueID")),
        shell: field(u, "UserShell"),
        home: field(u, "NFSHomeDirectory"),
        groups: groupsOf(n.user),
      };
    const g = ok("dscl", [
      ".",
      "-read",
      `/Groups/${n.group}`,
      "GroupMembership",
    ]);
    if (g !== null)
      group = {
        exists: true,
        members: (field(g, "GroupMembership") ?? "")
          .split(/\s+/)
          .filter(Boolean),
      };
  }

  const listed = user.exists || group.exists ? ok("sudo", ["-n", "-l"]) : "";
  const personRules =
    listed === null
      ? null
      : listed
          .split("\n")
          .map((x) => x.trim())
          .filter((x) =>
            (/^\(([^)]*)\)/.exec(x)?.[1] ?? "")
              .split(/[,:]/)
              .map((y) => y.trim())
              .includes(n.user),
          );

  const launcherStat = d.stat(p.launcher);
  const launcherText = launcherStat ? d.read(p.launcher) : null;
  return {
    user,
    group,
    personUid: d.personUid,
    sudoers: d.stat(p.sudoers),
    personRules,
    launcher: launcherStat
      ? { ...launcherStat, text: launcherText ?? "" }
      : null,
    launcherChain: launcherStat ? d.chain(p.launcher) : [],
    agentsDir: d.stat(p.agents),
    homeDir: d.stat(p.home),
    personHome: personHomeFacts(l, d, ok),
    stateDir: d.stat(stateDir),
    dir: d.stat(p.dir) !== null,
    ...(l.runtime.engineRoot && d.runtime
      ? {
          runtime: runtimeFacts(
            { ...l.runtime, engineRoot: l.runtime.engineRoot },
            user,
            ok("id", ["-G", n.user]),
            d.runtime,
          ),
        }
      : {}),
  };
}

const idNumber = (v: string | undefined): number =>
  v !== undefined && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;

function runtimeFacts(
  r: { bin: string; script: string; engineRoot: string },
  user: OsUserFacts["user"],
  idG: string | null,
  check: NonNullable<OsUserReadDeps["runtime"]>,
): string[] {
  if (!user.exists) return check(r, { uid: NO_LOGIN_YET, gids: [] });
  if (!Number.isInteger(user.uid)) return [UID_UNREAD];
  const gids = (idG ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
  if (!gids.length || gids.some((g) => !Number.isInteger(g)))
    return [GROUPS_UNREAD];
  return check(r, { uid: user.uid as number, gids });
}

function personHomeFacts(
  l: OsUserLayout,
  d: OsUserReadDeps,
  ok: (cmd: string, args: string[]) => string | null,
): OsUserFacts["personHome"] {
  const st = d.stat(l.personHome);
  if (!st) return null;
  const acl =
    l.platform === "darwin"
      ? (ok("/bin/ls", ["-led", l.personHome]) ?? "")
          .split("\n")
          .map((x) => /^\s*\d+:\s*(.+)$/.exec(x)?.[1]?.trim())
          .filter((x): x is string => !!x)
      : [];
  return { ...st, acl };
}

export function machineReadDeps(): OsUserReadDeps {
  return {
    exec: (cmd, args) => {
      const r = spawnSync(cmd, args, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { status: r.status ?? 1, stdout: r.stdout ?? "" };
    },
    personUid: typeof process.getuid === "function" ? process.getuid() : -1,
    stat: (x) => {
      try {
        const s = fs.statSync(x);
        return { uid: s.uid, mode: s.mode };
      } catch {
        return null;
      }
    },
    read: (x) => {
      try {
        return fs.readFileSync(x, "utf-8");
      } catch {
        return null;
      }
    },
    chain: (x) => {
      try {
        return writableChain(x);
      } catch {
        return [];
      }
    },
    runtime: runtimeProblemsOrUnread,
  };
}

export const GROUPS_UNREAD = "can't read the agents' login's groups";
export const NO_LOGIN_YET = -1;
export const UID_UNREAD = "can't read the agents' login's uid";
export const OWED_REFUSAL =
  "the agents' own login isn't ready on this Den version yet";
export const OS_LOGIN_OWED: readonly string[] = [
  "macOS access lists (ACLs) on Den's runtime files and folders",
  "service logs private to the person's login",
];

export function runtimeProblemsOrUnread(
  r: { bin: string; script: string; engineRoot: string },
  agents: { uid: number; gids: number[] },
): string[] {
  if (agents.uid !== NO_LOGIN_YET && !agents.gids.length)
    return [GROUPS_UNREAD];
  try {
    return runtimeWritableProblems(r, agents);
  } catch (e) {
    return [`it couldn't be read (${(e as Error).message})`];
  }
}

export function runtimeWritableProblems(
  r: { bin: string; script: string; engineRoot: string },
  agents: { uid: number; gid?: number; gids?: number[] },
  d: { stat?: (p: string) => { uid: number; gid: number; mode: number } } = {},
): string[] {
  const groups = new Set([
    ...(agents.gids ?? []),
    ...(agents.gid === undefined ? [] : [agents.gid]),
  ]);
  const stat =
    d.stat ??
    ((p: string) => {
      const s = fs.lstatSync(p);
      return { uid: s.uid, gid: s.gid, mode: s.mode };
    });
  const problems: string[] = [];
  const seen = new Set<string>();
  const why = (p: string, dirAbove: boolean): string | null => {
    const s = stat(p);
    if (s.uid === agents.uid) return `${p} is the agents' login's`;
    const isDir = (s.mode & 0o170000) === 0o040000;
    const sticky = isDir && (s.mode & 0o1000) !== 0;
    if ((s.mode & 0o002) !== 0 && !(dirAbove && sticky))
      return `${p} is ${octal(s.mode)}: anyone can change it`;
    if ((s.mode & 0o020) !== 0 && groups.has(s.gid) && !(dirAbove && sticky))
      return `${p} is ${octal(s.mode)}: a group the agents' login is in (${s.gid}) can change it`;
    return null;
  };
  const check = (p: string, dirAbove: boolean) => {
    if (seen.has(p)) return;
    seen.add(p);
    const w = why(p, dirAbove);
    if (w) problems.push(w);
  };
  const above = (p: string) => {
    let d2 = path.dirname(p);
    for (;;) {
      check(d2, true);
      const up = path.dirname(d2);
      if (up === d2) break;
      d2 = up;
    }
  };
  const walked = new Set<string>();
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      check(p, false);
      return;
    }
    if (!st.isSymbolicLink()) check(p, false);
    if (st.isSymbolicLink()) {
      if (!seen.has(p) && stat(p).uid === agents.uid) {
        seen.add(p);
        problems.push(`${p} is the agents' login's`);
      }
      let target: string;
      try {
        target = fs.realpathSync(p);
      } catch {
        problems.push(
          `${p} points at ${fs.readlinkSync(p)}, which isn't there: the agents' login might make it`,
        );
        return;
      }
      above(target);
      walk(target);
      return;
    }
    if (!st.isDirectory() || walked.has(p)) return;
    walked.add(p);
    for (const e of fs.readdirSync(p)) walk(path.join(p, e));
  };
  const bin = fs.realpathSync(r.bin);
  const root = fs.realpathSync(r.engineRoot);
  check(bin, false);
  above(bin);
  above(fs.realpathSync(r.script));
  walk(root);
  above(root);
  return problems;
}
