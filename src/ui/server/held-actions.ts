/**
 * The writes ON-3 holds for the person (approval-routes.ts): each one's
 * check (the args turned into Den's own words, bad args refused before
 * anything waits) and its run. The runs are the existing code paths, not
 * copies:
 *
 *   workspace_create  the Workspaces page's create (workspaceCreateRefusal,
 *                     createWorkspace), then activates it: nothing an
 *                     agent calls activates a workspace, and service_try
 *                     needs an active one
 *   repo_add          `repo add --json` (repo-command.ts repoAdd), a local
 *                     folder inside home only, as manifest_draft reads; its
 *                     dry run is the Review
 *   service_try       `up` through the service runner, as
 *                     /api/service/exec and service_up run it
 *                     (lifecycle-exec.ts), until it is ready or exits;
 *                     an inactive workspace is activated first, on the
 *                     same Allow, and the Review says so
 *   hub_connect       #267: set, change or clear Hub's address
 *   hub_project_create issue 271: ask Hub for a new project to link a
 *                     project to (hub-create-routes.ts, the code Settings
 *                     runs); an owner decides it in Hub, Den links it
 *   hub_link          issue 647: link a project to an existing Hub project
 *                     by its id or slug, as `hub link` does
 *                     (hub-link-held.ts); one the connected Hub doesn't
 *                     list is refused before anyone is asked
 *   den_restart       SRV-1a: restart this Den's web server, in place
 *                     (server-restart.ts); the agent that asked is told
 *                     when it is back
 *   den_update        SRV-1b: install another Den version from npm and
 *                     restart on it (den-update.ts); a version that
 *                     doesn't come up is rolled back by itself
 *   agent_create      SRV-P1: start a new agent in a project, as
 *                     `agents start` does (agent-ops.ts checkAgentCreate,
 *                     createAgent); its mode the project's or stricter.
 *                     Any agent may ask: a project's agent for its own
 *                     project only, the server agent for any
 *   persona_create    SRV-P2: add a persona, as the Personas page's New
 *   persona_update    persona and edit do (agent-ops.ts); the Review has
 *                     the instructions in full. PSN-1: a project's agent
 *                     writes its project's personas (a repo's
 *                     .den/personas file); this machine's own, only Den's
 *                     own agent or a person
 *   agent_mode        issue 199: clear an agent's own mode, so it follows
 *                     its project's (agent-ops.ts checkAgentMode,
 *                     runAgentMode); a running one restarts after its turn
 *                     on the same conversation. The person's Allow only
 *   agent_sandbox_set issue 1328: turn one agent's sandbox off or on
 *                     (agents/sandbox-set.ts): only agents.<id>.sandbox in
 *                     user.yml; a running one restarts after its turn on
 *                     the same conversation. Off is the person's own Allow
 *   setting_change    issue 1371: change one setting in user.yml
 *   gate_settings_set issue 1395: change the gate's slot settings
 *                     (cli/setting-change.ts): only that key, a backup and
 *                     an audit line; a widening key is the person's own Allow
 *   repo_clone        SRV-P3: clone a repo into repos_root (repo-clone.ts),
 *                     for manifest_draft and repo_add (each its own Allow)
 *                     to take up; Den's own agent or a person asks, as the
 *                     folder is every project's
 *   den_pin_commit    #176: commit and push (or open a pull request for)
 *                     the distribution's new Den pin after a verified
 *                     self-update (pin-commit.ts). Den asks for it itself
 *                     when the approval policy says ask; routine
 *   den_sandbox_on    issue 936: agents.sandbox: on in user.yml, for the
 *                     agents that started before the sandbox. Den asks for
 *                     it itself; only the person's Allow runs it
 *   embed_key_create  issue 334: an app key for a web app's own server,
 *   embed_key_revoke  and its revoke (embed-routes.ts appKeyOps). A
 *                     person's own ask and Allow only; the key is shown
 *                     once, to the Allow's browser
 *   project_mcp_add   issue 335: one more HTTP MCP server for a project's
 *                     agents, its bearer a secrets.refs name (agent-ops.ts
 *                     checkProjectMcpAdd); always the person's own Allow
 *   project_mcp_remove issue 352: take one away, or change its url or
 *   project_mcp_update bearer reference (agent-ops.ts checkProjectMcpRemove,
 *                     checkProjectMcpUpdate); always the person's own Allow
 *   verify_run        issue 208: a Verify run on a shared environment
 *                     (verify-routes.ts checkVerifyRun, runVerify); the
 *                     Review is the plan, each module with its mark. It
 *                     always asks the person (CRITICAL_HELD_ACTIONS)
 *   agent_import      issue 160: bring a conversation started outside Den
 *                     in as an agent of the asker's project (agent-ops.ts
 *                     importAgent). It asks by default (approval-policy.ts)
 *   approval_policy   issue 160: change the approval policy, the install's
 *                     (user.yml) or a project's (workspaces.yml). Always
 *                     the person's own Allow: only a person in the page
 *                     changes it without one
 *   pr_close          issue 160: close a stale or superseded pull request
 *                     after a Hub note, with a comment saying why (gh
 *                     pr close). Auto unless the repo is watched or pinned
 *   gate_runner_token_create
 *                     issue 621: a gate-only token for a CI runner VM
 *                     (gate-routes.ts gateRunnerTokenOp): it only asks
 *                     for, renews and gives back gate slots. Always the
 *                     person's own Allow; the token goes once to the asker
 *   gate_box_set      issue 625: add or replace a test box (gate-routes.ts
 *   gate_box_remove   gateBoxOps), checked with checkBox at the ask; the
 *                     card shows every field. Always the person's own
 *                     Allow; it runs as the person's own boxes route does
 *   host_restart
 *                     issue 731: restart the terminal host when agents are
 *                     idle (host-restart-held.ts): the web start's refresh,
 *                     its wait, restart, resumes and audit. Doctor's fix,
 *                     never `sessions host --stop`. The person's own Allow
 *   report            issue 565: file a report the way the page's Report
 *                     does (report-held.ts): to a public destination the
 *                     person's own Allow, to a private one the policy
 *   test_person_setup issue 816: set up the test person of a test install
 *                     announced on this computer (test-person-held.ts):
 *                     one grant and that install's bearer, sent once over
 *                     loopback at the Allow. The person's own Allow only
 *   web_url_set       issue 869: Den's own agent proposes this install's
 *                     address (web-url-held.ts); it must answer as this
 *                     Den at the ask and at the Allow, and saves as
 *                     Settings does. The person's own Allow
 */
import {
  line,
  reviewLines,
  type ReviewLine,
} from "../../shared/review-lines.js";
import { UPDATE_SPEC_RE } from "./den-update.js";
import {
  cloneTarget,
  runClone,
  type GitRunner,
} from "../../shared/repo-clone.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import {
  readPolicySetting,
  type PolicySetting,
} from "../../shared/approval-policy.js";
import { workspaceSlug } from "../../shared/workspace-name.js";
import { createHash } from "crypto";
import * as path from "path";
import { checkOnboardPath, type PathRules } from "../cli/onboard-reads.js";
import {
  repoAdd,
  type ManifestValidator,
  type RepoAddResult,
} from "../cli/repo-command.js";
import type {
  HeldAction,
  HeldActions,
  HeldAsker,
  HeldCheck,
} from "./approval-routes.js";
import type { AskedBy } from "./approvals.js";
import type {
  AgentCreateCheck,
  HeldOpCheck,
  PersonaHeldCheck,
} from "../cli/agent-ops.js";

export interface TryResult {
  ok: boolean;
  exitCode: number | null;
  /** Started and healthy (or, with no check, still running). */
  ready: boolean;
  lines: string[];
}

export interface HeldActionDeps {
  rules: () => PathRules;
  validate: ManifestValidator;
  workspaceCreateRefusal: (name: string | undefined) => string | null;
  /** D70: the workspace key a name or slug names (unchanged: none). */
  resolveWorkspace?: (input: string) => string;
  /** D70: makes it under its slug; returns the slug. */
  createWorkspace: (name: string) => string;
  activateWorkspace: (name: string) => void;
  workspaceActive: (name: string) => boolean;
  workspaceExists: (name: string) => boolean;
  /** Where `repo add` puts a repo with no -w: the focused one, else `default`. */
  defaultWorkspace: () => string;
  /**
   * The service `up` would start, or why it can't (the exec route's
   * checks). `command`: its declared local "up", as the dialog shows it
   * (issue 362), absent when it runs the runner's own.
   */
  serviceTarget: (
    service: string,
    workspace?: string,
  ) =>
    | { ok: true; address: string; command?: string }
    | { ok: false; error: string };
  tryService: (address: string, workspace?: string) => Promise<TryResult>;
  /** SRV-1a: leave the marker, then restart this server (after answering). */
  restartDen?: (
    reason: string,
    asked?: AskedBy,
  ) => Promise<{ ok: boolean; restarting?: boolean; error?: string }>;
  /** SRV-1b: update Den to `version` (latest or x.y.z) and restart on it. */
  updateDen?: (
    version: string,
    reason: string,
    asked?: AskedBy,
  ) => Promise<{ ok: boolean; restarting?: boolean; error?: string }>;
  /** SRV-P1: agent_create's check and start (agent-ops.ts). */
  agentCreate?: {
    check: (args: Record<string, unknown>, who?: HeldAsker) => AgentCreateCheck;
    run: (args: Record<string, unknown>) => Promise<unknown>;
  };
  /** SRV-P4: project_mode's check and save (agent-ops.ts). */
  projectMode?: HeldOp;
  /** #267: hub_connect's check and write (hub-address.ts). */
  hubAddress?: HeldOp;
  /** Issue 271: ask Hub for a new project to link a project to. */
  hubCreate?: HeldOp;
  /**
   * Issue 647: link a project to an existing Hub project (hub-link-held.ts);
   * its check asks the connected Hub, so it is async.
   */
  hubLink?: HeldAction;
  /** SRV-P4: agent_folder's check and move (agent-ops.ts). */
  agentFolder?: HeldOp;
  /** Issue 335: project_mcp_add's check and save (agent-ops.ts). */
  projectMcp?: HeldOp;
  /** Issue 352: project_mcp_remove's check and save (agent-ops.ts). */
  projectMcpRemove?: HeldOp;
  /** Issue 352: project_mcp_update's check and save (agent-ops.ts). */
  projectMcpUpdate?: HeldOp;
  /** Issue 199: agent_mode's check and clear (agent-ops.ts). */
  agentMode?: HeldOp;
  /** Issue 1328: agent_sandbox_set's check and write (agents/sandbox-set.ts). */
  agentSandbox?: HeldOp;
  /** Issue 1371: setting_change's check and write (cli/setting-change.ts). */
  settingChange?: HeldOp;
  /** Issue 1395: gate_settings_set's check and write (gates/settings-set.ts). */
  gateSettings?: HeldOp;
  /** Issue 334: embed_key_create and embed_key_revoke (embed-routes.ts). */
  appKeys?: { create: HeldOp; revoke: HeldOp };
  /** Issue 208: verify_run's check and run (verify-routes.ts). */
  verifyRun?: HeldOp;
  /** Issue 621: gate_runner_token_create (gate-routes.ts gateRunnerTokenOp). */
  gateRunnerToken?: HeldOp;
  /** Issue 625: gate_box_set (gate-routes.ts gateBoxOps). */
  gateBoxSet?: HeldOp;
  /** Issue 625: gate_box_remove (gate-routes.ts gateBoxOps). */
  gateBoxRemove?: HeldOp;
  /** Issue 731: host_restart (host-restart-held.ts hostRestartOp). */
  terminalHostRestart?: HeldOp;
  /** Issue 869: web_url_set (web-url-held.ts webUrlSetAction). */
  webUrlSet?: HeldAction;
  /** Issue 160: agent_import's bring-in (agent-ops.ts runAgentImport). */
  agentImport?: (args: {
    project: string;
    session: string;
    persona: string;
    runtime?: string;
    sandboxOff?: boolean;
  }) => Promise<unknown>;
  /**
   * Issue 1328: why the agent agent_import makes of a persona would start
   * outside the sandbox (a Review line), or null. Then only the person's
   * own Allow brings it in.
   */
  agentImportSandbox?: (persona: string) => ReviewLine | null;
  /**
   * Issue 160: the approval policy as set (`approvals:`), the install's or
   * a project's, and its write. read throws on a project Den doesn't have.
   */
  approvalPolicy?: {
    read: (project?: string) => Record<string, unknown> | undefined;
    write: (
      project: string | undefined,
      setting: Record<string, unknown> | undefined,
    ) => void;
  };
  /**
   * Issue 160: pr_close's close (gh pr close <pr> --repo <repo> --comment
   * <comment>, as the person running Den; tests pass a fake).
   */
  prClose?: (args: {
    repo: string;
    pr: number;
    comment: string;
  }) => Promise<unknown>;
  /** Issue 565: file a report as the page does (report-held.ts reportHeld). */
  report?: HeldAction;
  /** Issue 816: set up a test install's test person (test-person-held.ts). */
  testPersonSetup?: HeldAction;
  /** #176: den_pin_commit's check and run (pin-commit.ts). */
  pinCommit?: HeldOp;
  /** Issue 936: den_sandbox_on (agents/sandbox-rollout.ts). */
  sandboxOn?: HeldOp;
  /** SRV-P3: the folder repo_clone clones into (repos_root). */
  reposRoot?: () => string;
  /** SRV-P3: runs git for the clone (a test's fake; default: git). */
  gitRun?: GitRunner;
  /** SRV-P2: persona_create's and persona_update's checks and writes. */
  personas?: {
    checkCreate: (
      args: Record<string, unknown>,
      who?: HeldAsker,
    ) => PersonaHeldCheck;
    create: (args: Record<string, unknown>) => Promise<unknown>;
    checkUpdate: (
      args: Record<string, unknown>,
      who?: HeldAsker,
    ) => PersonaHeldCheck;
    update: (args: Record<string, unknown>) => Promise<unknown>;
  };
}

/**
 * Issue 208: held writes that always ask the person. No setting and no
 * approval policy lets one run without their own Allow: a Verify run on
 * a shared environment sends requests to an environment others use.
 * Each one's check also says personOnly, for today's auto-allow. Issue
 * 334: an app key hands a web app access to an agent, so making and
 * revoking one are the person's own too.
 */
export const CRITICAL_HELD_ACTIONS: ReadonlySet<string> = new Set([
  "verify_run",
  "embed_key_create",
  "embed_key_revoke",
  "gate_runner_token_create",
  "gate_box_set",
  "gate_box_remove",
  "host_restart",
  "test_person_setup",
  "web_url_set",
]);

/** SRV-P4: a held write agent-ops checks and runs. */
export interface HeldOp {
  check: (
    args: Record<string, unknown>,
    who?: HeldAsker,
  ) => HeldOpCheck<object>;
  run: (args: Record<string, unknown>, asked?: AskedBy) => Promise<unknown>;
}

/** The longest reason a restart may give (one line). */
export const RESTART_REASON_MAX = 300;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** A path as the person reads it: ~/… inside home. */
function shown(p: string, home: string): string {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? `~/${rel}`
    : rel === ""
      ? "~"
      : p;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A GitHub repo, owner/name. */
const GH_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** A runtime's conversation id (Claude Code: a uuid). */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A refusal from a dry run, with its question and choices when it asks. */
function draftError(r: RepoAddResult): string {
  return [
    r.error ?? "repo add can't add it",
    r.ask ? `Ask the person: ${r.ask}` : "",
    r.choices?.length ? `Choices: ${r.choices.join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

const CARRY_ON =
  "Agents and terminals carry on where they were; open pages reconnect.";

export function heldActions(d: HeldActionDeps): HeldActions {
  /**
   * D70: a workspace given by name ("back office") or slug, as its key; a
   * new one by the slug of what was typed. Undefined: none given.
   */
  const wsArg = (v: unknown): string | undefined => {
    const given = str(v);
    if (given === undefined) return undefined;
    const k = d.resolveWorkspace?.(given) ?? given;
    return NAME_RE.test(k) ? k : (workspaceSlug(k) ?? k);
  };
  const workspaceCreate: HeldAction = {
    check(a): HeldCheck {
      const name = str(a.name);
      const refusal = d.workspaceCreateRefusal(name);
      if (refusal || !name)
        return { ok: false, error: refusal ?? "name required" };
      return {
        ok: true,
        args: { name },
        summary: `create the project "${name}"`,
        params: { name },
        ...reviewLines([
          line(
            `A new, empty project named "${name}", made active so its services can start.`,
            "ap.det.workspace_create.new",
            { name },
          ),
        ]),
      };
    },
    async run(a) {
      const name = String(a.name);
      // D70: made under its slug; the name is what was typed.
      const slug = d.createWorkspace(name);
      d.activateWorkspace(slug);
      return { ok: true, name, slug, active: true };
    },
  };

  const repoAddHeld: HeldAction = {
    check(a): HeldCheck {
      const rules = d.rules();
      const where = checkOnboardPath(str(a.path), rules);
      if (!where.ok) return { ok: false, error: where.error };
      // D70: as typed; repo add takes a name or a slug, and makes a new one
      // under its slug with this as its name.
      const workspace = str(a.workspace);
      const opts = {
        name: str(a.name),
        run: str(a.run),
        down: str(a.down),
        health: str(a.health),
      };
      // Issue 277: a repo that runs nothing joins with no services.
      const noRun = a.no_run === true;
      const draft = repoAdd(
        {
          spec: where.dir,
          sidecar: false,
          json: true,
          dryRun: true,
          workspace,
          ...opts,
          ...(noRun ? { noRun } : {}),
        },
        d.validate,
        where.dir,
      );
      if (!draft.ok) return { ok: false, error: draftError(draft) };
      const ws =
        workspace !== undefined
          ? (wsArg(workspace) ?? workspace)
          : d.defaultWorkspace();
      const isNew = !d.workspaceExists(ws);
      const folder = shown(where.dir, rules.home);
      const details = [
        `Folder: ${folder} (your checkout; Den never changes the repo).`,
        `Project: ${ws}${isNew ? " (new)" : ""}.`,
        draft.manifest?.source === "repo"
          ? `Manifest: the repo's own (${path.basename(draft.manifest.file)}).`
          : `Manifest: a side-car Den writes in this distribution's manifests/ folder${draft.manifest?.file ? ` (${path.basename(draft.manifest.file)})` : ""}:`,
        ...(draft.draft
          ? draft.draft
              .replace(/\n$/, "")
              .split("\n")
              .map((l) => `  ${l}`)
          : []),
        draft.services?.length
          ? `Services: ${draft.services.join(", ")}.`
          : "Services: none. It runs nothing: nothing starts or is checked; agents can work in it.",
      ];
      return {
        ok: true,
        args: {
          path: where.dir,
          ...(workspace ? { workspace } : {}),
          ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v)),
          ...(noRun ? { no_run: true } : {}),
        },
        summary: `add the repo at ${folder} to project "${ws}"${isNew ? " (new)" : ""}`,
        params: {
          path: folder,
          workspace: ws,
          ...(isNew ? { isNew: "1" } : {}),
        },
        details,
      };
    },
    async run(a) {
      const dir = String(a.path);
      return repoAdd(
        {
          spec: dir,
          sidecar: false,
          json: true,
          workspace: str(a.workspace),
          name: str(a.name),
          run: str(a.run),
          ...(a.no_run === true ? { noRun: true } : {}),
          down: str(a.down),
          health: str(a.health),
        },
        d.validate,
        dir,
      );
    },
  };

  const serviceTry: HeldAction = {
    check(a, _who, o): HeldCheck {
      const service = str(a.service);
      if (!service)
        return { ok: false, error: "give service: <repo> or <repo>/<service>" };
      const workspace = wsArg(a.workspace);
      if (workspace !== undefined && !NAME_RE.test(workspace))
        return {
          ok: false,
          error: `project "${str(a.workspace)}" needs at least one letter or digit`,
        };
      if (workspace !== undefined && !d.workspaceExists(workspace))
        return { ok: false, error: `there is no project "${workspace}"` };
      const t = d.serviceTarget(service, workspace);
      if (!t.ok) return { ok: false, error: t.error };
      // Issue 362: the Allow is for the command the dialog shows. Its
      // fingerprint rides in the request; the check again before the run
      // refuses a command that changed while it waited.
      const up = createHash("sha256")
        .update(`${t.address}\n${t.command ?? ""}`)
        .digest("hex")
        .slice(0, 32);
      // A request with no fingerprint at the Allow (asked before Den kept
      // it, or its args changed on the way) names no command: refused.
      if (o?.again && a.up === undefined)
        return {
          ok: false,
          error: `this request for ${t.address} doesn't say which "up" command it was asked for, so the Allow is not for one: ask again`,
        };
      if (a.up !== undefined && a.up !== up)
        return {
          ok: false,
          error: `the "up" command of ${t.address} changed after this was asked, so the Allow is not for it: ask again`,
        };
      const activates =
        workspace !== undefined && !d.workspaceActive(workspace);
      return {
        ok: true,
        args: {
          service: t.address,
          ...(workspace ? { workspace } : {}),
          up,
        },
        summary: `start ${t.address}${workspace ? ` in project "${workspace}"` : ""}${activates ? ` (this activates ${workspace})` : ""}`,
        params: {
          service: t.address,
          ...(workspace ? { workspace } : {}),
          ...(activates ? { activates: "1" } : {}),
        },
        ...reviewLines([
          ...(activates
            ? [
                line(
                  `Activates the project "${workspace}" first, so it can run.`,
                  "ap.det.service_try.activates",
                  { project: workspace! },
                ),
              ]
            : []),
          line(
            `Runs the service's local "up", as the Services page's Start does.`,
            "ap.det.service_try.up",
          ),
          ...(t.command
            ? [
                line(`Command: ${t.command}`, "ap.det.service_try.command", {
                  command: t.command,
                }),
              ]
            : []),
          line(
            `Den reports the exit code and the last lines of its output.`,
            "ap.det.service_try.reports",
          ),
        ]),
      };
    },
    async run(a) {
      const workspace = wsArg(a.workspace);
      if (workspace && !d.workspaceActive(workspace))
        d.activateWorkspace(workspace);
      return d.tryService(String(a.service), workspace);
    },
  };

  const denRestart: HeldAction = {
    check(a): HeldCheck {
      const reason = str(a.reason)?.replace(/\s+/g, " ");
      if (!reason) return { ok: false, error: "give reason (one line: why)" };
      if (reason.length > RESTART_REASON_MAX)
        return {
          ok: false,
          error: `reason is at most ${RESTART_REASON_MAX} characters`,
        };
      if (!d.restartDen)
        return { ok: false, error: "this Den can't restart itself" };
      return {
        ok: true,
        args: { reason },
        summary: `restart Den (${reason})`,
        params: { reason },
        ...reviewLines([
          line(
            "Den stops and starts again at the same address, on the version installed now.",
            "ap.det.den_restart.restart",
          ),
          line(CARRY_ON, "ap.det.den.carryOn"),
          line(
            "The agent that asked is told when Den is back.",
            "ap.det.den_restart.told",
          ),
        ]),
      };
    },
    async run(a, asked) {
      return d.restartDen!(String(a.reason), asked);
    },
  };

  const denUpdate: HeldAction = {
    check(a): HeldCheck {
      const reason = str(a.reason)?.replace(/\s+/g, " ");
      if (!reason) return { ok: false, error: "give reason (one line: why)" };
      if (reason.length > RESTART_REASON_MAX)
        return {
          ok: false,
          error: `reason is at most ${RESTART_REASON_MAX} characters`,
        };
      const version = str(a.version) ?? "latest";
      if (!UPDATE_SPEC_RE.test(version))
        return { ok: false, error: "version: latest, or one like 0.4.44" };
      if (!d.updateDen)
        return { ok: false, error: "this Den can't update itself" };
      return {
        ok: true,
        args: { version, reason },
        summary: `update Den to ${version} (${reason})`,
        params: { version, reason },
        ...reviewLines([
          version === "latest"
            ? line(
                "Den gets the latest version from npm for this distribution, checks it with doctor, and restarts on it.",
                "ap.det.den_update.latest",
              )
            : line(
                `Den gets version ${version} from npm for this distribution, checks it with doctor, and restarts on it.`,
                "ap.det.den_update.version",
                { version },
              ),
          line(
            "If the new version isn't up in time, Den rolls back by itself to the version it runs now, and says why.",
            "ap.det.den_update.rollback",
          ),
          line(CARRY_ON, "ap.det.den.carryOn"),
        ]),
      };
    },
    async run(a, asked) {
      return d.updateDen!(String(a.version), String(a.reason), asked);
    },
  };

  const agentCreate: HeldAction = {
    check(a, who): HeldCheck {
      if (!d.agentCreate)
        return { ok: false, error: "this Den can't start agents here" };
      const c = d.agentCreate.check(a, who);
      return c.ok ? { ...c, args: { ...c.args } } : c;
    },
    async run(a) {
      return d.agentCreate!.run(a);
    },
  };

  const noPersonas = {
    ok: false as const,
    error: "this Den can't change personas here",
  };
  const personaCreate: HeldAction = {
    check: (a, who): HeldCheck =>
      d.personas ? d.personas.checkCreate(a, who) : noPersonas,
    run: (a) => d.personas!.create(a),
  };
  const personaUpdate: HeldAction = {
    check: (a, who): HeldCheck =>
      d.personas ? d.personas.checkUpdate(a, who) : noPersonas,
    run: (a) => d.personas!.update(a),
  };

  const op = (o: HeldOp | undefined, missing: string): HeldAction => ({
    check(a, who): HeldCheck {
      if (!o) return { ok: false, error: missing };
      const c = o.check(a, who);
      return c.ok ? { ...c, args: { ...c.args } } : c;
    },
    run: (a, asked) => o!.run(a, asked),
  });
  const projectMode = op(
    d.projectMode,
    "this Den can't set a project's mode here",
  );
  const projectMcp = op(
    d.projectMcp,
    "this Den can't add a project's MCP servers here",
  );
  const projectMcpRemove = op(
    d.projectMcpRemove,
    "this Den can't remove a project's MCP servers here",
  );
  const projectMcpUpdate = op(
    d.projectMcpUpdate,
    "this Den can't change a project's MCP servers here",
  );
  const hubConnect = op(d.hubAddress, "this Den can't set Hub's address here");
  const hubCreate = op(d.hubCreate, "this Den can't ask Hub for projects here");
  const hubLink: HeldAction = {
    check: (a, who) =>
      d.hubLink
        ? d.hubLink.check(a, who)
        : { ok: false, error: "this Den can't link projects to Hub here" },
    run: (a, asked) => d.hubLink!.run(a, asked),
  };
  const agentFolder = op(d.agentFolder, "this Den can't move agents here");
  const agentMode = op(
    d.agentMode,
    "this Den can't change an agent's mode here",
  );
  const agentSandbox = op(
    d.agentSandbox,
    "this Den can't change an agent's sandbox here",
  );
  const settingChange = op(
    d.settingChange,
    "this Den can't change its settings here",
  );
  const gateSettings = op(
    d.gateSettings,
    "this Den can't change its gate settings here",
  );
  const verifyRun = op(d.verifyRun, "this Den can't run Verify here");
  const appKeyCreate = op(
    d.appKeys?.create,
    "this Den can't make app keys here",
  );
  const appKeyRevoke = op(
    d.appKeys?.revoke,
    "this Den can't revoke app keys here",
  );
  const pinCommit = op(d.pinCommit, "this Den can't commit its pin here");
  const sandboxOn = op(
    d.sandboxOn,
    "this Den can't turn the agent sandbox on here",
  );
  const gateRunnerToken = op(
    d.gateRunnerToken,
    "this Den can't make gate runner tokens here",
  );
  const gateBoxSet = op(d.gateBoxSet, "this Den can't set test boxes here");
  const gateBoxRemove = op(
    d.gateBoxRemove,
    "this Den can't remove test boxes here",
  );
  const terminalHostRestart = op(
    d.terminalHostRestart,
    "this Den can't restart its terminal host here",
  );

  const repoClone: HeldAction = {
    check(a, who): HeldCheck {
      if (!d.reposRoot)
        return { ok: false, error: "this Den can't clone repos here" };
      if (who?.project && !isServerScope(who.project))
        return {
          ok: false,
          error: `the repos folder is shared by every project: Den's own agent or a person asks to clone into it, not ${who.agent ?? "a project's agent"}`,
        };
      const t = cloneTarget(
        {
          source: str(a.source) ?? "",
          name: str(a.name),
          branch: str(a.branch),
        },
        d.reposRoot(),
      );
      if (!t.ok) return t;
      return {
        ok: true,
        args: {
          source: str(a.source)!,
          ...(str(a.name) ? { name: str(a.name) } : {}),
          ...(t.branch ? { branch: t.branch } : {}),
        },
        summary: `clone ${t.shown} into ${t.dest}`,
        params: { source: t.shown, path: t.dest },
        ...reviewLines([
          t.branch
            ? line(
                `From: ${t.shown}, branch ${t.branch}.`,
                "ap.det.repo_clone.fromBranch",
                { source: t.shown, branch: t.branch },
              )
            : line(
                `From: ${t.shown}, its default branch.`,
                "ap.det.repo_clone.from",
                { source: t.shown },
              ),
          t.gh
            ? line(
                "With your gh login (a GitHub repo).",
                "ap.det.repo_clone.gh",
              )
            : line(
                "With git and your own credentials (not gh: it isn't GitHub).",
                "ap.det.repo_clone.git",
              ),
          line(
            `Into: ${t.dest} (a new folder; nothing there changes).`,
            "ap.det.repo_clone.into",
            { path: t.dest },
          ),
          line(
            "Then the agent drafts its manifest (manifest_draft) and asks to add it (repo_add): each asks you again.",
            "ap.det.repo_clone.then",
          ),
        ]),
      };
    },
    async run(a) {
      const t = cloneTarget(
        {
          source: String(a.source),
          name: str(a.name),
          branch: str(a.branch),
        },
        d.reposRoot!(),
      );
      if (!t.ok) return t;
      const out = await runClone(t, d.gitRun);
      return out.ok
        ? {
            ...out,
            next: `Cloned. Draft its manifest with manifest_draft { path: "${out.path}" }, then ask to add it with repo_add.`,
          }
        : out;
    },
  };

  const agentImport: HeldAction = {
    check(a, who): HeldCheck {
      if (!d.agentImport)
        return {
          ok: false,
          error: "this Den can't bring in conversations here",
        };
      const project = wsArg(a.project ?? a.workspace) ?? who?.project;
      if (!project || !NAME_RE.test(project))
        return { ok: false, error: "name the project" };
      if (
        who?.project &&
        !isServerScope(who.project) &&
        project !== who.project
      )
        return {
          ok: false,
          error: `a project's agent brings conversations into its own project (${who.project}), not ${project}`,
        };
      if (!d.workspaceExists(project))
        return { ok: false, error: `there is no project "${project}"` };
      const session = str(a.session);
      if (!session || !SESSION_RE.test(session))
        return { ok: false, error: "`session` must be a conversation id" };
      const persona = str(a.persona);
      if (!persona || !NAME_RE.test(persona))
        return { ok: false, error: "name the persona to run it as" };
      const runtime = str(a.runtime);
      if (runtime !== undefined && !NAME_RE.test(runtime))
        return { ok: false, error: "runtime must be a runtime id" };
      const off = d.agentImportSandbox?.(persona) ?? null;
      return {
        ok: true,
        ...(off ? { personOnly: true } : {}),
        args: {
          project,
          session,
          persona,
          ...(runtime ? { runtime } : {}),
          ...(off ? { sandboxOff: true } : {}),
        },
        summary: `bring in conversation ${session} as a ${persona} agent of project "${project}"`,
        params: { session, persona, project },
        ...reviewLines([
          runtime
            ? line(
                `Project: ${project}. Persona: ${persona}. Runtime: ${runtime}.`,
                "ap.det.agent_import.whatRuntime",
                { project, persona, runtime },
              )
            : line(
                `Project: ${project}. Persona: ${persona}.`,
                "ap.det.agent_import.what",
                { project, persona },
              ),
          line(
            "The conversation goes on as a Den agent, in the folder it ran in, under Den's token, hooks and guards.",
            "ap.det.agent_import.goesOn",
          ),
          line(
            "Refused if it is still open in another terminal, or an agent already continues it.",
            "ap.det.agent_import.refused",
          ),
          ...(off ? [off] : []),
        ]),
      };
    },
    async run(a) {
      return d.agentImport!({
        project: String(a.project),
        session: String(a.session),
        persona: String(a.persona),
        ...(str(a.runtime) ? { runtime: str(a.runtime) } : {}),
        ...(a.sandboxOff === true ? { sandboxOff: true } : {}),
      });
    },
  };

  const approvalPolicy: HeldAction = {
    check(a, who): HeldCheck {
      if (!d.approvalPolicy)
        return {
          ok: false,
          error: "this Den can't change the approval policy here",
        };
      const project = wsArg(a.project);
      if (project !== undefined) {
        if (!NAME_RE.test(project) || !d.workspaceExists(project))
          return { ok: false, error: `there is no project "${project}"` };
        if (
          who?.project &&
          !isServerScope(who.project) &&
          project !== who.project
        )
          return {
            ok: false,
            error: `a project's agent asks about its own project (${who.project}), not ${project}`,
          };
      } else if (who?.project && !isServerScope(who.project))
        return {
          ok: false,
          error:
            "the install's policy is every project's: Den's own agent or a person asks to change it; name your project to change its own",
        };
      const raw = a.approvals;
      if (raw !== null && (typeof raw !== "object" || Array.isArray(raw)))
        return {
          ok: false,
          error:
            "approvals: { policy, writes, watch, critical }, or null to clear it",
        };
      let next: PolicySetting | undefined;
      try {
        next =
          raw === null
            ? undefined
            : readPolicySetting(
                raw,
                project ? `${project}.approvals` : "approvals",
              );
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const where = project ? `project ${project}'s` : "the install's";
      const shown = next ? JSON.stringify(next) : "none";
      let now = "none";
      try {
        const cur = d.approvalPolicy.read(project);
        if (cur) now = JSON.stringify(cur);
      } catch {
        /* shown as none */
      }
      return {
        ok: true,
        args: {
          ...(project ? { project } : {}),
          approvals: next ? { ...next } : null,
        },
        summary: `change ${where} approval policy to ${shown}`,
        params: project
          ? { inProject: "1", where: project, to: shown }
          : { to: shown },
        ...reviewLines([
          now === "none"
            ? line("Now: none.", "ap.det.approval_policy.nowNone")
            : line(`Now: ${now}.`, "ap.det.approval_policy.now", { v: now }),
          next
            ? line(`Then: ${shown}.`, "ap.det.approval_policy.then", {
                v: shown,
              })
            : line("Then: none.", "ap.det.approval_policy.thenNone"),
          line(
            "Only a person changes the approval policy without an Allow: an agent always asks.",
            "ap.det.approval_policy.person",
          ),
        ]),
        personOnly: true,
      };
    },
    async run(a) {
      const project = str(a.project);
      const next =
        a.approvals && typeof a.approvals === "object"
          ? (a.approvals as Record<string, unknown>)
          : undefined;
      d.approvalPolicy!.write(project, next);
      return {
        ok: true,
        ...(project ? { project } : {}),
        approvals: next ?? null,
      };
    },
  };

  const prClose: HeldAction = {
    check(a, who): HeldCheck {
      if (!d.prClose)
        return { ok: false, error: "this Den can't close pull requests here" };
      const project = wsArg(a.project) ?? who?.project;
      if (project !== undefined) {
        if (!NAME_RE.test(project) || !d.workspaceExists(project))
          return { ok: false, error: `there is no project "${project}"` };
        if (
          who?.project &&
          !isServerScope(who.project) &&
          project !== who.project
        )
          return {
            ok: false,
            error: `a project's agent closes pull requests for its own project (${who.project}), not ${project}`,
          };
      }
      const repo = str(a.repo);
      if (!repo || !GH_REPO_RE.test(repo))
        return { ok: false, error: "repo: a GitHub repo, owner/name" };
      const pr =
        typeof a.pr === "number"
          ? a.pr
          : typeof a.pr === "string" && /^\d+$/.test(a.pr.trim())
            ? Number(a.pr.trim())
            : NaN;
      if (!Number.isSafeInteger(pr) || pr < 1)
        return { ok: false, error: "pr: the pull request number" };
      const comment = str(a.comment);
      if (!comment)
        return {
          ok: false,
          error:
            "comment: why it closes, posted on the pull request (the Hub note: stale, or superseded by which)",
        };
      const prNo = String(pr);
      return {
        ok: true,
        args: { ...(project ? { project } : {}), repo, pr, comment },
        summary: `close pull request ${pr} on ${repo}: ${comment}`,
        params: { repo, pr: String(pr), comment },
        ...reviewLines([
          line(
            `Repo: ${repo}. Pull request: ${prNo}.`,
            "ap.det.pr_close.what",
            {
              repo,
              pr: prNo,
            },
          ),
          line(
            `Den closes it with this comment: ${comment}`,
            "ap.det.pr_close.comment",
            { comment },
          ),
          line(
            "Nothing is merged and no branch is deleted.",
            "ap.det.pr_close.nothing",
          ),
        ]),
      };
    },
    async run(a) {
      return d.prClose!({
        repo: String(a.repo),
        pr: Number(a.pr),
        comment: String(a.comment),
      });
    },
  };

  return {
    workspace_create: workspaceCreate,
    repo_add: repoAddHeld,
    service_try: serviceTry,
    den_restart: denRestart,
    den_update: denUpdate,
    agent_create: agentCreate,
    persona_create: personaCreate,
    persona_update: personaUpdate,
    repo_clone: repoClone,
    project_mode: projectMode,
    project_mcp_add: projectMcp,
    project_mcp_remove: projectMcpRemove,
    project_mcp_update: projectMcpUpdate,
    hub_connect: hubConnect,
    hub_project_create: hubCreate,
    hub_link: hubLink,
    agent_folder: agentFolder,
    agent_mode: agentMode,
    agent_sandbox_set: agentSandbox,
    setting_change: settingChange,
    verify_run: verifyRun,
    agent_import: agentImport,
    approval_policy: approvalPolicy,
    pr_close: prClose,
    report: d.report ?? {
      check: () => ({ ok: false, error: "this Den can't file reports here" }),
      run: async () => ({
        ok: false,
        error: "this Den can't file reports here",
      }),
    },
    den_pin_commit: pinCommit,
    den_sandbox_on: sandboxOn,
    embed_key_create: appKeyCreate,
    embed_key_revoke: appKeyRevoke,
    gate_runner_token_create: gateRunnerToken,
    gate_box_set: gateBoxSet,
    gate_settings_set: gateSettings,
    gate_box_remove: gateBoxRemove,
    host_restart: terminalHostRestart,
    test_person_setup: d.testPersonSetup ?? {
      check: () => ({
        ok: false,
        error: "this Den can't set up test installs here",
      }),
      run: async () => ({
        ok: false,
        error: "this Den can't set up test installs here",
      }),
    },
    web_url_set: d.webUrlSet ?? {
      check: () => ({
        ok: false,
        error: "this Den can't set its address here",
      }),
      run: () =>
        Promise.resolve({
          ok: false,
          error: "this Den can't set its address here",
        }),
    },
  };
}
