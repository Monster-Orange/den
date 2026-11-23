/**
 * Issue 988, part 1: `agents os-user setup | remove | check`.
 *
 *   setup   shows every step and its command, asks, then runs each with
 *           sudo (a failure stops it), and sets agents.os_user: on
 *   remove  shows and asks the same, runs every step (a thing already gone
 *           is fine), sets agents.os_user: off, and checks nothing is left
 *   check   doctor's row for it
 *
 * A person's commands: an agent's session is refused before anything is
 * shown. Nothing here starts a session as the agents user (part 2).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createInterface } from "readline/promises";
import { spawnSync } from "child_process";
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import { AGENT_SANDBOX_ENV } from "../../shared/agents/sandbox.js";
import {
  launcherScript,
  machineReadDeps,
  osUserCheck,
  osUserNames,
  osUserPaths,
  readOsUserFacts,
  removePlan,
  setupPlan,
  sudoersLine,
  type OsUserFacts,
  type OsUserLayout,
  type PlanStep,
} from "../../shared/agents/os-user.js";
import {
  osUserSetting,
  readUserConfig,
  setUserOsUser,
} from "../../shared/den-config.js";
import { getEngineRoot, getStateDir } from "../../shared/paths.js";
import type { OnboardCheck } from "./doctor-onboard.js";

export interface OsUserCommandDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  layout: () => Promise<OsUserLayout>;
  /** Writes the launcher and the rule where sudo installs them from. */
  stage: (files: { launcher: string; sudoers: string }) => {
    launcher: string;
    sudoers: string;
  };
  confirm: (question: string) => Promise<boolean>;
  sudo: (argv: string[]) => { ok: boolean; error?: string };
  facts: () => OsUserFacts;
  setOn: (on: boolean) => void;
  on: () => boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  cli: string;
}

const HELP = (cli: string) =>
  [
    `${cli} agents os-user setup    make the agents user (shows each step, then asks)`,
    `${cli} agents os-user remove   remove it, and check nothing is left`,
    `${cli} agents os-user check    how it stands (doctor's row)`,
  ].join("\n");

function show(d: OsUserCommandDeps, steps: PlanStep[]): void {
  steps.forEach((s, i) => {
    d.out(`  ${i + 1}. ${s.say}`);
    d.out(`     sudo ${s.argv.join(" ")}`);
  });
}

export async function cmdOsUser(
  args: string[],
  d: OsUserCommandDeps,
): Promise<number> {
  const sub = args[0];
  if (sub !== "setup" && sub !== "remove" && sub !== "check") {
    d.out(HELP(d.cli));
    return sub === undefined || sub === "--help" || sub === "-h" ? 0 : 1;
  }
  if (isAgentTokenEnv(d.env) || d.env[AGENT_SANDBOX_ENV] !== undefined) {
    d.err(
      "Only a person can set up or remove the agents' login; this is an agent, so nothing was changed",
    );
    return 1;
  }
  if (d.platform !== "darwin" && d.platform !== "linux") {
    d.err(
      "A login of their own for agents is for macOS and Linux: agents here run as you.",
    );
    return 1;
  }
  const l = await d.layout();

  if (sub === "check") {
    const c = osUserCheck({ on: d.on(), layout: l, cli: d.cli }, d.facts());
    const mark = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
    (c.status === "fail" ? d.err : d.out)(`${mark} ${c.detail}`);
    return c.status === "fail" ? 1 : 0;
  }

  const n = osUserNames(l.platform, l.person);
  const p = osUserPaths(l.root, l.person);

  if (sub === "setup") {
    const rule = sudoersLine({
      person: l.person,
      user: n.user,
      launcher: p.launcher,
    });
    const staged = d.stage({
      launcher: launcherScript({
        person: l.person,
        user: n.user,
        home: p.home,
        runtime: l.runtime,
      }),
      sudoers: `${rule}\n`,
    });
    const steps = setupPlan(l, staged);
    d.out(
      `Agents will run as ${n.user}, which can't read Den's state or your files. These ${steps.length} steps run with sudo:`,
    );
    show(d, steps);
    d.out(`The sudo rule: ${rule}`);
    d.out(`The launcher, to read first: ${staged.launcher}`);
    if (!(await d.confirm(`Run these ${steps.length} steps with sudo?`))) {
      d.err("Nothing was changed.");
      return 1;
    }
    for (const [i, s] of steps.entries()) {
      const r = d.sudo(s.argv);
      if (!r.ok && !s.optional) {
        d.err(
          `Step ${i + 1} failed (${s.argv.join(" ")}): ${r.error ?? "it failed"}. The steps before it stay; \`${d.cli} agents os-user remove\` undoes them.`,
        );
        return 1;
      }
    }
    d.setOn(true);
    d.out(
      `✓ ${n.user} is set up, and agents.os_user is on. \`${d.cli} agents os-user check\` checks it.`,
    );
    return 0;
  }

  // remove
  const steps = removePlan(l);
  d.out(`These ${steps.length} steps run with sudo:`);
  show(d, steps);
  if (!(await d.confirm(`Run these ${steps.length} steps with sudo?`))) {
    d.err("Nothing was changed.");
    return 1;
  }
  for (const s of steps) {
    const r = d.sudo(s.argv);
    if (!r.ok)
      d.out(
        `  (${s.argv.join(" ")}: ${r.error ?? "failed"}; it may be gone already)`,
      );
  }
  d.setOn(false);
  const c = osUserCheck({ on: false, layout: l, cli: d.cli }, d.facts());
  if (c.problems.length) {
    for (const x of c.problems) d.err(`✗ ${x}`);
    return 1;
  }
  d.out(
    `✓ Removed: nothing is left (no ${n.user}, no ${n.group}, no sudo rule, no ${p.dir}), and agents.os_user is off.`,
  );
  return 0;
}

/** On macOS, a uid and gid in the system range (400–499) that no user or group has. */
function freeSystemIds(): { uid: number; gid: number } {
  const used = (kind: string, key: string) =>
    new Set(
      (
        spawnSync("dscl", [".", "-list", kind, key], { encoding: "utf-8" })
          .stdout ?? ""
      )
        .split("\n")
        .map((x) => Number(x.trim().split(/\s+/).pop()))
        .filter((x) => Number.isFinite(x)),
    );
  const users = used("/Users", "UniqueID");
  const groups = used("/Groups", "PrimaryGroupID");
  for (let id = 401; id < 500; id++)
    if (!users.has(id) && !groups.has(id)) return { uid: id, gid: id };
  throw new Error("no free system id between 401 and 499");
}

export const OS_USER_ROOT = "/opt/den";

/** This machine's layout for the person running the CLI. */
export function machineLayout(platform: NodeJS.Platform): OsUserLayout {
  const plat = platform === "darwin" ? "darwin" : "linux";
  const noLogin =
    plat === "darwin"
      ? "/usr/bin/false"
      : (["/usr/sbin/nologin", "/sbin/nologin"].find((x) => fs.existsSync(x)) ??
        "/bin/false");
  return {
    platform: plat,
    person: os.userInfo().username,
    root: OS_USER_ROOT,
    runtime: {
      bin: process.execPath,
      script: path.join(getEngineRoot(), "dist/src/ui/cli/index.js"),
    },
    noLogin,
  };
}

export function defaultOsUserDeps(cli: string): OsUserCommandDeps {
  const platform = process.platform;
  return {
    platform,
    env: process.env,
    layout: async () => ({
      ...machineLayout(platform),
      ...(platform === "darwin" ? { ids: freeSystemIds() } : {}),
    }),
    stage: (files) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-os-user-"));
      const launcher = path.join(dir, "den-agent-launch");
      const sudoers = path.join(dir, "sudoers");
      fs.writeFileSync(launcher, files.launcher, { mode: 0o644 });
      fs.writeFileSync(sudoers, files.sudoers, { mode: 0o644 });
      return { launcher, sudoers };
    },
    confirm: async (q) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    sudo: (argv) => {
      const r = spawnSync("sudo", ["--", ...argv], { stdio: "inherit" });
      return r.status === 0
        ? { ok: true }
        : { ok: false, error: r.error?.message ?? `exit ${r.status}` };
    },
    facts: () =>
      readOsUserFacts(
        machineLayout(platform),
        getStateDir(),
        machineReadDeps(),
      ),
    setOn: (on) => setUserOsUser(on),
    on: () => osUserSetting(readUserConfig().agents),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    cli,
  };
}

/**
 * Issue 988: doctor's row (macOS and Linux). Off and not set up is a quiet
 * ✓; anything wrong, or left behind by a remove, is ✗.
 */
export function osUserDoctorRow(
  cli: string,
  d: Pick<OsUserCommandDeps, "platform" | "facts" | "on"> = defaultOsUserDeps(
    cli,
  ),
): { line: string; check: OnboardCheck; problem: boolean } | null {
  if (d.platform !== "darwin" && d.platform !== "linux") return null;
  const c = osUserCheck(
    { on: d.on(), layout: machineLayout(d.platform), cli },
    d.facts(),
  );
  const mark = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
  return {
    line: `${mark} Agents' own login: ${c.detail}`,
    check: {
      id: "agents-os-user",
      status: c.status,
      detail: c.detail,
      ...(c.status === "fail" && !d.on()
        ? { fix: `${cli} agents os-user remove` }
        : c.status === "fail"
          ? { fix: `${cli} agents os-user setup` }
          : {}),
    },
    problem: c.status === "fail",
  };
}
