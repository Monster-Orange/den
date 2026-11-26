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
  runPlan,
  setupPlan,
  sudoersLine,
  type OsUserFacts,
  type OsUserLayout,
  type PlanRunner,
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
  confirm: (question: string) => Promise<boolean>;
  sudo: PlanRunner;
  facts: () => OsUserFacts;
  setOn: (on: boolean) => void;
  on: () => boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  cli: string;
}

const HELP = (cli: string) =>
  [
    `${cli} agents os-login setup    make the agents' login (shows each step, then asks)`,
    `${cli} agents os-login remove   remove it, and check nothing is left`,
    `${cli} agents os-login check    how it stands (doctor's row)`,
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
    const text = {
      launcher: launcherScript({
        person: l.person,
        user: n.user,
        home: p.home,
        runtime: l.runtime,
      }),
      sudoers: `${rule}\n`,
    };
    const f = d.facts();
    const steps = setupPlan(l, text, {
      user: f.user.exists,
      group: f.group.exists,
    });
    d.out(
      `Agents will run as ${n.user}, which can't read Den's state or your files. These ${steps.length} steps run with sudo:`,
    );
    show(d, steps);
    d.out(`The sudo rule:`);
    d.out(`  ${rule}`);
    d.out(`The launcher (${p.launcher}):`);
    for (const line of text.launcher.trimEnd().split("\n"))
      d.out(`  | ${line}`);
    if (!(await d.confirm(`Run these ${steps.length} steps with sudo?`))) {
      d.err("Nothing was changed.");
      return 1;
    }
    const r = runPlan(steps, d.sudo);
    if (!r.ok) {
      const s = steps[r.index]!;
      d.err(
        `Step ${r.index + 1} failed (${s.argv.join(" ")}): ${r.error}. The steps before it stay; \`${d.cli} agents os-login remove\` undoes them.`,
      );
      return 1;
    }
    d.setOn(true);
    d.out(
      `✓ ${n.user} is set up, and agents.os_login is on. \`${d.cli} agents os-login check\` checks it.`,
    );
    return 0;
  }

  const steps = removePlan(l);
  d.out(`These ${steps.length} steps run with sudo:`);
  show(d, steps);
  if (!(await d.confirm(`Run these ${steps.length} steps with sudo?`))) {
    d.err("Nothing was changed.");
    return 1;
  }
  for (const s of steps) {
    const r = d.sudo(s.argv, s.stdin);
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
    `✓ Removed: nothing is left (no ${n.user}, no ${n.group}, no sudo rule, no ${p.dir}), and agents.os_login is off.`,
  );
  return 0;
}

function macIds(person: string): { uid: number; gid: number } {
  const n = osUserNames("darwin", person);
  const read = (rec: string, key: string) => {
    const r = spawnSync("dscl", [".", "-read", rec, key], {
      encoding: "utf-8",
    });
    const v = Number(
      new RegExp(`^${key}:\\s*(\\d+)`, "m").exec(r.stdout ?? "")?.[1],
    );
    return r.status === 0 && Number.isFinite(v) ? v : null;
  };
  const uid = read(`/Users/${n.user}`, "UniqueID");
  const gid = read(`/Groups/${n.group}`, "PrimaryGroupID");
  if (uid !== null && gid !== null) return { uid, gid };
  const free = freeSystemIds();
  return { uid: uid ?? free.uid, gid: gid ?? free.gid };
}

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
      ...(platform === "darwin"
        ? { ids: macIds(machineLayout(platform).person) }
        : {}),
    }),
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
    sudo: (argv, stdin) => {
      const r = spawnSync("sudo", ["--", ...argv], {
        input: stdin ?? "",
        stdio: ["pipe", "pipe", "inherit"],
        encoding: "utf-8",
      });
      return r.status === 0
        ? { ok: true, stdout: r.stdout ?? "" }
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
      id: "agents-os-login",
      status: c.status,
      detail: c.detail,
      ...(c.status === "fail" && !d.on()
        ? { fix: `${cli} agents os-login remove` }
        : c.status === "fail"
          ? { fix: `${cli} agents os-login setup` }
          : {}),
    },
    problem: c.status === "fail",
  };
}
