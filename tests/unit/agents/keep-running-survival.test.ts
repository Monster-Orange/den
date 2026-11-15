/**
 * Issue 163: what keeps agents running after logout, under the jobs that
 * Keep agents running after logout installs (mode always).
 *
 * 1. The job description: install.sh's always-mode plists for the web job
 *    and the host job are LaunchDaemons that run as the person
 *    (UserName), start at boot (RunAtLoad), are started again whenever
 *    they end (KeepAlive), are never tied to the desktop login
 *    (no LimitLoadToSessionType), and keep the person's HOME, so the host
 *    and the CLI share one state dir (agent records, socket).
 * 2. What launchd then does: the host job's process ends and KeepAlive
 *    starts it again (a new host on the same state dir), and the web job
 *    starts (RunAtLoad): the agents that were running come back on their
 *    own conversations, with no person action (agents.restore_on_boot,
 *    on by default; the Setting leaves it on).
 *
 * Real logout is not shown here: launchd runs nothing in a test. launchctl
 * and sudo are never run (install.sh print only writes plists to stdout).
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { agentsRestoreOnBoot } from "../../../src/shared/den-config.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  markInterrupted,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const ROOT = path.resolve(__dirname, "../../..");
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** install.sh print / print-host in mode always, as plist XML. */
function alwaysPlist(which: "print" | "print-host"): string {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "den-keep-surv-"));
  tmps.push(t);
  const node = path.join(t, "node");
  fs.writeFileSync(node, "#!/bin/sh\necho 22\n", { mode: 0o755 });
  const out = spawnSync(
    "bash",
    [path.join(ROOT, "service", "install.sh"), which],
    {
      encoding: "utf-8",
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: path.join(t, "home"),
        DEN_ROOT: path.join(ROOT, "examples", "distribution"),
        DEN_SERVICE_LABEL: "local.acme-keep.web",
        DEN_SERVICE_LOGS: path.join(t, "logs"),
        DEN_SERVICE_NODE: node,
        DEN_SERVICE_MODE: "always",
      },
    },
  );
  expect(out.status).toBe(0);
  return out.stdout;
}

const str = (xml: string, key: string) =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1];
const bool = (xml: string, key: string) =>
  new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(xml)?.[1];

describe("the always-mode jobs: what launchd keeps through a logout", () => {
  it.each(["print", "print-host"] as const)(
    "%s: runs as the person, at boot, started again when it ends, never tied to the desktop login",
    (which) => {
      const xml = alwaysPlist(which);
      expect(str(xml, "UserName")).toBe(os.userInfo().username);
      expect(bool(xml, "RunAtLoad")).toBe("true");
      expect(bool(xml, "KeepAlive")).toBe("true");
      expect(xml).not.toContain("LimitLoadToSessionType");
      // The person's HOME: the same state dir the CLI uses.
      expect(str(xml, "HOME")).toMatch(/\/home$/);
    },
  );

  it("the host job runs the session host, waiting out one started before it", () => {
    const xml = alwaysPlist("print-host");
    expect(str(xml, "Label")).toBe("local.acme-keep.sessions");
    expect(xml).toMatch(
      /<string>sessions<\/string>\s*<string>host<\/string>\s*<string>--stand-by<\/string>/,
    );
  });
});

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;

async function typeInto(r: Rig, id: string, text: string): Promise<void> {
  const sid = (record(r, id).session as { id: string }).id;
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(sid, Buffer.from(text));
  await settle();
  c.close();
  const token = record(r, id).resumeToken as string | undefined;
  if (token) {
    const claude = path.join(r.dir, "claude-config");
    const dir = path.join(claude, "projects", "-work");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${token}.jsonl`), "{}\n");
    r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
  }
}

describe("the host job started again (KeepAlive), then the web job (RunAtLoad)", () => {
  it("the agents that were running come back on their own, with no person action", async () => {
    const r = await rig();
    const packs = path.join(r.dir, "personas");
    fs.mkdirSync(packs, { recursive: true });
    for (const id of ["planner", "helper"]) {
      fs.writeFileSync(
        path.join(packs, `${id}.md`),
        `---\nname: ${id}\n---\nYou work.\n`,
      );
    }
    r.config.personaPacks = ["personas"];
    for (const id of ["planner", "helper"]) {
      expect(await agents(r, "start", "-w", "north", "--persona", id)).toBe(0);
      await typeInto(r, id, "go\r");
    }
    // The host's process ended; launchd starts the job again: a new host
    // on the same state dir, with none of the old sessions.
    await r.restartHost();
    const before = r.made.length;
    // The web job's start: the Setting on, restore_on_boot left as is.
    const user = { agents: { keep_running_after_logout: true } };
    const found = await markInterrupted(resolveAgentsDeps(r.deps), {
      restoreAll: agentsRestoreOnBoot(() => user),
    });
    expect(found.interrupted.sort()).toEqual(["helper", "planner"]);
    expect(found.resumed.sort()).toEqual(["helper", "planner"]);
    const back = r.made.slice(before);
    expect(back).toHaveLength(2);
    for (const p of back) expect(p.args[0]).toBe("--resume");
  }, 30_000);
});
