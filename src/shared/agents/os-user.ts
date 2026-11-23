/**
 * Issue 988 (slice 2 of issue 936), part 1: agents as a second OS user.
 * The setup, the remove and doctor's check, as data: what `agents os-user
 * setup` shows the person and then runs with sudo, and what doctor reads.
 *
 * One agents user and one group per person:
 *
 *               agents user            group
 *   Linux       den-agents-<person>    den-<person>
 *   macOS       _den_agents_<person>   _den_<person>   (hidden, system ids)
 *
 * What setup makes, under <root>/<person> (root: /opt/den):
 *
 *   bin/                  root, 0755, as is every folder above it
 *   bin/den-agent-launch  root, 0555: the only thing the person may run as
 *                         the agents user (one sudoers rule, no password)
 *   agents/               person:group, 2770: the agent files
 *   agents/home           agents user, 0700: its home, and its only one
 *   /etc/sudoers.d/den-<person>   root, 0440:
 *       <person> ALL=(<agents user>) NOPASSWD: <launcher>
 *
 * Den's state folder stays the person's at 0700: the agents user can read
 * none of it. The launcher takes one agent id (Den's pattern), scrubs the
 * environment to LAUNCH_ENV and execs only the runtime written into it at
 * setup. Starting sessions through it is part 2.
 */
import * as fs from "fs";
import * as path from "path";

export type OsUserPlatform = "darwin" | "linux";

/** The person's OS user name: plain, so it is safe in every name below. */
const PERSON_RE = /^[a-z_][a-z0-9_-]{0,15}$/;
/** A path written into the launcher or the rule: nothing a shell or sudo reads specially. */
const SAFE_PATH_RE = /^\/[A-Za-z0-9._/@+-]*$/;

/** Groups that give sudo (or root): the agents user is in none of them. */
export const SUDO_GROUPS = ["sudo", "wheel", "admin", "root"] as const;
/** Shells that refuse a login. */
export const NO_LOGIN_SHELLS = [
  "/usr/sbin/nologin",
  "/sbin/nologin",
  "/usr/bin/false",
  "/bin/false",
] as const;
/** The environment a session starts with: nothing else comes through. */
export const LAUNCH_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "TERM",
  "DEN_AGENT_ID",
] as const;
/** Den's agent id pattern (records.ts AGENT_ID_RE), as the launcher checks it in sh. */
const LAUNCH_ID_MAX = 64;

export interface OsUserLayout {
  platform: OsUserPlatform;
  /** The person's OS user name. */
  person: string;
  /** Where the per-person folders go (/opt/den). */
  root: string;
  /** What the launcher execs: an interpreter and Den's CLI script. */
  runtime: { bin: string; script: string };
  /** The agents user's shell (Linux: nologin where it exists). */
  noLogin: string;
  /** macOS: the system uid and gid to create them with. */
  ids?: { uid: number; gid: number };
}

export function osUserNames(
  platform: OsUserPlatform,
  person: string,
): { user: string; group: string } {
  if (!PERSON_RE.test(person))
    throw new Error(
      `"${person}" is not a user name Den can use for its agents user (lower case letters, digits, _ and -, up to 16)`,
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
    home: path.posix.join(agents, "home"),
    sudoers: `/etc/sudoers.d/den-${person}`,
  };
}

/** The one sudoers rule: the person runs the launcher as the agents user. */
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

/** Why `text` is not exactly the one rule for this person (null: it is). */
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

/**
 * Why the person's sudo rules (as `sudo -n -l` lists them) let more than
 * the launcher run as the agents user; null when exactly the one rule is
 * there.
 */
export function listedRulesProblem(
  rules: readonly string[],
  o: { user: string; launcher: string },
): string | null {
  const want = `(${o.user}) NOPASSWD: ${o.launcher}`;
  // The rules whose run-as list names the agents user.
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

/**
 * The launcher (root's, 0555). Takes one agent id, by Den's pattern;
 * starts `<runtime.bin> <runtime.script> agents session <id>` with only
 * LAUNCH_ENV set.
 */
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
# \`agents os-user setup\` wrote it, and doctor checks it is unchanged.
set -eu
if [ "$#" -ne 1 ]; then
  echo "den-agent-launch: give one agent id" >&2
  exit 64
fi
id=$1
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
exec /usr/bin/env -i HOME=${shQuote(o.home)} USER=${shQuote(o.user)} LOGNAME=${shQuote(o.user)} \\
  PATH='/usr/bin:/bin:/usr/sbin:/sbin' LANG='C.UTF-8' TERM="$term" DEN_AGENT_ID="$id" \\
  ${shQuote(o.runtime.bin)} ${shQuote(o.runtime.script)} agents session "$id"
`;
}

export interface PlanStep {
  /** What it does, for the person to read before anything runs. */
  say: string;
  /** Run with sudo. */
  argv: string[];
  /** A failure doesn't stop the plan (remove: it may already be gone). */
  optional?: boolean;
}

const rootGroup = (p: OsUserPlatform) => (p === "darwin" ? "wheel" : "root");

/** The setup's steps, in order; `staged` holds the launcher and the rule, written by the person first. */
export function setupPlan(
  l: OsUserLayout,
  staged: { launcher: string; sudoers: string },
): PlanStep[] {
  const n = osUserNames(l.platform, l.person);
  const p = osUserPaths(l.root, l.person);
  const rg = rootGroup(l.platform);
  const steps: PlanStep[] = [];
  if (l.platform === "linux") {
    steps.push(
      {
        say: `Make the group ${n.group}, for you and your agents`,
        argv: ["groupadd", "--system", n.group],
      },
      {
        say: `Make the agents user ${n.user}: a system user, no login shell, its home in the agent files`,
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
      },
      {
        say: `Add you (${l.person}) to ${n.group}`,
        argv: ["usermod", "--append", "--groups", n.group, l.person],
      },
    );
  } else {
    if (!l.ids)
      throw new Error("macOS: the setup needs a free system uid and gid");
    const G = `/Groups/${n.group}`;
    const U = `/Users/${n.user}`;
    const dscl = (say: string, ...a: string[]): PlanStep => ({
      say,
      argv: ["dscl", ".", "-create", ...a],
    });
    steps.push(
      dscl(`Make the group ${n.group}, for you and your agents`, G),
      dscl(
        `Give ${n.group} the system id ${l.ids.gid}`,
        G,
        "PrimaryGroupID",
        String(l.ids.gid),
      ),
      dscl(`Name the group`, G, "RealName", `Den agents (${l.person})`),
      dscl(`Make the agents user ${n.user}`, U),
      dscl(
        `Give ${n.user} the system id ${l.ids.uid}`,
        U,
        "UniqueID",
        String(l.ids.uid),
      ),
      dscl(
        `Put ${n.user} in ${n.group}`,
        U,
        "PrimaryGroupID",
        String(l.ids.gid),
      ),
      dscl(`Give ${n.user} no login shell`, U, "UserShell", l.noLogin),
      dscl(
        `Set ${n.user}'s home, in the agent files`,
        U,
        "NFSHomeDirectory",
        p.home,
      ),
      dscl(`Name the user`, U, "RealName", `Den agents (${l.person})`),
      dscl(`Hide ${n.user} from the login window`, U, "IsHidden", "1"),
      dscl(`Give ${n.user} no password (it can't log in)`, U, "Password", "*"),
      {
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
      },
    );
  }
  steps.push(
    {
      say: `Make ${p.bin} and the folders above it root's, so only root can change the launcher`,
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
      say: `Install the launcher at ${p.launcher}, root's and read-only`,
      argv: [
        "install",
        "-o",
        "root",
        "-g",
        rg,
        "-m",
        "0555",
        staged.launcher,
        p.launcher,
      ],
    },
    {
      say: `Make the agent files folder ${p.agents}, yours and the group's`,
      argv: [
        "install",
        "-d",
        "-o",
        l.person,
        "-g",
        n.group,
        "-m",
        "2770",
        p.agents,
      ],
    },
    {
      say: `Make ${n.user}'s home ${p.home}, its own`,
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
      say: `Check the sudo rule before installing it`,
      argv: ["visudo", "-c", "-f", staged.sudoers],
    },
    {
      say: `Install the sudo rule ${p.sudoers}: you may run the launcher as ${n.user}, and nothing else`,
      argv: [
        "install",
        "-o",
        "root",
        "-g",
        rg,
        "-m",
        "0440",
        staged.sudoers,
        p.sudoers,
      ],
    },
  );
  return steps;
}

/** The remove's steps: the rule first, then the user, the group and the folders. */
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
        say: `Remove the agents user ${n.user}`,
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
        say: `Remove the agents user ${n.user}`,
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

/** What doctor reads from the machine (defaultOsUserFacts). */
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
  /** The rule file's owner and mode (its text is root's to read). */
  sudoers: StatFacts | null;
  /** The person's sudo rules naming the agents user (`sudo -n -l`); null: it couldn't list them. */
  personRules: string[] | null;
  launcher: (StatFacts & { text: string }) | null;
  /** Each folder above the launcher, nearest first, to /. */
  launcherChain: (StatFacts & { path: string })[];
  agentsDir: StatFacts | null;
  homeDir: StatFacts | null;
  stateDir: StatFacts | null;
  /** Whether <root>/<person> exists. */
  dir: boolean;
}

export interface OsUserCheck {
  status: "ok" | "warn" | "fail";
  detail: string;
  problems: string[];
}

const octal = (m: number) => (m & 0o7777).toString(8).padStart(4, "0");

/** Doctor's row: as it should be when agents.os_user is on, gone when it is off. */
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

  const present = [
    f.user.exists && `the user ${n.user}`,
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
          : "agents run as you: an agents user is not set up (agents.os_user is off)",
        problems,
      };
    problems.push(
      ...present.map(
        (x) =>
          `${x} is still here, but agents.os_user is off: \`${cli} agents os-user remove\` removes it`,
      ),
    );
    return { status: "fail", detail: problems.join("; "), problems };
  }

  if (present.length === 0) {
    problems.push(
      `agents.os_user is on, but no agents user is set up: run \`${cli} agents os-user setup\``,
    );
    return { status: "fail", detail: problems.join("; "), problems };
  }

  // Pin 4: no sudo, no login shell, no home outside the agent files.
  if (!f.user.exists) problems.push(`the agents user ${n.user} is missing`);
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

  // Pin 1: the one rule, root's file, read-only.
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

  // Pin 2: root's launcher, unchanged, and root's folders above it.
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
        `the launcher ${p.launcher} is not the one Den wrote: run \`${cli} agents os-user setup\` again`,
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
    (f.agentsDir.mode & 0o7777) !== 0o2770
  )
    problems.push(
      `${p.agents} is ${octal(f.agentsDir.mode)}, uid ${f.agentsDir.uid}: it should be yours, 2770`,
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
      detail: `agents run as ${n.user}; your sudo rules couldn't be listed (sudo -n -l asked for a password), so the rule is checked by its file only`,
      problems,
    };
  return {
    status: "ok",
    detail: `agents run as ${n.user}: the launcher, its folders and the sudo rule are root's, and Den's state is yours alone`,
    problems,
  };
}

/** Each folder above `file`, nearest first, up to /: its owner and mode. */
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
